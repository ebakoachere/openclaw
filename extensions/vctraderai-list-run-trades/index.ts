import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_run_trades.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const LIST_RUN_TRADES_TOOL_NAME = "list_run_trades";

export type ListRunTradesDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type ListRunTradesParams = {
  run_id: string;
  outcome?: "win" | "loss" | "breakeven";
  from_ts?: string;
  to_ts?: string;
  cursor?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_run_trades: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListRunTrades(
  params: ListRunTradesParams,
  deps: ListRunTradesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/experiments/${params.run_id}/trade-audit`, {
    method: "GET",
    query: {
      outcome: params.outcome,
      from_ts: params.from_ts,
      to_ts: params.to_ts,
      cursor: params.cursor,
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-run-trades",
  name: "VC Trader AI List Run Trades",
  description:
    "Per-trade audit rows for one experiment run, cursor-paginated at 100 per page and 500 maximum, filterable by outcome and by time range.",
  tools: (tool) => [
    tool({
      name: LIST_RUN_TRADES_TOOL_NAME,
      label: "List Run Trades",
      description:
        "Per-trade audit rows for one experiment run, cursor-paginated at 100 per page and 500 maximum, filterable by outcome and by time range.",
      parameters: Type.Object({
        run_id: Type.String({
          description:
            "Experiment run id. The dispatch job id and the experiment run id are the SAME value under two names.",
          minLength: 1,
        }),
        outcome: Type.Optional(
          Type.Union([Type.Literal("win"), Type.Literal("loss"), Type.Literal("breakeven")], {
            description: "Optional outcome filter.",
          }),
        ),
        from_ts: Type.Optional(
          Type.String({
            description: "Optional ISO-8601 lower bound on trade time.",
            minLength: 1,
          }),
        ),
        to_ts: Type.Optional(
          Type.String({
            description: "Optional ISO-8601 upper bound on trade time.",
            minLength: 1,
          }),
        ),
        cursor: Type.Optional(
          Type.String({
            description: "Opaque pagination cursor from a previous page.",
            minLength: 1,
          }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Page size, 1 to 500. Defaults to 100." }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListRunTrades(
          params as ListRunTradesParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
