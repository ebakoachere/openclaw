import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { GET_REPORT_TOOL_NAME, runGetReport } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const REPORT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("vctraderai-get-report", () => {
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

  it("registers get_report", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: GET_REPORT_TOOL_NAME });
    // The platform allowlist and the closed-world gate both match on this exact
    // string; a rename here silently darkens the tool.
    expect(GET_REPORT_TOOL_NAME).toBe("get_report");
  });

  it("reads one report through the workspace-scoped detail route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { id: REPORT_ID, body: { blocks: [] } } }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await runGetReport({ report_id: REPORT_ID }, { fetchImpl, threadId: "thread-42" });

    expect(request?.method).toBe("GET");
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/${REPORT_ID}`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
  });

  it("normalises an uppercased uuid instead of tripping its own egress guard", async () => {
    // The allowlist regex admits lowercase hex only, so an uppercased echo of a
    // real id would fail as an opaque BffEgressViolation rather than working.
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runGetReport({ report_id: REPORT_ID.toUpperCase() }, { fetchImpl });

    expect(new URL(urls[0] ?? "").pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/${REPORT_ID}`,
    );
  });

  it("refuses an id that is not a report uuid before opening a request", async () => {
    await expect(runGetReport({ report_id: "latest" })).rejects.toThrow("report UUID");
  });
});
