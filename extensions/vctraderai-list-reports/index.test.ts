import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { buildListQuery, runListReports, LIST_REPORTS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-reports", () => {
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

  it("registers the list_reports tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-reports" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_REPORTS_TOOL_NAME,
      label: "List Reports",
    });
  });

  it("gets the workspace-scoped reports path with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: { reports: [], synthetic: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await runListReports({ limit: 5 }, { fetchImpl });

    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports`);
    expect(new URL(capturedUrl).searchParams.get("limit")).toBe("5");
    expect(capturedMethod).toBe("GET");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    // An empty list is a REAL answer, not an error: the workspace genuinely has
    // no reports until something publishes one.
    expect(result).toEqual({ data: { reports: [], synthetic: false } });
  });

  it("sends no query parameters at all when none were supplied", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runListReports({}, { fetchImpl });
    expect(new URL(capturedUrl).search).toBe("");
  });

  it("drops unset filters instead of sending the string 'undefined'", () => {
    const query = buildListQuery({ template: "session_summary" });
    expect(query.template).toBe("session_summary");
    // A filter sent as the literal "undefined" is one the BFF would try to match
    // and answer honestly-empty for -- a silent wrong answer, not an error.
    expect(query.author_key).toBeUndefined();
    expect(query.limit).toBeUndefined();
    expect(query.include_archived).toBeUndefined();
  });

  it("only sends include_archived when it was explicitly requested", () => {
    expect(buildListQuery({ include_archived: true }).include_archived).toBe("true");
    expect(buildListQuery({ include_archived: false }).include_archived).toBeUndefined();
  });

  it("passes the per-specialist author filter through", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runListReports({ author_kind: "specialist", author_key: "gold" }, { fetchImpl });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get("author_kind")).toBe("specialist");
    expect(params.get("author_key")).toBe("gold");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: { error: { code: "bad_cursor", message: "cursor is not decodable" } },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )) as typeof globalThis.fetch;

    await expect(runListReports({ cursor: "nope" }, { fetchImpl })).rejects.toThrow(
      /bad_cursor.*cursor is not decodable/s,
    );
  });

  it("fails loudly when the workspace id is not injected", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(runListReports({}, {})).rejects.toThrow(/PFM_WORKSPACE_ID is not set/);
  });
});
