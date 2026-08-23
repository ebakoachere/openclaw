import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: publish_report (WRITE).
//
// DIRECT_CONTROL per propfirm_manager core/openclaw/allowlist.py (cluster E2b).
// Served by `POST /api/v1/workspaces/{ws}/reports`
// (web_api/reports/v3/router.py :: post_report), whose body is
// `AuthorReportRequest` in web_api/reports/v3/requests.py.
//
// AUTHORSHIP IS NEVER SENT. The router derives author_kind / author_key from
// `require_specialist_authority` (the X-OpenClaw-Thread header this client
// stamps), never from the body -- which is what makes the per-specialist
// Reports tab trustworthy. `author_display_name` exists on the DTO but is
// cosmetic and deliberately NOT exposed here: the server already resolves the
// display name from the specialist roster, and offering the field only invites
// a self-chosen name that attribution ignores.

export const PUBLISH_REPORT_TOOL_NAME = "publish_report";

export type ReportStance = { label: string; dir: string; note?: string };
export type ReportStat = {
  label: string;
  value: string;
  sub?: string;
  dir?: string;
  delta?: string;
};

export type PublishReportParams = {
  /** When set, file this as a REVISION of that report id instead of a new report. */
  supersedes?: string;
  template: string;
  title: string;
  body: { blocks: unknown[] };
  subtitle?: string;
  summary?: string;
  family?: string;
  cadence?: string;
  scope?: string;
  scope_name?: string;
  scope_sub?: string;
  broker?: string;
  period?: string;
  period_range?: string;
  period_key?: string;
  read_mins?: number;
  tags?: string[];
  assets?: string[];
  stance?: ReportStance;
  stat?: ReportStat;
  end_cum?: number;
  vol?: number;
  win_rate?: number;
};

export type PublishReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai publish_report: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Refuse a body that is not a block document before opening a request. */
export function assertBlockDocument(toolName: string, body: unknown): void {
  const blocks = (body as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    // Refuse loudly (DEC-30) rather than spend a publish on a document the
    // server will reject: an empty document is a caller mistake, not a report.
    throw new Error(
      `${toolName} requires body to be a block document with at least one block, of the form {"blocks": [...]}`,
    );
  }
}

/** Files a report. With `supersedes`, files it as a REVISION of that one.
 *
 * W11: this absorbed `revise_report`, which took the same 22 parameters plus a
 * report id and posted to a different route. Two tools whose schemas differ by
 * one field cost the model a selection decision every turn and cost the prompt
 * roughly 1,100 tokens for the duplicate vocabulary -- the block document
 * description is the bulk of both, and it was carried twice.
 *
 * `retract_report` is deliberately NOT absorbed: it takes an id and a reason,
 * shares nothing else, and retracting is a different decision from publishing
 * (D-22: correct or retract, never delete). Merging it would have been merging
 * on the word "report" rather than on the shape.
 */
