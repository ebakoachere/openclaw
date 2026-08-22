import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListMyAccounts, LIST_MY_ACCOUNTS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-my-accounts", () => {
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

  it("registers the list_my_accounts tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-my-accounts" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_MY_ACCOUNTS_TOOL_NAME,
      label: "List My Accounts",
    });
  });

  // These tests used to pass purpose: "purpose-x". The platform refuses any
  // value outside {personal_journaling, live_bot}
  // (engine/agent/tools/live_tools.py:418), so the test was exercising a call
  // the server would reject — invisible here because a hand-built fetch stub
  // answers 200 to whatever it is handed. Use a real accepted value.
  it("calls the workspace-scoped read with the owner bearer, forwarding purpose verbatim", async () => {
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
    await runListMyAccounts({ limit: 1, purpose: "live_bot" }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/openclaw/live/my-accounts`,
    );
    // No client-side mapping exists: whatever the model supplies reaches the
    // server unchanged, which is why the description must carry the real enum.
    expect(new URL(capturedUrl).searchParams.get("purpose")).toBe("live_bot");
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  // The purpose description read "Optional purpose filter (e.g. live, personal)."
  // BOTH worked examples are refused by the code they describe: the server
  // compares against {"personal_journaling", "live_bot"} and returns
  // {"error": "purpose must be 'personal_journaling' or 'live_bot'."} inside a
  // 200 envelope, so a model following the examples sees a successful call with
  // zero accounts and can report that the user owns none. Verified by executing
  // the real list_my_accounts body: 'live' and 'personal' REFUSED, 'live_bot'
  // and 'personal_journaling' ACCEPTED. No test asserted the parameter docs, so
  // the suite stayed green over the lie.
  it("documents the only two purpose values the server accepts", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-my-accounts" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const purpose = tool.parameters?.properties?.purpose?.description ?? "";
    // Non-vacuity: fail loudly if the schema shape changed and we are asserting
    // against an empty string.
    expect(purpose.length).toBeGreaterThan(40);
    expect(purpose).toContain("personal_journaling");
    expect(purpose).toContain("live_bot");
    // The refuted examples must not come back.
    expect(purpose).not.toMatch(/e\.g\.\s*live,\s*personal/i);
    // And the model must be told the refusal is in-band, not an HTTP error.
    expect(purpose).toMatch(/data\.error/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListMyAccounts({ limit: 1, purpose: "live_bot" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
