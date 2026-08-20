import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { buildRevisePayload, runReviseReport, REVISE_REPORT_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const BODY = { blocks: [{ k: "lede", text: "Corrected: fills were double-counted." }] };

describe("vctraderai-revise-report", () => {
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

  it("registers the revise_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-revise-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: REVISE_REPORT_TOOL_NAME,
      label: "Revise Report",
    });
  });

  it("posts to the workspace-scoped revise path with the owner bearer + body", async () => {
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
      return new Response(JSON.stringify({ data: { report_id: "rep-10", supersedes: "rep-9" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await runReviseReport(
      { report_id: "rep-9", title: "Gold memo (corrected)", body: BODY, revision_note: "fills" },
      { fetchImpl },
    );

    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/rep-9/revise`,
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({
      title: "Gold memo (corrected)",
      body: BODY,
      revision_note: "fills",
    });
    expect(result).toEqual({ data: { report_id: "rep-10", supersedes: "rep-9" } });
  });

  it("addresses the revised report in the PATH only, never in the body", () => {
    const payload = buildRevisePayload({ report_id: "rep-9", title: "T", body: BODY });
    // Two sources of truth for WHICH report is being superseded is one too many.
    expect("report_id" in payload).toBe(false);
  });

  it("omits template and period so the original's are inherited", () => {
    const payload = buildRevisePayload({ report_id: "rep-9", title: "T", body: BODY });
    expect(payload).toEqual({ title: "T", body: BODY });
    expect("template" in payload).toBe(false);
    expect("period_key" in payload).toBe(false);
  });

  it("sends template and period_key when the caller deliberately overrides them", () => {
    const payload = buildRevisePayload({
      report_id: "rep-9",
      title: "T",
      body: BODY,
      template: "performance_review",
      period_key: "2026-W34",
    });
    expect(payload.template).toBe("performance_review");
    expect(payload.period_key).toBe("2026-W34");
  });

  it("forwards the per-turn thread id so authorship is resolved server-side", async () => {
    let capturedThread: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThread = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ data: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runReviseReport(
      { report_id: "rep-9", title: "T", body: BODY },
      { fetchImpl, threadId: "thread-77" },
    );
    expect(capturedThread).toBe("thread-77");
  });

  it("surfaces the server's typed rejection", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: { code: "report_not_found", message: "no such report in this workspace" },
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    await expect(
      runReviseReport({ report_id: "rep-nope", title: "T", body: BODY }, { fetchImpl }),
    ).rejects.toThrow(/report_not_found/);
  });

  it("fails loudly when the workspace id is not injected", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runReviseReport({ report_id: "rep-9", title: "T", body: BODY }, {}),
    ).rejects.toThrow(/PFM_WORKSPACE_ID is not set/);
  });
});
