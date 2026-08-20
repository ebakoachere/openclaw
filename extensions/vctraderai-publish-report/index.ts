import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: publish_report (DIRECT_CONTROL).
//
// Files a structured, block-bodied report in the workspace report library by
// POSTing to the workspace-scoped reports boundary as the workspace owner
// (PFM_AGENT_TOKEN). There is no staged descriptor and no human Apply: the
// report exists the moment the BFF returns 201.
//
// PUBLISHING IS NOT DELIVERY. This is the single most important thing about
// this tool and the reason the description repeats it. A published report lands
// in the library -- the Data page, and the author's own Reports tab -- and
// nobody is told. Delivery is a separate act: send_notification carrying
// attachments=[{kind: "report", id: <report_id>}]. That separation is
// deliberate; it is what lets an agent write a report it is not yet ready to
// put in front of the trader, and it is why the response carries an explicit
// `next_step` rather than letting the agent assume the reader has seen it.
//
// AUTHORSHIP is resolved SERVER-SIDE from the X-OpenClaw-Thread header, which
// the client stamps from the plugin execute context. The agent cannot claim to
// be a specialist it is not. This is also why the header is load-bearing rather
// than cosmetic: without it every report is authored by the PM and the
// per-specialist Reports tab stays empty however much the specialists write.

export const PUBLISH_REPORT_TOOL_NAME = "publish_report";

const TOOL_DESCRIPTION =
  "Publish a structured report to the workspace library. Required: template " +
  "(day_ahead_outlook, pre_session_briefing, session_summary, performance_review, " +
  "backtest_result, or research_memo), title, and body. The body is a block " +
  'document — {"blocks": [{"k": "lede", "text": "..."}, {"k": "kpis", "items": [...]}, ' +
  '{"k": "chart", "series": [...]}, {"k": "table", "cols": [...], "rows": [...]}, ...]}. ' +
  "A chart block carries the ACTUAL data points you read, never a shape you " +
  "imagined, because the platform draws the chart from them. Periodic templates " +
  "require period_key (for example 2026-08-19 or 2026-W34); ad-hoc templates must " +
  "not carry one. IMPORTANT: publishing FILES the report in the library — the Data " +
  "page, and your own Reports tab if you are a specialist — but it does NOT put it " +
  "in anyone's inbox. Nobody is told. To tell them, take the report_id this returns " +
  'and call send_notification with attachments=[{"kind": "report", "id": report_id}] ' +
  "and a short cover message saying what you found. Direct control — executes " +
  "immediately, no staged card; capped at five publishes per workspace per five minutes.";

export type PublishReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and stamp the report's author_kind / author_key accordingly.
   * Sourced from the plugin execute context (`context.threadId`).
   */
  threadId?: string;
};

export type PublishReportParams = {
  template: string;
  title: string;
  body: Record<string, unknown>;
  summary?: string;
  subtitle?: string;
  period?: string;
  period_range?: string;
  period_key?: string;
  scope?: string;
  scope_name?: string;
  scope_sub?: string;
  broker?: string;
  family?: string;
  cadence?: string;
  tags?: string[];
  assets?: string[];
  read_mins?: number;
  stance?: Record<string, unknown>;
  stat?: Record<string, unknown>;
  end_cum?: number;
  vol?: number;
  win_rate?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai publish_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/**
 * Drop keys the model did not supply.
 *
 * The BFF distinguishes "absent" from "null" on several optional fields --
 * `period_key` in particular, where an ad-hoc template must NOT carry one and an
 * explicit null is not the same as omission. Serialising undefined keys as JSON
 * null would turn every unset optional into an assertion.
 */
export function buildPublishPayload(params: PublishReportParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    template: params.template,
    title: params.title,
    body: params.body,
  };
  const optional: Array<[string, unknown]> = [
    ["summary", params.summary],
    ["subtitle", params.subtitle],
    ["period", params.period],
    ["period_range", params.period_range],
    ["period_key", params.period_key],
    ["scope", params.scope],
    ["scope_name", params.scope_name],
    ["scope_sub", params.scope_sub],
    ["broker", params.broker],
    ["family", params.family],
    ["cadence", params.cadence],
    ["read_mins", params.read_mins],
    ["stance", params.stance],
    ["stat", params.stat],
    ["end_cum", params.end_cum],
    ["vol", params.vol],
    ["win_rate", params.win_rate],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null) {
      payload[key] = value;
    }
  }
  if (params.tags && params.tags.length > 0) {
    payload.tags = params.tags;
  }
  if (params.assets && params.assets.length > 0) {
    payload.assets = params.assets;
  }
  return payload;
}

