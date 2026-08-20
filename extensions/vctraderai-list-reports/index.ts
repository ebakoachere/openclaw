import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_reports (READ_ONLY).
//
// Lists the workspace's published report CARDS, newest first, over the
// workspace-scoped reports boundary as the workspace owner (PFM_AGENT_TOKEN).
//
// Cards only -- no block bodies. That is deliberate: a list of twenty full
// reports would be most of a context window, and the agent almost always wants
// to know WHETHER something exists rather than what it said. get_report fetches
// a body once the agent knows which one it wants.
//
// The duplicate check is the main reason this tool is reachable at all. The
// store REFUSES a second report for the same template and period, so listing
// first is strictly cheaper than being rejected -- and cheaper still than the
// failure mode it prevents, which is an agent that reads a rejection as a
// backend fault and reports an outage.

export const LIST_REPORTS_TOOL_NAME = "list_reports";

const TOOL_DESCRIPTION =
  "List the workspace's published reports, newest first. Optional: limit " +
  "(default 20), template, author_kind (pm, specialist, or system), author_key " +
  "(a specialist key), cursor for the next page. Before writing a periodic " +
  "report, list it first: the store refuses a duplicate for the same template " +
  "and period, and finding out beforehand is cheaper than being refused. " +
  "Returns cards only — call get_report for a body.";

export type ListReportsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

export type ListReportsParams = {
  limit?: number;
  template?: string;
  author_kind?: string;
  author_key?: string;
  family?: string;
  cadence?: string;
  scope?: string;
  include_archived?: boolean;
  cursor?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_reports: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/**
 * Build the query string map.
 *
 * `buildQueryString` drops undefined and empty values, so every optional filter
 * is simply absent when unset rather than sent as the string "undefined" -- a
 * filter the BFF would try to match and answer honestly-empty for.
 */
export function buildListQuery(params: ListReportsParams): Record<string, string | undefined> {
  return {
    limit: params.limit === undefined ? undefined : String(params.limit),
    template: params.template,
    author_kind: params.author_kind,
    author_key: params.author_key,
    family: params.family,
    cadence: params.cadence,
    scope: params.scope,
    include_archived: params.include_archived === true ? "true" : undefined,
    cursor: params.cursor,
  };
}

export async function runListReports(
  params: ListReportsParams = {},
  deps: ListReportsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/reports`, {
    method: "GET",
    query: buildListQuery(params),
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-reports",
  name: "VC Trader AI List Reports",
  description:
    "List the workspace's published reports, newest first, filterable by template and author.",
  tools: (tool) => [
    tool({
      name: LIST_REPORTS_TOOL_NAME,
      label: "List Reports",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          limit: Type.Optional(
            Type.Integer({
              description: "Page size, 1..100. Defaults to 20 server-side.",
              minimum: 1,
              maximum: 100,
            }),
          ),
          template: Type.Optional(
            Type.String({
              description:
                "Filter by template key: day_ahead_outlook, pre_session_briefing, " +
                "session_summary, performance_review, backtest_result, research_memo.",
              maxLength: 64,
            }),
          ),
          author_kind: Type.Optional(
            Type.String({ description: "pm, specialist, or system.", maxLength: 32 }),
          ),
          author_key: Type.Optional(
            Type.String({
              description: "Specialist key — the per-specialist Reports tab filter.",
              maxLength: 64,
            }),
          ),
          family: Type.Optional(Type.String({ maxLength: 32 })),
          cadence: Type.Optional(Type.String({ maxLength: 32 })),
          scope: Type.Optional(Type.String({ maxLength: 32 })),
          include_archived: Type.Optional(
            Type.Boolean({
              description:
                "Include retracted reports. Default false — a retracted report is withdrawn, " +
                "so it is out of the library unless you ask for it.",
            }),
          ),
          cursor: Type.Optional(
            Type.String({ description: "Opaque keyset cursor for the next page.", maxLength: 512 }),
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
