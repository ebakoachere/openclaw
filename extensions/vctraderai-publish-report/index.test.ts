import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { PUBLISH_REPORT_TOOL_NAME, runPublishReport } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function declaredParameterNames(): string[] {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-publish-report" });
  plugin.register(captured.api);
  const schema = (
    captured.tools[0] as unknown as { parameters: { properties: Record<string, unknown> } }
  ).parameters;
  return Object.keys(schema.properties);
}

function toolDescription(): string {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-publish-report" });
  plugin.register(captured.api);
  return (captured.tools[0] as unknown as { description: string }).description;
}

describe("vctraderai-publish-report", () => {
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

  it("registers publish_report", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-publish-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: PUBLISH_REPORT_TOOL_NAME });
    // The platform allowlist and the closed-world gate both match on this exact
    // string; a rename here silently darkens the tool.
    expect(PUBLISH_REPORT_TOOL_NAME).toBe("publish_report");
  });

  it("posts the report through the workspace-scoped, owner-authorized route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { report_id: "r1", delivered: false } }), {
        status: 201,
      });
    }) as typeof globalThis.fetch;

    await runPublishReport(
      {
        template: "session_summary",
        title: "Thursday session",
        period_key: "2026-08-20",
        body: { blocks: [{ k: "lede", text: "Flat day, one thesis confirmed." }] },
      },
      { fetchImpl, threadId: "thread-42" },
    );

    expect(request?.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports`);
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    // The router takes authorship from THIS header via
    // require_specialist_authority, never from the body.
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
    await expect(request?.json()).resolves.toEqual({
      template: "session_summary",
      title: "Thursday session",
      period_key: "2026-08-20",
      body: { blocks: [{ k: "lede", text: "Flat day, one thesis confirmed." }] },
    });
  });

  it("refuses an empty document before spending a publish on it", async () => {
    await expect(
      runPublishReport({ template: "research_memo", title: "Memo", body: { blocks: [] } }),
    ).rejects.toThrow("at least one block");
  });

  // WHAT WAS FALSE: the description read "and each period can be filed only
  // once - check list_reports first". The only dedupe is the partial unique
  // index reports_periodic_dedupe_idx on (workspace_id, author_key, template,
  // period_key) WHERE archived_at is null, so the period is claimed PER AUTHOR:
  // the PM and each specialist can each file a session_summary for the same
  // period_key and all of those inserts succeed. The advice compounded it,
  // because GET /reports takes author_key as an optional filter defaulting to
  // None and so returns every author's cards — a specialist that saw the PM's
  // report for today would suppress its own mandated one. WHY THE GREEN SUITE
  // HID IT: no test read the description at all, and the platform's own dedupe
  // test files both rows under a single author_key, so the cross-author case
  // was never exercised on either side.
  it("states the periodic dedupe as per-author, not per-workspace", () => {
    const description = toolDescription();
    // Non-vacuity control: this really is the periodic paragraph.
    expect(description).toMatch(/period_key/);
    expect(description).not.toMatch(/each period can be filed only once/);
    expect(description).not.toMatch(/check list_reports first/);
    expect(description).toMatch(/per AUTHOR/);
    expect(description).toMatch(/report_already_published/);
  });

  it("declares no field the router discards", () => {
    const names = declaredParameterNames();
    // Non-vacuity control: a real field the router DOES read.
    expect(names).toContain("title");
    // The router derives author_kind / author_key from the specialist headers
    // and resolves the display name from the roster, so a declared author field
    // would be a value the model is forced to invent and the server ignores.
    expect(names).not.toContain("author_kind");
    expect(names).not.toContain("author_key");
    expect(names).not.toContain("author_display_name");
  });
});
