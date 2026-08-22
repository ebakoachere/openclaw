import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_strategy_source.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/strategies/${strategy_id}/source` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.registry_tools.get_strategy_source` function.
//
// IDENTIFIER SHAPE. That function's PHASE 1 entitlement probe is a bare
// `select 1 from strategy_registry.strategies where strategy_id = %s`, and the
// downstream `core.research_registry._resolve_registry_source_row` filters on
// `strategy_id` alone. `strategy_id` is a `uuid` primary key and neither site has
// a name branch, unlike `get_strategy`, which falls back to
// `lower(coalesce(display_name, strategy_name))`. So a name/slug that get_strategy
// happily resolves cannot resolve here -- the parameter description used to
// advertise "UUID or short slug" for both tools alike.

export const GET_STRATEGY_SOURCE_TOOL_NAME = "get_strategy_source";

export type GetStrategySourceDeps = {
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

export type GetStrategySourceParams = {
  strategy_id: string;
};

export async function runGetStrategySource(
  params: GetStrategySourceParams,
  deps: GetStrategySourceDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/strategies/${encodeURIComponent(params.strategy_id)}/source`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-strategy-source",
  name: "VC Trader AI Get Strategy Source",
  description: "Read-only catalogue source for a strategy.",
  tools: (tool) => [
    tool({
      name: GET_STRATEGY_SOURCE_TOOL_NAME,
      label: "Get Strategy Source",
      description:
        "Return the source text of a single strategy from strategy_registry.strategy_versions - the version its one active deployment pins when unambiguous, otherwise the head version. Returns source_text (cut at 12000 chars, with truncated=true) plus row.version / row.entry_function / row.source_hash. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        strategy_id: Type.String({
          description:
            "Strategy UUID. Only a UUID resolves here - unlike get_strategy, this tool has no name or slug lookup. Take it from list_strategies rows[].strategy_id or get_strategy row.strategy_id.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetStrategySource(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
