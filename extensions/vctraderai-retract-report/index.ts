import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: retract_report (DIRECT_CONTROL).
//
// Withdraws a published report from the workspace library over the
// workspace-scoped reports boundary as the workspace owner (PFM_AGENT_TOKEN).
//
// WITHDRAWAL IS NOT DELETION. The report leaves the Data page and the author's
// Reports tab, and get_report still resolves it carrying this reason. Any inbox
// message that already delivered it KEEPS its attachment, marked retracted. An
// agent can withdraw a claim; it cannot erase having made it. Anything else
// would let a report be un-sent after a human had already acted on it.
//
// `reason` is REQUIRED and the requirement is load-bearing rather than
// bureaucratic: a retraction with no stated reason is indistinguishable, to the
// reader, from a report quietly vanishing -- and "the report I was working from
// disappeared" is a far worse experience than "the report I was working from was
// withdrawn because the fill data was double-counted".
//
// When the report was WRONG rather than unwanted, revise_report is the better
// tool: it links the correction to the original instead of leaving a hole.

export const RETRACT_REPORT_TOOL_NAME = "retract_report";

const TOOL_DESCRIPTION =
  "Withdraw a published report from the workspace library. Required: report_id " +
  "and reason (a retraction with no stated reason is indistinguishable from a " +
  "report quietly vanishing). The report leaves the Data page and the author's " +
  "Reports tab. It does NOT disappear from any inbox message that already " +
  "delivered it — that message keeps its attachment, marked retracted with your " +
  "reason. You can withdraw a claim; you cannot erase having made it. When the " +
  "report was WRONG rather than unwanted, prefer revise_report so the corrected " +
  "version is linked to the original. Direct control — executes immediately, no " +
  "staged card.";

export type RetractReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

export type RetractReportParams = {
  report_id: string;
  reason: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai retract_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runRetractReport(
  params: RetractReportParams,
  deps: RetractReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const reportId = encodeURIComponent(params.report_id);
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports/${reportId}/retract`, {
    method: "POST",
    body: { reason: params.reason },
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
      description: TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          report_id: Type.String({
            description: "Uuid of the report to withdraw.",
            minLength: 1,
            maxLength: 64,
          }),
          reason: Type.String({
            description:
              "Why the report is being withdrawn. Required — it is shown to anyone who " +
              "already received the report, in place of the claim you are taking back.",
            minLength: 1,
            maxLength: 500,
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
