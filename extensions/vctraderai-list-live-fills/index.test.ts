import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListLiveFills, LIST_LIVE_FILLS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

type CapturedToolShape = {
  description: string;
  parameters: {
    properties: Record<string, { minimum?: number; maximum?: number; description?: string }>;
  };
};

function describedTool(): CapturedToolShape {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-fills" });
  plugin.register(captured.api);
  return captured.tools[0] as unknown as CapturedToolShape;
}

describe("vctraderai-list-live-fills", () => {
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

  it("registers the list_live_fills tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-fills" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_LIVE_FILLS_TOOL_NAME,
      label: "List Live Fills",
    });
  });

  // WAS FALSE: the schema exposed `cursor` as an "Opaque pagination cursor."
  // Pagination does not exist. The route accepts `cursor` and forwards it to
  // build_fills, which never reads it and hard-codes next_cursor=None; no
  // repository implementation (Protocol, InMemory, Db, Alpaca, ProviderAware)
  // even takes a cursor parameter. Measured: four distinct cursor values
  // (null, "abc", a base64 blob, "2") all returned the identical first page.
  // The old suite was green because it only asserted the URL path and the
  // bearer — it passed cursor: "cursor-x" and never checked what came back, so
  // an inert parameter looked exactly like a working one.
  it("does not advertise a pagination cursor the API cannot honour", () => {
    const { parameters } = describedTool();
    expect(Object.keys(parameters.properties)).not.toContain("cursor");
  });

  it("warns that the result is one page and may be silently truncated", () => {
    const { description } = describedTool();
    expect(description).toContain("there is no pagination");
    expect(description).toContain("next_cursor is always null");
    expect(description).toMatch(/indistinguishable from the complete history/);
  });

  // WAS FALSE: the schema advertised `maximum: 500`. GET /live/fills binds limit
  // as Query(ge=1, le=svc.MAX_FILLS_LIMIT) with MAX_FILLS_LIMIT = 200, so every
  // value in 201..500 is rejected with HTTP 422 ("Input should be less than or
  // equal to 200") before the handler runs. Measured against the real router:
  // 1/50/200 -> 200, 201/250/500 -> 422.
  it("caps limit at the route's real ceiling of 200", () => {
    const { parameters } = describedTool();
    expect(parameters.properties.limit.maximum).toBe(200);
    expect(parameters.properties.limit.minimum).toBe(1);
    expect(parameters.properties.limit.description).toContain("HTTP 422");
  });

  it("names where an account_id comes from", () => {
    const { parameters } = describedTool();
    expect(parameters.properties.account_id.description).toContain(
      "list_live_accounts_for_deployment",
    );
    expect(parameters.properties.account_id.description).toContain("rows[].live_account_id");
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
    await runListLiveFills({ account_id: "account_id-x", limit: 1 }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/fills`);
    const query = new URL(capturedUrl).searchParams;
    expect(query.get("account_id")).toBe("account_id-x");
    expect(query.get("limit")).toBe("1");
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListLiveFills({ account_id: "account_id-x", limit: 1 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
