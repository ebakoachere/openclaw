import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: revise_report (DIRECT_CONTROL).
//
// Publishes a NEW report that supersedes an existing one, over the
// workspace-scoped reports boundary as the workspace owner (PFM_AGENT_TOKEN).
//
// NOTHING IS EDITED IN PLACE. The original row is preserved byte-for-byte, and
// a message that already delivered it still renders exactly what the reader was
// told, with a banner pointing at the revision. This is the whole point of the
// tool: an agent that could rewrite a delivered report could quietly make its
// past self right, and a reader who acted on the original would have no way to
// see that the ground moved. Correction has to leave a trail or it is not
// correction.
//
// Template and period are INHERITED from the original unless overridden, which
// is why `template` is optional here and required on publish_report. A revision
// of a Wednesday day-ahead outlook is still that Wednesday's outlook; making the
// agent restate the period would only create a way to get it wrong.
//
// Use this when the report was WRONG. When it was merely unwanted, retract it.

export const REVISE_REPORT_TOOL_NAME = "revise_report";

const TOOL_DESCRIPTION =
  "Publish a corrected report that supersedes an earlier one. Required: " +
  "report_id (the report being revised), title, and body; optional " +
  "revision_note explaining what changed, plus any field publish_report " +
  "accepts. Template and period are inherited from the original unless you " +
  "override them. Nothing is edited in place: the original report is preserved " +
  "exactly as it was delivered, so a message that already carried it still shows " +
  "the reader what they were actually told, with a banner pointing at your " +
  "revision. This is the honest way to correct yourself. Direct control — " +
  "executes immediately, no staged card.";

export type ReviseReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

export type ReviseReportParams = {
  report_id: string;
  title: string;
  body: Record<string, unknown>;
  revision_note?: string;
  summary?: string;
  subtitle?: string;
  template?: string;
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
    throw new Error("vctraderai revise_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/**
 * Build the revision payload, dropping unset optionals.
 *
 * `report_id` is deliberately NOT in the body: it addresses the report being
 * revised and travels in the PATH. Sending it in both places would create two
 * sources of truth for which report is being superseded.
 */
export function buildRevisePayload(params: ReviseReportParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: params.title,
    body: params.body,
  };
  const optional: Array<[string, unknown]> = [
    ["revision_note", params.revision_note],
    ["summary", params.summary],
    ["subtitle", params.subtitle],
    ["template", params.template],
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

export async function runReviseReport(
  params: ReviseReportParams,
  deps: ReviseReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const reportId = encodeURIComponent(params.report_id);
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports/${reportId}/revise`, {
    method: "POST",
    body: buildRevisePayload(params),
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-revise-report",
  name: "VC Trader AI Revise Report",
  description:
    "Publish a corrected report superseding an earlier one. The original is never edited.",
  tools: (tool) => [
    tool({
      name: REVISE_REPORT_TOOL_NAME,
      label: "Revise Report",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          report_id: Type.String({
            description: "Uuid of the report being revised.",
            minLength: 1,
            maxLength: 64,
          }),
          title: Type.String({
            description: "Title of the corrected report.",
            minLength: 1,
            maxLength: 300,
          }),
          body: Type.Record(Type.String(), Type.Unknown(), {
            description:
              'Corrected block document: {"blocks": [{"k": "lede", "text": "..."}, ...]}. ' +
              "Supply the WHOLE body — a revision is a complete replacement document, not a patch.",
          }),
          revision_note: Type.Optional(
            Type.String({
              description:
                "What changed and why. Write it: the reader of the original needs to know " +
                "which claim moved, not just that something did.",
              maxLength: 2000,
            }),
          ),
          summary: Type.Optional(Type.String({ maxLength: 2000 })),
          subtitle: Type.Optional(Type.String({ maxLength: 500 })),
          template: Type.Optional(
            Type.String({
              description: "Only to override; inherited from the original when omitted.",
              maxLength: 64,
            }),
          ),
          period: Type.Optional(Type.String({ maxLength: 200 })),
          period_range: Type.Optional(Type.String({ maxLength: 200 })),
          period_key: Type.Optional(
            Type.String({
              description: "Only to override; inherited from the original when omitted.",
              maxLength: 64,
            }),
          ),
          scope: Type.Optional(Type.String({ maxLength: 32 })),
          scope_name: Type.Optional(Type.String({ maxLength: 200 })),
          scope_sub: Type.Optional(Type.String({ maxLength: 200 })),
          broker: Type.Optional(Type.String({ maxLength: 100 })),
          family: Type.Optional(Type.String({ maxLength: 32 })),
          cadence: Type.Optional(Type.String({ maxLength: 32 })),
          tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
          assets: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
          read_mins: Type.Optional(Type.Integer({ minimum: 0, maximum: 600 })),
          stance: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          stat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          end_cum: Type.Optional(Type.Number()),
          vol: Type.Optional(Type.Number()),
          win_rate: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runReviseReport(
          params as ReviseReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