export async function runPublishReport(
  params: PublishReportParams,
  deps: PublishReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports`, {
    method: "POST",
    body: buildPublishPayload(params),
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-publish-report",
  name: "VC Trader AI Publish Report",
  description:
    "File a structured, block-bodied report in the workspace report library. Publishing does not deliver it.",
  tools: (tool) => [
    tool({
      name: PUBLISH_REPORT_TOOL_NAME,
      label: "Publish Report",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          template: Type.String({
            description:
              "Report template key: day_ahead_outlook, pre_session_briefing, session_summary, " +
              "performance_review, backtest_result, or research_memo.",
            minLength: 1,
            maxLength: 64,
          }),
          title: Type.String({
            description: "Report title.",
            minLength: 1,
            maxLength: 300,
          }),
          body: Type.Record(Type.String(), Type.Unknown(), {
            description:
              'Block document: {"blocks": [{"k": "lede", "text": "..."}, ...]}. Block kinds: ' +
              "lede, h2, h3, p, pull, callout, kpis, table, chart, positioning, catalysts, " +
              "risks, quality, flags, verdict, signalcard, embed, image. Blocks are validated " +
              "before storage, so an invalid document is refused with the offending block named " +
              "rather than stored and breaking the reader later.",
          }),
          summary: Type.Optional(
            Type.String({
              description: "Short standfirst shown on the report card.",
              maxLength: 2000,
            }),
          ),
          subtitle: Type.Optional(Type.String({ maxLength: 500 })),
          period: Type.Optional(
            Type.String({
              description: "DISPLAY label for the period, e.g. 'Wednesday 20 August'.",
              maxLength: 200,
            }),
          ),
          period_range: Type.Optional(Type.String({ maxLength: 200 })),
          period_key: Type.Optional(
            Type.String({
              description:
                "Canonical period key for PERIODIC templates, e.g. 2026-08-19 or 2026-W34. " +
                "Required for periodic templates and refused on ad-hoc ones; it is what makes " +
                "a duplicate publish for the same period detectable.",
              maxLength: 64,
            }),
          ),
          scope: Type.Optional(
            Type.String({
              description: "What the report is about: platform, account, or strategy.",
              maxLength: 32,
            }),
          ),
          scope_name: Type.Optional(Type.String({ maxLength: 200 })),
          scope_sub: Type.Optional(Type.String({ maxLength: 200 })),
          broker: Type.Optional(Type.String({ maxLength: 100 })),
          family: Type.Optional(Type.String({ maxLength: 32 })),
          cadence: Type.Optional(Type.String({ maxLength: 32 })),
          tags: Type.Optional(
            Type.Array(Type.String(), { description: "Up to 12 free-form tags.", maxItems: 12 }),
          ),
          assets: Type.Optional(
            Type.Array(Type.String(), {
              description: "Up to 12 instrument symbols the report covers.",
              maxItems: 12,
            }),
          ),
          read_mins: Type.Optional(Type.Integer({ minimum: 0, maximum: 600 })),
          stance: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          stat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          end_cum: Type.Optional(Type.Number({ description: "Card chart number." })),
          vol: Type.Optional(Type.Number({ description: "Card chart number." })),
          win_rate: Type.Optional(Type.Number({ description: "Card chart number." })),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runPublishReport(
          params as PublishReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
