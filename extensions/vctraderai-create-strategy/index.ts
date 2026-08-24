import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_strategy (DIRECT_CONTROL, WS-C PR B).
//
// Cluster-C registry tool. FLIPPED from PROPOSE_ONLY (staged card) to
// DIRECT_CONTROL: this tool CREATES the strategy directly -- it authors Python +
// a manifest, validates, and persists the strategy + registry pointer
// immediately. It calls the guarded internal BFF route
// `POST /api/v1/openclaw/registry/create-strategy` with the shared
// OPENCLAW_GATEWAY_TOKEN plus `X-OpenClaw-Tool` so the server-side allowlist gates
// the exact tool. owner_user_id is resolved SERVER-SIDE from the trusted
// workspace (never sent by this plugin); this is authoring only (no backtest,
// deploy, or live-money action).

export const CREATE_STRATEGY_TOOL_NAME = "create_strategy";
const REGISTRY_PATH = "/api/v1/openclaw/registry/create-strategy";

export type CreateStrategyDeps = {
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

export type CreateStrategyParams = {
  /**
   * REQUIRED. The BFF refuses the call with HTTP 422
   * `openclaw_registry_mutation_failed` ("create_strategy is missing required
   * field(s): name.") when this is absent, empty, or whitespace-only
   * (web_api/openclaw_internal/router.py `_REGISTRY_CREATE_STRATEGY_REQUIRED`),
   * and the engine tool's `name` keyword has no default behind it.
   */
  name: string;
  strategy_type?: string;
  archetype?: string;
  intent_brief?: string;
  /** Complete agent-authored Python; the BFF assigns source provenance. */
  source_text: string;
  /**
   * REQUIRED. ``run`` for a research artifact, or the exact Strategy class
   * name for a class-native Nautilus artifact.
   */
  entry_function: string;
  /** REQUIRED. The artifact contract is never inferred from source text. */
  runtime_tag: "vbt" | "nautilus";
  default_params?: Record<string, unknown>;
  timeframes?: string[];
  instruments?: string[];
  sessions?: string[];
  indicators?: string[];
  [key: string]: unknown;
};

export async function runCreateStrategy(
  params: CreateStrategyParams,
  deps: CreateStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(REGISTRY_PATH, {
    method: "POST",
    body: params,
    headers: { "X-OpenClaw-Tool": CREATE_STRATEGY_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-create-strategy",
  name: "VC Trader AI Create Strategy",
  description:
    "Creates a directly authored Python strategy, validated and persisted owner-scoped; no second authoring model.",
  tools: (tool) => [
    tool({
      name: CREATE_STRATEGY_TOOL_NAME,
      label: "Create Strategy",
      description:
        "Create a NEW trading strategy directly. name, source_text, runtime_tag, and entry_function are all required. Choose the artifact contract BEFORE writing source: runtime_tag=vbt requires entry_function='run' and the six-key research return contract; lint_strategy validates that shape. runtime_tag=nautilus requires entry_function to name the native Strategy subclass and a canonical StrategyConfig class; this tool validates that class-native contract directly, because lint_strategy rejects it. Only a runtime_tag=nautilus strategy with a pinned Nautilus class can deploy, and the runtime is fixed at creation - update_strategy cannot change it. This does not backtest, deploy, or touch live money.",
      parameters: Type.Object(
        {
          name: Type.String({
            description:
              "Required. Human-readable strategy name; missing, empty, or whitespace-only is refused with HTTP 422.",
            minLength: 1,
          }),
          strategy_type: Type.Optional(
            Type.String({
              description:
                "Strategy type identifier (must match a list_strategy_types entry if provided).",
            }),
          ),
          archetype: Type.Optional(
            Type.String({ description: "Strategy archetype (e.g. trend, mean-reversion)." }),
          ),
          intent_brief: Type.Optional(
            Type.String({ description: "Optional concise intent metadata for the strategy." }),
          ),
          source_text: Type.String({
            description:
              "Required complete native-Python source. Use run(...) for vbt research, or a named nautilus_trader Strategy class for runtime_tag=nautilus.",
            minLength: 1,
          }),
          entry_function: Type.String({
            minLength: 1,
            description:
              "Required. Use exactly run for vbt research; otherwise use the exact native Nautilus Strategy class name.",
          }),
          runtime_tag: Type.String({
            enum: ["vbt", "nautilus"],
            description:
              "Required. vbt requires entry_function=run; nautilus requires the named Strategy class and StrategyConfig contract.",
          }),
          default_params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Default strategy parameters keyed by name.",
            }),
          ),
          timeframes: Type.Optional(
            Type.Array(Type.String(), { description: "Timeframes (e.g. ['M5','H1'])." }),
          ),
          instruments: Type.Optional(
            Type.Array(Type.String(), { description: "Instrument symbols (e.g. ['EUR_USD'])." }),
          ),
          sessions: Type.Optional(
            Type.Array(Type.String(), { description: "Trading sessions (e.g. ['london'])." }),
          ),
          indicators: Type.Optional(
            Type.Array(Type.String(), { description: "Indicator names the strategy uses." }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateStrategy(
          params as CreateStrategyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
