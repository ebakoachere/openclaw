import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { REVISE_REPORT_TOOL_NAME, runReviseReport } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const REPORT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function declaredParameterNames(): string[] {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-revise-report" });
  plugin.register(captured.api);
  const schema = (
    captured.tools[0] as unknown as { parameters: { properties: Record<string, unknown> } }
  ).parameters;
  return Object.keys(schema.properties);
}

describe("vctraderai-revise-report", () => {
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

  it("registers revise_report", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-revise-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: REVISE_REPORT_TOOL_NAME });
    expect(REVISE_REPORT_TOOL_NAME).toBe("revise_report");
  });

  it("posts to the supersede route with report_id in the path, not the body", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { report_id: "r2", supersedes_id: REPORT_ID } }), {
        status: 201,
      });
    }) as typeof globalThis.fetch;

    await runReviseReport(
      {
        report_id: REPORT_ID,
        title: "Thursday session (corrected)",
        body: { blocks: [{ k: "lede", text: "Corrected: the equity series was stale." }] },
      },
      { fetchImpl, threadId: "thread-42" },
    );

    expect(request?.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/reports/${REPORT_ID}/revise`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
    // ReviseReportRequest is extra="forbid": a stray report_id in the body
    // would 422 the whole revision.
    await expect(request?.json()).resolves.toEqual({
      title: "Thursday session (corrected)",
      body: { blocks: [{ k: "lede", text: "Corrected: the equity series was stale." }] },
    });
  });

  it("refuses a malformed id or an empty document before opening a request", async () => {
    await expect(
      runReviseReport({
        report_id: "previous",
        title: "x",
        body: { blocks: [{ k: "lede", text: "y" }] },
      }),
    ).rejects.toThrow("report UUID");
    await expect(
      runReviseReport({ report_id: REPORT_ID, title: "x", body: { blocks: [] } }),
    ).rejects.toThrow("at least one block");
  });

  // WHAT WAS FALSE: the description read "Write the revision as a COMPLETE
  // report, not a diff: every facet you omit is absent from the replacement."
  // Three of the declared facets are never absent. post_report_revision
  // forwards family/cadence/scope as None when omitted, and author_report then
  // substitutes the inherited TEMPLATE's defaults
  // (`_require_enum(family, ...) or tpl.family`, likewise cadence and scope).
  // Running the platform service with a session_summary predecessor that
  // carried family=research, cadence=monthly, scope=agent and every facet
  // omitted produced family=performance, cadence=daily, scope=platform — so an
  // omission is neither absent nor inherited, but a silent third value, and a
  // correction can land in a different library bucket from the report the
  // reader was sent. publish_report's description already states the true rule
  // ("Any facet you leave unset defaults from the template") for the SAME
  // function. WHY THE GREEN SUITE HID IT: every assertion here was about the
  // request shape, and the one body assertion sends no facets at all, so the
  // defaulting behaviour was never observed on either side of the seam.
  it("warns that family, cadence and scope default from the template when omitted", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-revise-report" });
    plugin.register(captured.api);
    const description = (captured.tools[0] as unknown as { description: string }).description;
    // Non-vacuity control: this really is the omission paragraph.
    expect(description).toMatch(/COMPLETE report, not a diff/);
    expect(description).not.toMatch(/every facet you omit is absent from the replacement/);
    expect(description).toMatch(
      /family, cadence and scope are the exception[\s\S]*TEMPLATE's default, not the predecessor's value/,
    );
    // The two genuinely inherited fields are still stated, because that half was
    // always true and is what keeps a correction inside its dedupe slot.
    expect(description).toMatch(/Only template and period_key are inherited from the predecessor/);
  });

  it("declares no field the router discards", () => {
    const names = declaredParameterNames();
    // Non-vacuity control: a real field the router DOES forward.
    expect(names).toContain("title");
    // post_report_revision builds its fields dict WITHOUT revision_note and
    // svc.revise_report has no such keyword, so the DTO accepts it and the
    // server reads nothing from it. Declaring it would make the model compose a
    // note that is silently discarded.
    expect(names).not.toContain("revision_note");
    expect(names).not.toContain("author_kind");
    expect(names).not.toContain("author_key");
    expect(names).not.toContain("author_display_name");
  });
});
