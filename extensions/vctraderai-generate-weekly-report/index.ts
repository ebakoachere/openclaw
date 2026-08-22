import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_weekly_report. DEAD ON THIS SURFACE.
//
// Measured against propfirm_manager as of 2026-08-22:
//
//  1. `generate_weekly_report` is in core/openclaw/allowlist.py's
//     RETIRED_ENGINE_TOOLS and absent from the 133-entry ALLOWLIST.
//  2. `POST /api/v1/openclaw/reports/weekly` matches NO route on the assembled
//     app (Starlette Match.NONE). Positive controls in the same probe:
//     POST /api/v1/openclaw/notifications/send -> FULL,
//     GET /api/v1/reports/weekly -> FULL. So the call 404s; the header used to
//     claim it "computes a weekly trading-report envelope ... and returns it
//     verbatim".
//
// The only weekly-report HTTP surface is GET /api/v1/reports/weekly on the
// session-gated human router, which this plugin does not call. An engine-side
// generate_weekly_report callable still exists in
// engine/agent/tools/registry_tools.py, but that is the legacy engine
// TOOL_REGISTRY runtime and is unreachable from here.

export const GENERATE_WEEKLY_REPORT_TOOL_NAME = "generate_weekly_report";

export type GenerateWeeklyReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export type GenerateWeeklyReportParams = {
  workspace_id: string;
  week_ending?: string;
};

export async function runGenerateWeeklyReport(
  params: GenerateWeeklyReportParams,
  deps: GenerateWeeklyReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = { workspace_id: params.workspace_id };
  if (typeof params.week_ending === "string" && params.week_ending.length > 0) {
    body.week_ending = params.week_ending;
  }
  return bffFetch("/api/v1/openclaw/reports/weekly", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-weekly-report",
  name: "VC Trader AI Generate Weekly Report",
  description: "Weekly report generator - retired; its route no longer exists.",
  tools: (tool) => [
    tool({
      name: GENERATE_WEEKLY_REPORT_TOOL_NAME,
      label: "Generate Weekly Report",
      description:
        "UNAVAILABLE - do not call. This tool is retired from the OpenClaw allowlist and the " +
        "route it posts to (/api/v1/openclaw/reports/weekly) matches no route, so every call " +
        "returns 404 and never a report. For a weekly review use list_reports, then get_report " +
        "with the report UUID from the card you want.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        week_ending: Type.Optional(
          Type.String({
            description: "Week-ending date, ISO-8601 (YYYY-MM-DD).",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateWeeklyReport(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
