import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runGenerateReport, GENERATE_REPORT_TOOL_NAME } from "./index.js";

describe("vctraderai-generate-report", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("registers the generate_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-generate-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_REPORT_TOOL_NAME,
      label: "Generate Report",
    });
  });

  // WHAT WAS FALSE: the registered description read "This STAGES a proposal for
  // the human to review + Apply in the chat ... PROPOSE_ONLY per ADR 0078."
  // generate_report is in the platform's RETIRED_ENGINE_TOOLS and absent from
  // ALLOWLIST, so POST /api/v1/openclaw/stage re-gates the body tool and answers
  // 403 openclaw_tool_forbidden before persisting anything: no proposal row, no
  // card, nothing to Apply. WHY THE GREEN SUITE HID IT: every test here asserted
  // on the request envelope and the 403 error shape, never on the sentence the
  // model actually plans from, so the description could say anything.
  it("does not advertise a staged proposal the platform will never create", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-generate-report" });
    plugin.register(captured.api);
    const description = (captured.tools[0] as unknown as { description: string }).description;
    // Non-vacuity control: the description is a real, non-empty string.
    expect(description.length).toBeGreaterThan(50);
    expect(description).not.toMatch(/STAGES a proposal/i);
    expect(description).not.toMatch(/review \+ Apply/i);
    expect(description).not.toMatch(/PROPOSE_ONLY/i);
    // The corrected fact: it is refused, and the caller is pointed at the tool
    // that actually files a report.
    expect(description).toMatch(/RETIRED/);
    expect(description).toMatch(/openclaw_tool_forbidden/);
    expect(description).toMatch(/publish_report/);
  });

  it("posts to the stage path with the staging envelope (tool_name = allowlist key)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const result: any = await runGenerateReport({ report_type: "x" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("generate_report");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ report_type: "x" });
    expect(typeof capturedBody.summary).toBe("string");
    // The returned message used to read "Staged a generate report proposal.
    // Review + Apply it in the chat." — a sentence the model could relay to the
    // founder as an approval pending on a card that was never written.
    expect(result.message).not.toMatch(/Staged a generate report proposal/i);
    expect(result.message).toMatch(/retired/i);
  });

  // This is the ONLY outcome the live platform produces: the stage endpoint
  // re-gates the body tool against the closed-world allowlist, generate_report
  // is retired from it, and the response is 403 openclaw_tool_forbidden.
  it("surfaces a structured error on the bff 403 every real call receives", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateReport({ report_type: "x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
