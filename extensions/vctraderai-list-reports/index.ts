import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_reports (READ).
//
// READ_ONLY per propfirm_manager core/openclaw/allowlist.py (cluster E2b).
// Served by `GET /api/v1/workspaces/{ws}/reports`
// (web_api/reports/v3/router.py :: get_reports_list). The query parameters
// below are EXACTLY the ones that handler declares — nothing more.

export const LIST_REPORTS_TOOL_NAME = "list_reports";

export type ListReportsParams = {
  limit?: number;
  cursor?: string;
  template?: string;
  author_kind?: "pm" | "specialist" | "system";
  author_key?: string;
  family?: "outlook" | "performance" | "research" | "briefing";
  cadence?: "daily" | "weekly" | "monthly";
  scope?: "platform" | "account" | "strategy" | "instrument" | "agent";
  include_archived?: boolean;
};

export type ListReportsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_reports: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** One keyset page of this workspace's published report cards, newest first. */
export async function runListReports(
  params: ListReportsParams = {},
  deps: ListReportsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/workspaces/${requireWorkspaceId()}/reports`, {
    query: {
      limit: params.limit === undefined ? undefined : String(params.limit),
      cursor: params.cursor,
      template: params.template,
      author_kind: params.author_kind,
      author_key: params.author_key,
      family: params.family,
      cadence: params.cadence,
      scope: params.scope,
      // Only sent when true: the server already defaults it to false, and the
      // query builder drops undefined rather than serialising "false".
      include_archived: params.include_archived === true ? "true" : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-reports",
  name: "VC Trader AI List Reports",
  description: "List the authenticated workspace's published reports, newest first.",
  tools: (tool) => [
    tool({
      name: LIST_REPORTS_TOOL_NAME,
      label: "List Reports",
      description:
        "List the reports already published in this workspace's report library, newest first. Read-only. Nothing is required - call it with no arguments for the most recent page. Each entry is a card carrying the report id, template, title, subtitle, summary, who wrote it, the family/cadence/scope facets, the period covered, tags, and whether it has reached the inbox yet (deliveredAt). template, author_kind, author_key, family, cadence and scope narrow the page. Paging is keyset, not offset: if the response carries next_cursor, pass it back as cursor for the following page. Retracted reports are hidden unless include_archived is true. This page spans EVERY author unless you pass author_key, and the periodic dedupe is per author - (template, period_key) is unique only within one author_key and only among live rows - so another author's report for the same template and period does not block your own publish, and an archived one does not hold the slot. An empty list means nothing has been published yet, not an error.",
      parameters: Type.Object(
        {
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 200,
              description: "Cards per page. Defaults to 50 server-side; the cap is 200.",
            }),
          ),
          cursor: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 400,
              description:
                "Opaque keyset cursor. Use the next_cursor value from the previous page; never build one by hand.",
            }),
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
              { description: "Only reports filed under this template." },
            ),
          ),
          author_kind: Type.Optional(
            Type.Union([Type.Literal("pm"), Type.Literal("specialist"), Type.Literal("system")], {
              description: "Who wrote it: the PM main thread, a specialist, or the platform.",
            }),
          ),
          author_key: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 120,
              description:
                "Specialist key, e.g. 'gold_specialist'. Use 'pm' for the main thread's own reports.",
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
              { description: "Report family facet." },
            ),
          ),
          cadence: Type.Optional(
            Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], {
              description: "Cadence facet. Ad-hoc reports carry no cadence.",
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
              { description: "What the report is about." },
            ),
          ),
          include_archived: Type.Optional(
            Type.Boolean({
              description:
                "Include retracted and superseded reports. Defaults to false - the library shows only live reports.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListReports(
          params as ListReportsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
