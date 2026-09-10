import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runGetStagedAction, GET_STAGED_ACTION_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const CARD_ID = "44444444-4444-4444-8444-444444444444";

describe("vctraderai-get-staged-action", () => {
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

  it("registers the get_staged_action tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-staged-action" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_STAGED_ACTION_TOOL_NAME,
      label: "Get Staged Action",
    });
  });

  it("calls the workspace-scoped read with the owner bearer and the card id", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: { found: true, status: "proposed" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runGetStagedAction({ staged_action_id: CARD_ID }, { fetchImpl });

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/staged-action`);
    expect(url.searchParams.get("staged_action_id")).toBe(CARD_ID);
    expect(capturedAuth).toBe("Bearer agent-token-001");
    // The workspace is NEVER a tool argument -- it comes from the environment
    // and rides in the PATH, so a caller cannot read another workspace's card.
    expect(url.searchParams.get("workspace_id")).toBeNull();
  });

  it("returns the BFF envelope VERBATIM", async () => {
    // The deployed plugins forward the raw body; this one must not start
    // filtering fields. `target_decision_id` in particular is what stops
    // `applied` being read as `filled`, and a field this layer drops is a fact
    // the model never learns exists.
    const body = {
      data: {
        found: true,
        status: "applied",
        applied_at: "2026-09-09T19:41:40+00:00",
        target_decision_id: "55555555-5555-4555-8555-555555555555",
        params: { symbol: "XAU_USD", side: "SELL" },
      },
      trace_id: "trace-1",
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const result = await runGetStagedAction({ staged_action_id: CARD_ID }, { fetchImpl });
    expect(result).toEqual(body);
  });

  it("refuses an empty card id before a socket opens", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(runGetStagedAction({ staged_action_id: "   " }, { fetchImpl })).rejects.toThrow(
      /staged_action_id is required/,
    );
    expect(called).toBe(false);
  });

  it("forwards the per-turn thread id as the openclaw thread header", async () => {
    let capturedThread: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThread = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runGetStagedAction({ staged_action_id: CARD_ID }, { fetchImpl, threadId: "thread-9" });
    expect(capturedThread).toBe("thread-9");
  });

  it("throws a named error when the workspace id is not configured", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(runGetStagedAction({ staged_action_id: CARD_ID })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });

  it("the tool description says applied is not filled", () => {
    // The belief that reaches the model lives HERE, not in the platform code:
    // a tool description reaches a live agent only through a bake. An agent
    // that reads `applied` and stops has simply relocated the original lie.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-staged-action" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description).toContain("APPLIED DOES NOT MEAN FILLED");
    expect(description).toContain("get_order_outcome");
    expect(description).toContain("found false");
  });
});
