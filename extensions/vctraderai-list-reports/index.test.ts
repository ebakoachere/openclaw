import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { LIST_REPORTS_TOOL_NAME, runListReports } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-reports", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.PFM_AGENT_TOKEN;
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
    if (originalToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalToken;
    }
  });

  it("registers list_reports", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-reports" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: LIST_REPORTS_TOOL_NAME });
    // The platform allowlist and the closed-world gate both match on this exact
    // string; a rename here silently darkens the tool.
    expect(LIST_REPORTS_TOOL_NAME).toBe("list_reports");
  });

  it("reads the workspace-scoped report list with the owner bearer", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { reports: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runListReports(
      { limit: 25, cursor: "abc", template: "session_summary", author_key: "gold_specialist" },
      { fetchImpl, threadId: "thread-42" },
    );

    expect(request?.method).toBe("GET");
    const url = new URL(request?.url ?? "");
    expect(url.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports`);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.get("template")).toBe("session_summary");
    expect(url.searchParams.get("author_key")).toBe("gold_specialist");
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    // The write routes resolve the authoring specialist from this header, and
    // the reads share the door, so it is stamped on every call.
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
  });

  it("omits include_archived unless it was explicitly asked for", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ data: { reports: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runListReports({ include_archived: false }, { fetchImpl });
    expect(new URL(urls[0] ?? "").searchParams.has("include_archived")).toBe(false);

    await runListReports({ include_archived: true }, { fetchImpl });
    expect(new URL(urls[1] ?? "").searchParams.get("include_archived")).toBe("true");
  });
});
