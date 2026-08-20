import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runRetractReport, RETRACT_REPORT_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-retract-report", () => {
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

  it("registers the retract_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-retract-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: RETRACT_REPORT_TOOL_NAME,
      label: "Retract Report",
    });
  });

  it("requires a reason in the tool schema", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-retract-report" });
    plugin.register(captured.api);
    const parameters = (captured.tools[0] as { parameters?: any }).parameters;
    // A retraction with no stated reason is indistinguishable, to the reader,
    // from a report quietly vanishing. The requirement is the feature.
    expect(parameters?.required).toContain("reason");
    expect(parameters?.required).toContain("report_id");
  });

  it("teaches that retraction does not un-deliver", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-retract-report" });
    plugin.register(captured.api);
    const description = String((captured.tools[0] as { description?: string }).description ?? "");
    expect(description).toContain("does NOT disappear from any inbox message");
    expect(description).toContain("revise_report");
  });

  it("posts to the workspace-scoped retract path with the owner bearer + reason", async () => {
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
      return new Response(JSON.stringify({ data: { report_id: "rep-9", archived: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await runRetractReport(
      { report_id: "rep-9", reason: "fills were double-counted" },
      { fetchImpl },
    );

    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/rep-9/retract`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({ reason: "fills were double-counted" });
    expect(result).toEqual({ data: { report_id: "rep-9", archived: true } });
  });

  it("percent-encodes the report id", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runRetractReport({ report_id: "rep 9", reason: "why" }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/rep%209/retract`,
    );
  });

  it("surfaces the server's typed rejection", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: { error: { code: "report_not_found", message: "no such report" } },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    await expect(
      runRetractReport({ report_id: "rep-nope", reason: "why" }, { fetchImpl }),
    ).rejects.toThrow(/report_not_found/);
  });

  it("fails loudly when the workspace id is not injected", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(runRetractReport({ report_id: "rep-9", reason: "why" }, {})).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
