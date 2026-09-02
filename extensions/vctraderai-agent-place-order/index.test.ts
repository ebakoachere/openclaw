import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentPlaceOrder, AGENT_PLACE_ORDER_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-place-order", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalAgentToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalAgentToken;
    }
  });

  it("registers the agent_place_order tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-place-order" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_PLACE_ORDER_TOOL_NAME,
      label: "Agent Place Order",
    });
  });

  it("posts to the workspace-scoped agent-place path with the owner bearer + mandatory-sl body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedAuth = new Headers(init?.headers).get("authorization");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ accepted_queued: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const result = await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900.5,
        intended_price: 1925.0,
        take_profit: 1950.0,
        client_order_id: "coid-1",
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/live/orders/agent-place`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      symbol: "XAU_USD",
      side: "buy",
      qty: "0.10",
      stop_loss: 1900.5,
      intended_price: 1925.0,
      take_profit: 1950.0,
      client_order_id: "coid-1",
    });
    expect(result).toEqual({ accepted_queued: true });
  });

  it("omits take_profit / client_order_id from the body when undefined", async () => {
    let capturedBody: any = undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ downgraded_to_staged: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "sell",
        qty: 1,
        stop_loss: 1950,
        intended_price: 1925,
      },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      symbol: "XAU_USD",
      side: "sell",
      qty: 1,
      stop_loss: 1950,
      intended_price: 1925,
    });
    expect("take_profit" in capturedBody).toBe(false);
    expect("client_order_id" in capturedBody).toBe(false);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900,
        intended_price: 1925,
      },
      { fetchImpl, threadId: "thread-specialist-7" },
    );
    expect(capturedThreadHeader).toBe("thread-specialist-7");
  });

  it("omits X-OpenClaw-Thread when no thread id is supplied", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900,
        intended_price: 1925,
      },
      { fetchImpl },
    );
    expect(hasThreadHeader).toBe(false);
  });

  it("keeps an unscoped execute callback fail-closed at the BFF", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(
        JSON.stringify({ detail: { code: "openclaw_execute_requires_thread_scope" } }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    await expect(
      runAgentPlaceOrder(
        {
          account_id: "acct-1",
          symbol: "XAU_USD",
          side: "buy",
          qty: "0.10",
          stop_loss: 1900,
          intended_price: 1925,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ detail: { code: "bff_403", status: 403 } });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runAgentPlaceOrder(
        {
          account_id: "acct-1",
          symbol: "XAU_USD",
          side: "buy",
          qty: "0.10",
          stop_loss: 1900,
          intended_price: 1925,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  // ---------------------------------------------------------------------------
  // The LOCKED arm does not stage anything, and the description must say so.
  //
  // Measured in propfirm_manager, not recalled: ALLOWLIST has this tool as
  // kind=ToolKind.EXECUTE with staged_action=None, and POST /api/v1/openclaw/stage
  // refuses anything that is not PROPOSE_ONLY with a non-None staged_action
  // (403 openclaw_tool_not_propose_only, web_api/openclaw_internal/router.py:994).
  // The LOCKED arm returns AgentExecuteOutcome(downgraded_to_staged=True,
  // status=STATUS_DOWNGRADED) and writes NO row. The platform's own route comment
  // says it plainly: "on LOCKED it DOWNGRADES (notify-only -- place has no
  // Appliable staged-card)".
  //
  // The field is called downgraded_to_staged, which is where the belief came from.
  // Until 2026-08-22 the description told the model the action "downgrades to a
  // staged card the owner approves", so on a locked window -- during a halt, which
  // is exactly when de-risking matters -- the model would tell the owner the action
  // was staged and awaiting approval, and stand down. No card existed. Nothing was
  // pending. The action simply did not happen.
  it("never tells the model a locked window produces a card to approve", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-place-order" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    // Non-vacuity: assert we are looking at a real description before asserting
    // what it does not contain. `not.toMatch` on an empty string passes.
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/staged card/i);
    expect(description).not.toMatch(/downgrade to a staged/i);
    // And it must say what IS true, so the model has something to tell the owner.
    expect(description).toMatch(/NOTHING is staged for approval/);
    expect(description).toMatch(/lock_reason/);
  });
});
