import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: revise_report (WRITE).
//
// DIRECT_CONTROL per propfirm_manager core/openclaw/allowlist.py (cluster E2b).
// Served by `POST /api/v1/workspaces/{ws}/reports/{report_id}/revise`
// (web_api/reports/v3/router.py :: post_report_revision), whose body is
// `ReviseReportRequest` in web_api/reports/v3/requests.py.
//
// TWO FIELDS ON THAT DTO ARE DELIBERATELY NOT EXPOSED HERE:
//
// * `revision_note` -- the DTO accepts it, but `post_report_revision` builds
//   its `fields` dict without it and `svc.revise_report` has no such keyword.
//   The server READS NOTHING from it, so declaring it would force the model to
//   compose a note that is silently discarded. That is exactly the defect fork
//   PRs #28/#29 fixed elsewhere, and it is not reintroduced here.
// * `author_display_name` -- cosmetic only; authorship is resolved server-side
//   from `require_specialist_authority` via the X-OpenClaw-Thread header.
//
// A revision is a FULL RESTATEMENT, with ONE exception the model must know.
// `template` and `period_key` are inherited from the predecessor when omitted
// (svc.revise_report `kwargs.setdefault`). Everything else is forwarded as sent
// — but `author_report` then fills `family`, `cadence` and `scope` from the
// inherited TEMPLATE's defaults (`_require_enum(...) or tpl.family`, etc.), so
// those three are never absent and never inherit the predecessor's overrides.
// Measured on a session_summary predecessor carrying research/monthly/agent: a
// revision omitting all three landed performance/daily/platform. Every other
// facet does land empty (NULL, or `[]` for tags and assets).

export const REVISE_REPORT_TOOL_NAME = "revise_report";

export type ReportStance = { label: string; dir: string; note?: string };
export type ReportStat = {
  label: string;
  value: string;
  sub?: string;
  dir?: string;
  delta?: string;
};

export type ReviseReportParams = {
  report_id: string;
  title: string;
  body: { blocks: unknown[] };
  template?: string;
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

export type ReviseReportDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai revise_report: PFM_WORKSPACE_ID is not set");
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

/** Refuse a body that is not a block document before opening a request. */
export function assertBlockDocument(toolName: string, body: unknown): void {
  const blocks = (body as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(
      `${toolName} requires body to be a block document with at least one block, of the form {"blocks": [...]}`,
    );
  }
}

/** Publishes a NEW report superseding an existing one. Nothing is mutated. */
export async function runReviseReport(
  params: ReviseReportParams,
  deps: ReviseReportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const reportId = assertReportId(REVISE_REPORT_TOOL_NAME, params.report_id);
  assertBlockDocument(REVISE_REPORT_TOOL_NAME, params.body);
  const { report_id: _reportId, ...payload } = params;
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/reports/${reportId}/revise`, {
    method: "POST",
    body: payload,
    signal,
  });
}

// Identical vocabulary to publish_report: a revision takes exactly the same
// document shape, because it goes through exactly the same validation path.
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
  id: "vctraderai-revise-report",
  name: "VC Trader AI Revise Report",
  description: "Publish a corrected report that supersedes an earlier one.",
  tools: (tool) => [
    tool({
      name: REVISE_REPORT_TOOL_NAME,
      label: "Revise Report",
      description:
        "Correct a report you have already published. Required: report_id (the report being superseded), title and body. Nothing is edited - a published report is immutable. It files a NEW report and archives the original in one transaction; a message that already delivered the old one still opens it, so the reader can see what they were told. Write the revision as a COMPLETE report, not a diff: an omitted facet lands empty rather than carrying over. Only template and period_key are inherited from the predecessor, which keeps the correction on the same template and inside the same periodic dedupe slot - so normally leave both unset. family, cadence and scope are the exception: omitted, they take that TEMPLATE's default, not the predecessor's value, so restate any the original overrode or the correction is silently re-filed under a different facet. Like publish_report it files without delivering: the response carries the new report_id and delivered: false; send it with send_notification if the reader needs the correction. Authorship is stamped server-side. If the report should be withdrawn rather than corrected, use retract_report instead.",
      parameters: Type.Object(
        {
          report_id: Type.String({
            minLength: 36,
            maxLength: 36,
            description:
              "UUID of the report being superseded, as returned by list_reports or publish_report.",
          }),
          title: Type.String({
            minLength: 1,
            maxLength: 300,
            description: "The corrected headline. Required even when it is unchanged.",
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
          template: Type.Optional(
            Type.Union(
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
                  "Leave unset. Omitted, the revision inherits the predecessor's template, which is what keeps a correction filed where the original was.",
              },
            ),
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
                "Leave unset. Omitted, the revision inherits the predecessor's period_key, which is what keeps it inside the same dedupe slot rather than opening a second one.",
            }),
          ),
          read_mins: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 600, description: "Estimated reading minutes." }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: 12,
              description:
                "Up to twelve short tags. Restate the original's tags; they are not inherited.",
            }),
          ),
          assets: Type.Optional(
            Type.Array(Type.String(), {
              maxItems: 12,
              description:
                "Ids of existing report assets referenced by image blocks. Restate them; they are not inherited.",
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
        return runReviseReport(
          params as ReviseReportParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
