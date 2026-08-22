import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_strategy.
//
// READ_ONLY per ADR 0078. Calls the BFF `/api/v1/openclaw/catalogue/strategies/${strategy_id}` endpoint and
// returns the raw envelope produced by the propfirm_manager
// `engine.agent.tools.registry_tools.get_strategy` function.
//
// That function reads the WORKSPACE-scoped registry head
// `strategy_registry.strategies` (+ `strategy_registry.strategy_versions`, and the
// research.strategy_* manifests) under a two-phase RLS gate; its own `sources`
// field is `postgres:strategy_registry.strategies`. There is no `core.strategies`
// table in the platform -- the description used to name one.

export const GET_STRATEGY_TOOL_NAME = "get_strategy";

export type GetStrategyDeps = {
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

export type GetStrategyParams = {
  strategy_id: string;
};

export async function runGetStrategy(
  params: GetStrategyParams,
  deps: GetStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(
    `/api/v1/openclaw/catalogue/strategies/${encodeURIComponent(params.strategy_id)}`,
    {
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-get-strategy",
  name: "VC Trader AI Get Strategy",
  description: "Read-only catalogue lookup of a single strategy.",
  tools: (tool) => [
    tool({
      name: GET_STRATEGY_TOOL_NAME,
      label: "Get Strategy",
      description:
        "Return a single strategy from the propfirm_manager workspace-scoped registry head strategy_registry.strategies. Returns row (strategy_id, name, strategy_type_id, entrypoint, default_params) plus its timeframes, instruments, sessions, indicators and recent source_versions. Not visible in your workspace = not found. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        strategy_id: Type.String({
          description:
            "Strategy UUID, or the exact display name / strategy_name slug (matched case-insensitively).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetStrategy(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
