import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: retract_report (WRITE).
//
// DIRECT_CONTROL per propfirm_manager core/openclaw/allowlist.py (cluster E2b).
// Served by `POST /api/v1/workspaces/{ws}/reports/{report_id}/retract`
// (web_api/reports/v3/router.py :: post_report_retraction). The body is
// `RetractReportRequest`, which carries exactly ONE field: a required `reason`.
// Nothing else is read, so nothing else is declared.

export const RETRACT_REPORT_TOOL_NAME = "retract_report";

export type RetractReportParams = { report_id: string; reason: string };

export type RetractReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai retract_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Assert a report id BEFORE building a path, so the failure is legible. */
export function assertReportId(toolName: string, reportId: unknown): string {
  const value = typeof reportId === "string" ? reportId.trim() : "";
  if (!UUID_PATTERN.test(value)) {
    throw new Error(
      `${toolName} requires report_id to be a report UUID as returned by list_reports or publish_report`,
    );
  }
  // Lowercased because the egress allowlist admits lowercase hex only. A uuid
  // is case-insensitive and Postgres emits it lowercase, so an uppercased echo
  // of a real id would otherwise fail as an opaque egress violation instead of
  // working.
  return value.toLowerCase();
}

/** Archives a published report. The reason is required by the server. */
export async function runRetractReport(
  params: RetractReportParams,
  deps: RetractReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const reportId = assertReportId(RETRACT_REPORT_TOOL_NAME, params.report_id);
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (!reason) {
    // The server requires it (min_length=1) for a reason worth restating: a
    // retraction with no stated reason is indistinguishable from a report
    // quietly disappearing. Refuse here so the failure names the field.
    throw new Error("retract_report requires a non-empty reason");
  }
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/reports/${reportId}/retract`, {
    method: "POST",
    body: { reason },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-retract-report",
  name: "VC Trader AI Retract Report",
  description: "Withdraw a published report from the workspace library, with a required reason.",
  tools: (tool) => [
    tool({
      name: RETRACT_REPORT_TOOL_NAME,
      label: "Retract Report",
      description:
        "Withdraw a published report from the workspace library. Required: report_id and reason - both of them. This is one of only two things you can do to an already-published report; the other is revise_report, and the report itself is otherwise immutable. Retracting archives the report so it no longer appears in the library, but it does NOT remove it from any inbox message that already delivered it: that message is the record that the reader was told something, and the attachment renders as retracted rather than vanishing. get_report keeps working on a retracted report and returns it with its archivedAt and archivedReason. Reach for revise_report instead whenever the report was wrong but the subject still needs covering - retract is for a report that should not stand at all. The reason is mandatory because a retraction with no stated reason is indistinguishable from a report quietly disappearing.",
      parameters: Type.Object(
        {
          report_id: Type.String({
            minLength: 36,
            maxLength: 36,
            description:
              "UUID of the report to withdraw, as returned by list_reports or publish_report.",
          }),
          reason: Type.String({
            minLength: 1,
            maxLength: 500,
            description:
              "Why the report is being withdrawn. It is shown to the reader in place of the report, so write it for them, not for a log.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRetractReport(
          params as RetractReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
