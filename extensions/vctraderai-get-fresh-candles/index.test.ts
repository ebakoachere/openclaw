import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runGetFreshCandles, GET_FRESH_CANDLES_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-fresh-candles", () => {
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

  it("registers the get_fresh_candles tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-fresh-candles" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_FRESH_CANDLES_TOOL_NAME,
      label: "Get Fresh Candles",
    });
  });

  it("sends the model to source/age_seconds instead of promising a fresh fetch", () => {
    // THE HONESTY PIN. `/live/candles` serves a set from ONE OF THREE places --
    // a broker fetch, this process's short-lived cache, or the node's warm
    // session feed -- and the envelope says which, via `source` and
    // `age_seconds`. The description used to promise the broker every time, so
    // a cached set would be read out to the user as live. The tool NAME still
    // says "fresh" (it is a cross-repo contract), which is exactly why the
    // description has to point elsewhere, and why that is pinned here.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-fresh-candles" });
    plugin.register(captured.api);
    const description = captured.tools[0]?.description ?? "";
    expect(description).not.toMatch(/directly from the live broker/i);
    expect(description).toContain("source");
    expect(description).toContain("age_seconds");
  });

  it("calls the workspace-scoped read with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runGetFreshCandles(
      { account_id: "account_id-x", symbol: "EURUSD", timeframe: "1h", limit: 100 },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/candles`);
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runGetFreshCandles({ account_id: "account_id-x", symbol: "EURUSD" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