export async function runPublishReport(
  params: PublishReportParams,
  deps: PublishReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  assertBlockDocument(PUBLISH_REPORT_TOOL_NAME, params.body);
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const supersedes = (params.supersedes ?? "").trim();
  if (supersedes.length > 0) {
    const { supersedes: _s, ...payload } = params;
    return bffFetch(`/api/v1/workspaces/${workspaceId}/reports/${supersedes}/revise`, {
      method: "POST",
      body: payload,
      signal,
    });
  }
  // A blank-but-present supersedes must not be forwarded as a field the publish
  // route does not accept; strip it on this arm too.
  const { supersedes: _blank, ...payload } = params;
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports`, {
    method: "POST",
    body: payload,
    signal,
  });
}

// The block vocabulary. It lives in the schema description because the block
// document is the one thing an agent cannot infer from the route: the server
// validates it strictly (every block model is extra="forbid") and rejects the
// whole publish when a single field is wrong.
export const REPORT_BODY_DESCRIPTION = [
  'The authored document: {"blocks": [ ... ]}, an ordered list of typed blocks each identified by its "k" discriminator. Blocks and their fields (optional fields in square brackets):',
  "lede {text, [serif]} the opening statement; h2 {text} and h3 {text} headings; p {text} a paragraph; pull {text, [attribution]} a pull-quote; callout {text, [tone: pos|neg|note], [title]}.",
  "kpis {items: [{label, value, [sub], [dir: pos|neg]}]} one to eight headline tiles.",
  "table {cols: [string], rows: [[string]], [align: [l|r|c]], [title]} - every row must hold exactly as many cells as there are cols, and align, if given, exactly as many entries.",
  "chart {series: [{name, points: [{x, y}]}], [variant: area|bar|line], [title], [note], [zero], [foot: [{label, value, [dir]}]]} - up to six series of up to 2000 points. The block carries the data you actually read and the platform draws it.",
  "positioning {rows: [{asset, klass, bias, dir: up|down|flat, conv: 0-4, view, [sup], [res]}], [title]}; catalysts {items: [{when, event, impact: high|med|low, [note]}], [title]}; risks {items: [string], [title]}.",
  "quality {rows: [{label, value, [note]}], [title]} the data-quality disclosure, what the numbers rest on; flags {items: [{kind: pos|neg|note, text}]}; verdict {label, text, [dir: up|down|flat]}.",
  "signalcard {title, conviction: 0.0-1.0, [instrument], [dir], [status: acted|not-acted|watching], [evidence: [string]]}.",
  "image {asset_id, alt, [caption]} - alt is required because reports are read aloud too; notebook_output {run_id, cell_index, artifact_id, [caption]} references a notebook cell output instead of copying it; embed {html, [height 80-2000], [title], [fallback_text]} is sandboxed HTML or SVG capped at 256KB, the escape hatch rather than the default.",
  "MONEY TYPING IS LOAD-BEARING: display values (kpi value, quality value, chart foot value) are STRINGS you have already formatted, such as +$24,180 or -2.9%. Chart values (chart point y, positioning conv, signalcard conviction) are NUMBERS. Never swap the two.",
  "Limits: 400 blocks and 1MB in total. The document is validated before it is stored and the error names the exact block and field, so a rejection is always fixable.",
].join(" ");

export default defineToolPlugin({
  id: "vctraderai-publish-report",
  name: "VC Trader AI Publish Report",
  description:
    "File a structured report in the authenticated workspace's report library, or revise one by passing supersedes.",
  tools: (tool) => [
    tool({
      name: PUBLISH_REPORT_TOOL_NAME,
      label: "Publish Report",
      description:
        'Publish a structured report to this workspace\'s report library. Required: template, title and body. PUBLISHING IS NOT DELIVERING - this files the report and returns delivered: false together with the new report_id; nothing reaches the inbox until you choose to send it. To put it in front of the reader now, follow this call with send_notification carrying attachments=[{"kind": "report", "id": <report_id>}] and a short cover message saying what the report found. A published report is IMMUTABLE: to correct one, call this tool again with supersedes=<the report id>, which files a replacement and archives the original; to withdraw one call retract_report. Authorship is stamped by the server from your own identity, so there is no author field to supply. Templates: day_ahead_outlook, pre_session_briefing, session_summary and performance_review are PERIODIC and therefore REQUIRE period_key. Dedupe is per AUTHOR: re-filing a template+period_key you already filed returns 409 report_already_published (pass supersedes=<that report id> instead), but another author\'s report for the same period does NOT block yours - a match in list_reports is not necessarily yours. backtest_result and research_memo are ad-hoc and must NOT carry a period_key. Any facet you leave unset defaults from the template. The workspace is capped at five publishes per five minutes.',
      parameters: Type.Object(
        {
          supersedes: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Report id this one REPLACES. Omit to file a NEW report. Set it to file a REVISION: the replacement is filed and the original is archived rather than deleted, so the record of what was said and when survives. Every other field is identical either way, which is why this is one tool and not two.",
            }),
          ),
          template: Type.Union(
            [
              Type.Literal("day_ahead_outlook"),
              Type.Literal("pre_session_briefing"),
              Type.Literal("session_summary"),
              Type.Literal("performance_review"),
              Type.Literal("backtest_result"),
              Type.Literal("research_memo"),
            ],
            {
              description:
                "Which kind of report this is. day_ahead_outlook: a forward read on an instrument or session. pre_session_briefing: the state of the desk into an open. session_summary: a retrospective on a completed session. performance_review: periodic account or strategy performance. backtest_result: a backtest or walkforward written up as evidence. research_memo: ad-hoc findings. The first four are periodic and require period_key.",
            },
          ),
          title: Type.String({
            minLength: 1,
            maxLength: 300,
            description: "The headline. Say what the report concluded, not what it is about.",
          }),
          body: Type.Object(
            {
              blocks: Type.Array(
                Type.Object(
                  {
                    k: Type.Union([
                      Type.Literal("lede"),
                      Type.Literal("h2"),
                      Type.Literal("h3"),
                      Type.Literal("p"),
                      Type.Literal("pull"),
                      Type.Literal("callout"),
                      Type.Literal("kpis"),
                      Type.Literal("table"),
                      Type.Literal("chart"),
                      Type.Literal("positioning"),
                      Type.Literal("catalysts"),
                      Type.Literal("risks"),
                      Type.Literal("quality"),
                      Type.Literal("flags"),
                      Type.Literal("verdict"),
                      Type.Literal("signalcard"),
                      Type.Literal("embed"),
                      Type.Literal("notebook_output"),
                      Type.Literal("image"),
                    ]),
                  },
                  {
                    additionalProperties: true,
                    description: "One block. Its remaining fields are fixed by its k.",
                  },
                ),
                { minItems: 1, maxItems: 400 },
              ),
            },
            { additionalProperties: false, description: REPORT_BODY_DESCRIPTION },
          ),
          subtitle: Type.Optional(
            Type.String({ maxLength: 500, description: "One line under the title." }),
          ),
          summary: Type.Optional(
            Type.String({
              maxLength: 2000,
              description: "The card blurb: what a reader learns without opening the report.",
            }),
          ),
          family: Type.Optional(
            Type.Union(
              [
                Type.Literal("outlook"),
                Type.Literal("performance"),
                Type.Literal("research"),
                Type.Literal("briefing"),
              ],
              { description: "Overrides the template's default family." },
            ),
          ),
          cadence: Type.Optional(
            Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], {
              description: "Overrides the template's default cadence.",
            }),
          ),
          scope: Type.Optional(
            Type.Union(
              [
                Type.Literal("platform"),
                Type.Literal("account"),
                Type.Literal("strategy"),
                Type.Literal("instrument"),
                Type.Literal("agent"),
              ],
              { description: "What the report is about. Overrides the template's default." },
            ),
          ),
          scope_name: Type.Optional(
            Type.String({
              maxLength: 200,
              description: "The named subject: the account, strategy or instrument.",
            }),
          ),
          scope_sub: Type.Optional(
            Type.String({ maxLength: 200, description: "A second-line qualifier for the scope." }),
          ),
          broker: Type.Optional(
            Type.String({ maxLength: 100, description: "Broker, when the scope is an account." }),
          ),
          period: Type.Optional(
            Type.String({
              maxLength: 200,
              description: "DISPLAY label for the period covered, e.g. Thursday 20 August.",
            }),
          ),
          period_range: Type.Optional(
            Type.String({ maxLength: 200, description: "DISPLAY range, e.g. 18-22 Aug 2026." }),
          ),
          period_key: Type.Optional(
            Type.String({
              maxLength: 64,
              description:
                "Machine dedupe key. REQUIRED for a periodic template and FORBIDDEN for an ad-hoc one. Use 2026-08-20 for a daily report, 2026-W34 for a weekly one, 2026-08 for a monthly one. It is the only thing standing between a retried heartbeat and a duplicate report.",
            }),
          ),
          read_mins: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 600, description: "Estimated reading minutes." }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: 12,
              description: "Up to twelve short tags for the library filter.",
            }),
          ),
          assets: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: 12,
              description:
                "Ids of existing report assets referenced by image blocks. Leave it unset unless you already hold an asset id.",
            }),
          ),
          stance: Type.Optional(
            Type.Object(
              {
                label: Type.String(),
                dir: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("flat")]),
                note: Type.Optional(Type.String()),
              },
              {
                additionalProperties: false,
                description:
                  "Outlook card chip: the headline stance and its direction. Outlook reports only.",
              },
            ),
          ),
          stat: Type.Optional(
            Type.Object(
              {
                label: Type.String(),
                value: Type.String(),
                sub: Type.Optional(Type.String()),
                dir: Type.Optional(Type.String()),
                delta: Type.Optional(Type.String()),
              },
              {
                additionalProperties: false,
                description:
                  "Performance card headline figure. value is a DISPLAY string you format, e.g. +6.84%.",
              },
            ),
          ),
          end_cum: Type.Optional(
            Type.Number({ description: "Card sparkline end value. A CHART number." }),
          ),
          vol: Type.Optional(
            Type.Number({ description: "Card volatility figure. A CHART number." }),
          ),
          win_rate: Type.Optional(
            Type.Number({ description: "Card win rate. A CHART number, not a formatted string." }),
          ),
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
