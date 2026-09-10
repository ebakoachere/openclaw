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

  // W15 LANE QTY. The platform sizes an order from the account's Risk Settings
  // page when the body carries NO qty key, and REFUSES a body that asks for both
  // an explicit qty and risk-budget sizing. So "absent" has to mean absent: not
  // null, and not accompanied by a `size` field of our own invention.
  it("OMITS qty entirely when it is not supplied, so the platform sizes from the account's risk budget", async () => {
    let capturedBody: any = undefined;
    let capturedRaw = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedRaw = typeof init?.body === "string" ? init.body : "";
      capturedBody = capturedRaw ? JSON.parse(capturedRaw) : undefined;
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        stop_loss: 1900.5,
        intended_price: 1925.0,
      },
      { fetchImpl },
    );
    expect(capturedBody).toEqual({
      account_id: "acct-1",
      symbol: "XAU_USD",
      side: "buy",
      stop_loss: 1900.5,
      intended_price: 1925.0,
    });
    expect("qty" in capturedBody).toBe(false);
    // A serialised null would be a DIFFERENT request than an absent key, and the
    // key never appears in the wire bytes either.
    expect(capturedRaw).not.toContain("qty");
    // We must not invent `size: "risk_budget"`: sending it alongside a qty is a
    // refusal, and omission already means the same thing.
    expect("size" in capturedBody).toBe(false);
  });

  it("still forwards qty untouched when the caller supplies one", async () => {
    let capturedBody: any = undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ accepted_queued: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentPlaceOrder(
      {
        account_id: "acct-1",
        symbol: "XAU_USD",
        side: "buy",
        qty: "0.10",
        stop_loss: 1900.5,
        intended_price: 1925.0,
      },
      { fetchImpl },
    );
    expect(capturedBody.qty).toBe("0.10");
  });

  it("declares qty OPTIONAL in the tool schema, with the mandatory fields still required", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-place-order" });
    plugin.register(captured.api);
    const schema: any = (captured.tools[0] as any).parameters;
    const required: string[] = schema?.required ?? [];
    // Controls: the fields that MUST stay required, so an empty/renamed
    // `required` array cannot make this test pass by accident.
    expect(required).toContain("account_id");
    expect(required).toContain("intended_price");
    expect(required).not.toContain("qty");
    // stop_loss is optional BY DESIGN on this lineage: a stopless notional order is legal.
    expect(required).not.toContain("stop_loss");
    expect(schema?.properties?.qty).toBeDefined();
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
  // W19 LIVE-CLOSE (platform PR #1864): a locked PLACE really does produce a
  // card now, and the description has to stop denying it.
  //
  // The history matters, because this description has been wrong in both
  // directions. Until 2026-08-22 it told the model a locked window "downgrades
  // to a staged card the owner approves" -- and no card existed, so the model
  // told owners an order was pending when nothing was. That was corrected to
  // "There is no card, no queue entry and no pending approval anywhere ... Never
  // say the action is staged, pending approval or awaiting a card", which was
  // true when written.
  //
  // Then Task 18 added the staging arm: a stage-eligible lock (mode_manual /
  // consent_disabled) mints a REAL openclaw.staged_actions row and returns
  // execution_status 'staged_for_approval' with its id. The description was not
  // updated, so the model was left under standing instructions to deny a card
  // that now existed. On 2026-09-09 the founder's XAUUSD order was sitting on
  // his approval card and was relayed to him as a flat refusal; he approved it
  // by hand and it filled.
  //
  // Both errors have the same shape -- the description outliving the platform --
  // so what is pinned is the current truth AND the wording of each past error.
  it("tells the model a locked place is a CARD, and what a real refusal looks like", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-place-order" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    // Non-vacuity: assert we are looking at a real description before asserting
    // what it does not contain. `not.toMatch` on an empty string passes.
    expect(description.length).toBeGreaterThan(80);

    // The 2026-09-09 error, in its own words: never restore these.
    expect(description).not.toMatch(/NOTHING is staged for approval/);
    expect(description).not.toMatch(/no pending approval anywhere/i);
    expect(description).not.toMatch(/Never say the action is staged/i);

    // The truth the model needs in order to tell the owner something useful.
    expect(description).toMatch(/STAGED AS AN APPROVAL CARD, NOT REFUSED/);
    expect(description).toMatch(/staged_for_approval/);
    expect(description).toMatch(/staged_action_id/);
    expect(description).toMatch(/get_staged_action/);
    // The 2026-08-22 error was real too: a card must never be read as a fill.
    expect(description).toMatch(/applied means the owner approved it/);
    expect(description).toMatch(/NOT yet a fill/);
    expect(description).toMatch(/get_order_outcome/);
    // A genuine refusal is still a distinct answer, and still says so.
    expect(description).toMatch(/'refused'/);
    expect(description).toMatch(/lock_reason/);
    expect(description).toMatch(/Do NOT re-place/);
  });
});
