import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentCancelOrder, AGENT_CANCEL_ORDER_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-cancel-order", () => {
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

  it("registers the agent_cancel_order tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-cancel-order" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_CANCEL_ORDER_TOOL_NAME,
      label: "Agent Cancel Order",
    });
  });

  it("posts to the workspace-scoped agent-cancel path with the owner bearer + body", async () => {
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
      return new Response(JSON.stringify({ downgraded_to_staged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const result = await runAgentCancelOrder(
      { account_id: "acct-1", order_id: "ord-7" },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/live/orders/ord-7/agent-cancel`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({ account_id: "acct-1" });
    expect(result).toEqual({ downgraded_to_staged: true });
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runAgentCancelOrder({ account_id: "acct-1", order_id: "ord-7" }, { fetchImpl }),
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
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-cancel-order" });
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
