import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  buildPublishPayload,
  runPublishReport,
  PUBLISH_REPORT_TOOL_NAME,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const BODY = { blocks: [{ k: "lede", text: "Gold held the range." }] };

describe("vctraderai-publish-report", () => {
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

  it("registers the publish_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-publish-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: PUBLISH_REPORT_TOOL_NAME,
      label: "Publish Report",
    });
  });

  it("teaches that publishing is not delivery", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-publish-report" });
    plugin.register(captured.api);
    // The separation between filing and delivering is the single most
    // misreadable thing about this tool; if the description ever stops saying
    // so, the agent will publish and believe the trader has been told.
    const description = String((captured.tools[0] as { description?: string }).description ?? "");
    expect(description).toContain("does NOT put it in anyone's inbox");
    expect(description).toContain("send_notification");
  });

  it("posts to the workspace-scoped reports path with the owner bearer + body", async () => {
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
      return new Response(JSON.stringify({ data: { report_id: "rep-9", delivered: false } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await runPublishReport(
      { template: "research_memo", title: "Gold memo", body: BODY },
      { fetchImpl },
    );

    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports`);
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(capturedBody).toEqual({ template: "research_memo", title: "Gold memo", body: BODY });
    expect(result).toEqual({ data: { report_id: "rep-9", delivered: false } });
  });

  it("forwards the per-turn thread id so the BFF can resolve the specialist author", async () => {
    let capturedThread: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThread = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ data: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await runPublishReport(
      { template: "research_memo", title: "T", body: BODY },
      { fetchImpl, threadId: "thread-77" },
    );
    // Without this header every report is authored by the PM and the
    // per-specialist Reports tab stays empty however much the specialists write.
    expect(capturedThread).toBe("thread-77");
  });

  it("omits unset optionals entirely rather than sending them as null", () => {
    const payload = buildPublishPayload({
      template: "research_memo",
      title: "T",
      body: BODY,
    });
    // period_key absent and period_key null are DIFFERENT to the BFF: an ad-hoc
    // template must not carry one, and an explicit null is an assertion.
    expect(payload).toEqual({ template: "research_memo", title: "T", body: BODY });
    expect("period_key" in payload).toBe(false);
    expect("summary" in payload).toBe(false);
  });

  it("includes optionals that were supplied, including falsy numbers", () => {
    const payload = buildPublishPayload({
      template: "performance_review",
      title: "T",
      body: BODY,
      period_key: "2026-W34",
      end_cum: 0,
      win_rate: 0,
      tags: ["gold"],
      assets: [],
    });
    expect(payload.period_key).toBe("2026-W34");
    // 0 is a real reading, not an absent one.
    expect(payload.end_cum).toBe(0);
    expect(payload.win_rate).toBe(0);
    expect(payload.tags).toEqual(["gold"]);
    // An empty list carries no information; it is dropped rather than stored.
    expect("assets" in payload).toBe(false);
  });

  it("surfaces the server's typed rejection so the model can fix its own call", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: {
              code: "report_period_key_required",
              message: "template performance_review is periodic, so period_key is required",
              retry_suggestion: "resend with period_key, e.g. 2026-W34",
            },
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    await expect(
      runPublishReport({ template: "performance_review", title: "T", body: BODY }, { fetchImpl }),
    ).rejects.toThrow(/report_period_key_required.*period_key is required.*retry_suggestion/s);
  });

  it("fails loudly when the workspace id is not injected", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runPublishReport({ template: "research_memo", title: "T", body: BODY }, {}),
    ).rejects.toThrow(/PFM_WORKSPACE_ID is not set/);
  });
});
