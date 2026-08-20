import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_report (READ_ONLY).
//
// Reads ONE published report in full -- card fields plus the block body -- over
// the workspace-scoped reports boundary as the workspace owner
// (PFM_AGENT_TOKEN).
//
// A RETRACTED report still resolves here, carrying its retraction reason. That
// is the honest behaviour and it is worth stating plainly: retraction withdraws
// a claim from the library, it does not erase that the claim was made. An agent
// that can still read a withdrawn report can see that a number it once relied on
// was taken back, which is precisely the case where silently 404-ing would let
// it rebuild an argument on a foundation somebody already removed.
//
// The report id is interpolated into the path, so it is percent-encoded before
// it goes near the URL. The client's own egress guard rejects traversal
// sequences independently -- two independent checks, because a path built from
// model output is exactly where a single check is not enough.

export const GET_REPORT_TOOL_NAME = "get_report";

const TOOL_DESCRIPTION =
  "Read one published report in full, including its block body. Required: " +
  "report_id. Use it to cite or build on an earlier report rather than " +
  "re-deriving work that is already written down — including your own past " +
  "reports, which list_reports will find for you. An archived (retracted) report " +
  "still resolves here and carries its retraction reason, so you can see that a " +
  "claim was withdrawn rather than finding a hole.";

export type GetReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

export type GetReportParams = {
  report_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetReport(
  params: GetReportParams,
  deps: GetReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const reportId = encodeURIComponent(params.report_id);
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports/${reportId}`, {
    method: "GET",
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-report",
  name: "VC Trader AI Get Report",
  description: "Read one published report in full, including its block body.",
  tools: (tool) => [
    tool({
      name: GET_REPORT_TOOL_NAME,
      label: "Get Report",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          report_id: Type.String({
            description: "Report uuid, as returned by publish_report or list_reports.",
            minLength: 1,
            maxLength: 64,
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
