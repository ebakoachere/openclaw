import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { RETRACT_REPORT_TOOL_NAME, runRetractReport } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const REPORT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("vctraderai-retract-report", () => {
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

  it("registers retract_report", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-retract-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: RETRACT_REPORT_TOOL_NAME });
    expect(RETRACT_REPORT_TOOL_NAME).toBe("retract_report");
  });

  it("posts only the reason to the retract route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { retracted: true } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runRetractReport(
      { report_id: REPORT_ID, reason: "  The equity series was stale.  " },
      { fetchImpl, threadId: "thread-42" },
    );

    expect(request?.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/${REPORT_ID}/retract`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
    // report_id travels in the PATH; the body is the reason and nothing else.
    await expect(request?.json()).resolves.toEqual({ reason: "The equity series was stale." });
  });

  it("refuses a blank reason - a silent retraction looks like data loss", async () => {
    await expect(runRetractReport({ report_id: REPORT_ID, reason: "   " })).rejects.toThrow(
      "non-empty reason",
    );
  });

  it("refuses an id that is not a report uuid before opening a request", async () => {
    await expect(
      runRetractReport({ report_id: "the-last-one", reason: "Wrong numbers." }),
    ).rejects.toThrow("report UUID");
  });
});
