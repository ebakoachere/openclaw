import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_report (READ).
//
// READ_ONLY per propfirm_manager core/openclaw/allowlist.py (cluster E2b).
// Served by `GET /api/v1/workspaces/{ws}/reports/{report_id}`
// (web_api/reports/v3/router.py :: get_report_detail). The route takes a single
// path parameter and NO query parameters.

export const GET_REPORT_TOOL_NAME = "get_report";

export type GetReportParams = { report_id: string };

export type GetReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Assert a report id BEFORE building a path, so the failure is legible. */
export function assertReportId(toolName: string, reportId: unknown): string {
  const value = typeof reportId === "string" ? reportId.trim() : "";
  if (!UUID_PATTERN.test(value)) {
    // Refuse loudly rather than let a malformed id become an opaque egress
    // violation or a server-side 422 (DEC-30). The id comes from list_reports
    // or from a publish_report response; nothing else mints one.
    throw new Error(
      `${toolName} requires report_id to be a report UUID as returned by list_reports or publish_report`,
    );
  }
  return value;
}

/** One full report: the card metadata plus its complete block body. */
export async function runGetReport(
  params: GetReportParams,
  deps: GetReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const reportId = assertReportId(GET_REPORT_TOOL_NAME, params.report_id);
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/reports/${reportId}`, { signal });
}

export default defineToolPlugin({
  id: "vctraderai-get-report",
  name: "VC Trader AI Get Report",
  description: "Read one published report in full, including its authored block body.",
  tools: (tool) => [
    tool({
      name: GET_REPORT_TOOL_NAME,
      label: "Get Report",
      description:
        "Read one published report in full: the card metadata plus the complete authored body, block by block (lede, headings, prose, KPI tiles, tables, charts, positioning, catalysts, risks, data-quality disclosure, flags, verdict, and any embeds, notebook outputs or images). Required: report_id, the UUID from list_reports or from a publish_report response. Read-only - it changes nothing. A RETRACTED report still opens here rather than 404ing, and carries archived_at and archived_reason, so a link from an inbox message that already delivered it keeps working and shows the retraction instead of looking like data loss. If the report was corrected, superseded_by_id points at the revision that replaced it. Use this to cite your own earlier work: read what a previous session actually concluded before repeating or contradicting it.",
      parameters: Type.Object(
        {
          report_id: Type.String({
            minLength: 36,
            maxLength: 36,
            description: "The report UUID, exactly as returned by list_reports or publish_report.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetReport(
          params as GetReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
