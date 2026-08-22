import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_daily_report. DEAD ON THIS SURFACE.
//
// Measured against propfirm_manager as of 2026-08-22:
//
//  1. `generate_daily_report` is in core/openclaw/allowlist.py's
//     RETIRED_ENGINE_TOOLS and absent from the 133-entry ALLOWLIST.
//  2. `POST /api/v1/openclaw/reports/daily` matches NO route on the assembled
//     app (Starlette Match.NONE). Positive controls in the same probe:
//     POST /api/v1/openclaw/notifications/send -> FULL,
//     GET /api/v1/reports/daily -> FULL. So the call 404s; the header used to
//     claim it "computes a daily trading-report envelope ... and returns it
//     verbatim".
//
// The only daily-report HTTP surface is GET /api/v1/reports/daily on the
// session-gated human router, which this plugin does not call. An engine-side
// generate_daily_report callable still exists in
// engine/agent/tools/registry_tools.py, but that is the legacy engine
// TOOL_REGISTRY runtime and is unreachable from here.

export const GENERATE_DAILY_REPORT_TOOL_NAME = "generate_daily_report";

export type GenerateDailyReportDeps = {
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

export type GenerateDailyReportParams = {
  workspace_id: string;
  day?: string;
};

export async function runGenerateDailyReport(
  params: GenerateDailyReportParams,
  deps: GenerateDailyReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = { workspace_id: params.workspace_id };
  if (typeof params.day === "string" && params.day.length > 0) {
    body.day = params.day;
  }
  return bffFetch("/api/v1/openclaw/reports/daily", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-daily-report",
  name: "VC Trader AI Generate Daily Report",
  description: "Daily report generator - retired; its route no longer exists.",
  tools: (tool) => [
    tool({
      name: GENERATE_DAILY_REPORT_TOOL_NAME,
      label: "Generate Daily Report",
      description:
        "UNAVAILABLE - do not call. This tool is retired from the OpenClaw allowlist and the " +
        "route it posts to (/api/v1/openclaw/reports/daily) matches no route, so every call " +
        "returns 404 and never a report. To answer how the desk did, use list_reports, then " +
        "get_report with the report UUID from the card you want.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        day: Type.Optional(
          Type.String({
            description: "Report day, ISO-8601 (YYYY-MM-DD).",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateDailyReport(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
