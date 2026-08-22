import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_report (RETIRED).
//
// `generate_report` is NOT in the platform's closed-world allowlist: it is in
// `RETIRED_ENGINE_TOOLS` (core/openclaw/allowlist.py). This client still POSTs
// `{ tool_name, workspace_id, params, summary }` to the staged-action chokepoint
// `POST /api/v1/openclaw/stage`, but that handler re-gates the BODY tool with
// `gate_tool_call` before parsing or persisting anything
// (web_api/openclaw_internal/router.py), so the call raises ToolForbiddenError
// and the endpoint answers 403 `openclaw_tool_forbidden`. No staged descriptor
// is written and no human ever sees a card. Retirement is belt-and-braces:
// `generate_report` is also absent from AGENT_ALPHA_TIER_MAP and has no
// staged-apply adapter, so even a pre-existing card could not be Applied.
//
// The governed replacement is the report_* family: publish_report /
// revise_report / retract_report, all DIRECT_CONTROL, which execute directly.

export const GENERATE_REPORT_TOOL_NAME = "generate_report";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type GenerateReportDeps = {
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

export type GenerateReportParams = {
  report_type?: string;
  period?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai generate_report: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: GenerateReportParams): string {
  const reportType = typeof params.report_type === "string" ? params.report_type : "";
  return `Generate ${reportType} report`.replace(/\s+/g, " ").trim();
}

export async function runGenerateReport(
  params: GenerateReportParams,
  deps: GenerateReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: GENERATE_REPORT_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    // NOT "staged a proposal for review": generate_report is retired from the
    // platform allowlist, so the stage endpoint refuses it 403 and nothing is
    // persisted. Claiming a reviewable card here would let the model tell the
    // founder a proposal is waiting when none was ever created.
    message:
      "generate_report is retired from the platform allowlist; nothing is staged for review. Use publish_report to file a report.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-generate-report",
  name: "VC Trader AI Generate Report (Propose)",
  description:
    "Retired: the platform refuses generate_report. Use publish_report to file a report.",
  tools: (tool) => [
    tool({
      name: GENERATE_REPORT_TOOL_NAME,
      label: "Generate Report",
      description:
        "RETIRED - do not call. generate_report is not in the platform's tool allowlist: every call is refused 403 openclaw_tool_forbidden before anything is written, so nothing is staged and no human is ever shown a proposal to Apply. Use publish_report to file a report, revise_report to correct one, retract_report to withdraw one.",
      parameters: Type.Object(
        {
          report_type: Type.Optional(
            Type.String({ description: "Report type (e.g. daily, weekly, performance)." }),
          ),
          period: Type.Optional(
            Type.String({
              description: "Report period (e.g. an ISO date for daily, ISO week for weekly).",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateReport(
          params as GenerateReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
