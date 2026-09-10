import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentClosePosition, AGENT_CLOSE_POSITION_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-close-position", () => {
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

  it("registers the agent_close_position tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-close-position" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_CLOSE_POSITION_TOOL_NAME,
      label: "Agent Close Position",
    });
  });

  it("posts to the workspace-scoped agent-close path with the owner bearer + body", async () => {
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
    const result = await runAgentClosePosition(
      { account_id: "acct-1", position_id: "pos-9" },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/live/positions/pos-9/agent-close`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({ account_id: "acct-1" });
    expect(result).toEqual({ accepted_queued: true });
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runAgentClosePosition({ account_id: "acct-1", position_id: "pos-9" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  // ---------------------------------------------------------------------------
  // W19 LIVE-CLOSE (platform PR #1864): the description is the belief.
  //
  // This tool's description has now been wrong in TWO opposite directions, which
  // is why it is pinned rather than trusted.
  //
  // Until 2026-08-22 it told the model a locked window "downgrades to a staged
  // card the owner approves". No card existed, so during a halt -- exactly when
  // de-risking matters -- the model would tell the owner the close was pending
  // and stand down. That was corrected to "NOTHING is staged for approval",
  // which was true.
  //
  // But the same correction also told the model, in capitals, that a close does
  // not go through unless the account is set to act autonomously, and to "never
  // say the action is staged, pending approval or awaiting a card". On
  // 2026-09-09 the founder could not close a filled XAUUSD position for exactly
  // that reason: an ENTRY lock was being applied to an EXIT. The founder's
  // ruling and PR #1864 changed the platform -- a close is de-risking and
  // executes in Manual mode -- so this description had to change with it, or the
  // model would refuse on the platform's behalf.
  //
  // What is pinned below is the CURRENT truth and the shape of both past errors.
  it("tells the model a close executes in manual mode, and is broker-confirmed", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-close-position" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    // Non-vacuity: assert we are looking at a real description before asserting
    // what it does not contain. `not.toMatch` on an empty string passes.
    expect(description.length).toBeGreaterThan(80);

    // The 2026-09-09 error: do not teach that the mode blocks an exit.
    expect(description).toMatch(/DE-RISKING/);
    expect(description).toMatch(/does NOT require the account to be set to act autonomously/);
    expect(description).not.toMatch(/NOTHING is staged for approval/);

    // The 2026-08-22 error: still never promise a card on this surface.
    expect(description).not.toMatch(/staged card/i);
    expect(description).not.toMatch(/awaiting approval/i);

    // What must be true instead.
    expect(description).toMatch(/reduce-only/i);
    expect(description).toMatch(/ONLY AFTER THE BROKER CONFIRMS IT/);
    expect(description).toMatch(/lock_reason/);
    expect(description).toMatch(/'refused'/);
    // The four ways the position cannot be confirmed open, so "flat" is never
    // the model's default reading of a refusal.
    expect(description).toMatch(/position_not_open/);
    expect(description).toMatch(/position_book_unreadable/);
    expect(description).toMatch(/position_book_not_visible/);
    expect(description).toMatch(/position_book_stale/);
  });
});
