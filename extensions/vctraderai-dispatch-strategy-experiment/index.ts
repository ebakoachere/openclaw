import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: dispatch_strategy_experiment (PROPOSE).
//
// PROPOSE_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). This
// tool STAGES a strategy-first experiment-launch proposal; it NEVER dispatches
// directly. It POSTs to the BFF staged-action chokepoint
// `POST /api/v1/openclaw/stage` with `{ tool_name, workspace_id, params,
// summary }`. On Apply, the BFF reuses the v3 dispatch_experiment service in
// process (which emits the experiment_dispatched COMMIT). The optional
// `origin_signal_id` links the run's realized outcome back to the agent signal
// that motivated it (the learning loop).

export const DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME = "dispatch_strategy_experiment";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type DispatchStrategyExperimentDeps = {
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

export type DispatchStrategyExperimentParams = {
  strategy_id?: string;
  strategy_version_id?: string;
  experiment_kind?: string;
  config?: Record<string, unknown>;
  /** Project id OR name; the BFF resolves either. Omitted = the workspace primary. */
  project_id?: string;
  bundle_id?: string;
  idempotency_key?: string;
  origin_signal_id?: string;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai dispatch_strategy_experiment: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: DispatchStrategyExperimentParams): string {
  const kind = params.experiment_kind ?? "experiment";
  const target = params.strategy_version_id ?? params.strategy_id ?? "";
  return `Dispatch ${kind} for strategy ${target}`.trim();
}

export async function runDispatchStrategyExperiment(
  params: DispatchStrategyExperimentParams,
  deps: DispatchStrategyExperimentDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a strategy-experiment dispatch proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-dispatch-strategy-experiment",
  name: "VC Trader AI Dispatch Strategy Experiment (Propose)",
  description:
    "Stages a strategy-first experiment (backtest / prop-sim / walkforward) dispatch proposal for human review; never dispatches directly.",
  tools: (tool) => [
    tool({
      name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      label: "Dispatch Strategy Experiment",
      description:
        'Propose a strategy-first experiment launch against a registered strategy version. This STAGES a proposal the human reviews and Applies in the chat - it never dispatches directly (PROPOSE_ONLY per ADR 0078). Provide strategy_id (or strategy_version_id) plus experiment_kind. SIX catalogue kinds dispatch for real and return real engine metrics: vbt_backtest, vbt_walkforward, vbt_prop_sim, nautilus_backtest, nautilus_walkforward, nautilus_prop_sim. TWO are refused 422 before anything is staged, so never propose them: nautilus_prop_walkforward (rolling prop windows, unproven) and stage_b_bundle_run (deferred to V3) - if the user asks for either, say it is in build. Bare "backtest" / "walkforward" are legacy aliases, not kinds. The vbt_ / nautilus_ prefix must match the strategy\'s runtime_tag (a dual strategy satisfies both; call get_strategy if unsure). config ALWAYS requires instrument, from_ts and to_ts. The prop kinds (vbt_prop_sim, nautilus_prop_sim) ALSO require rule_overlay: "prop_firm" simulates a named firm challenge and then additionally requires prop_firm_variant_id and prop_account_size - take both from ONE list_prop_firm_challenges row, whose rule_set_id IS the variant id and whose account_size is the size; neither is defaulted, because a guessed size resolves to a real-looking spec for an account the firm does not sell. "standard" enforces no firm rules. When the launch follows a view you emitted with emit_specialist_signal, pass origin_signal_id so the learning loop can bind the run\'s outcome to your proposal.',
      parameters: Type.Object(
        {
          strategy_id: Type.Optional(
            Type.String({ description: "Registered strategy id to run." }),
          ),
          strategy_version_id: Type.Optional(
            Type.String({ description: "Specific strategy version id to run." }),
          ),
          experiment_kind: Type.Optional(
            Type.String({
              description:
                'One of the six kinds that dispatch for real: vbt_backtest, vbt_walkforward, vbt_prop_sim, nautilus_backtest, nautilus_walkforward, nautilus_prop_sim. The other two catalogue kinds ALWAYS 422: nautilus_prop_walkforward and stage_b_bundle_run. Bare "backtest" / "walkforward" are legacy aliases and may be rejected.',
              examples: ["vbt_backtest", "nautilus_prop_sim"],
            }),
          ),
          config: Type.Optional(
            Type.Object(
              {},
              {
                additionalProperties: true,
                description:
                  'Run config. ALWAYS required: instrument (e.g. EUR_USD), from_ts and to_ts (window bounds; a date such as 2026-02-01 or a full ISO-8601 timestamp). Use exactly those canonical key names. The prop kinds (vbt_prop_sim, nautilus_prop_sim) ALSO require rule_overlay, one of "prop_firm" or "standard". With "prop_firm", additionally pass prop_firm_variant_id (a list_prop_firm_challenges row\'s rule_set_id) and prop_account_size (that same row\'s account_size, whole USD). Optional: timeframe.',
                examples: [
                  {
                    instrument: "EUR_USD",
                    timeframe: "1h",
                    from_ts: "2026-02-01T00:00:00Z",
                    to_ts: "2026-07-29T00:00:00Z",
                  },
                ],
              },
            ),
          ),
          project_id: Type.Optional(
            Type.String({
              description:
                "The project this experiment belongs to. Accepts either the project id or its NAME (the BFF resolves both). Optional — omitted means the workspace's primary project — but PREFER naming one: an experiment's only list surface in the product is its project, so this decides where the human can find the run afterwards. An experiment with no project executes and succeeds but is invisible in Projects and Experiments.",
              examples: ["Alpha Research"],
            }),
          ),
          bundle_id: Type.Optional(Type.String({ description: "Optional bundle id." })),
          idempotency_key: Type.Optional(
            Type.String({ description: "Optional idempotency key (auto-derived if omitted)." }),
          ),
          origin_signal_id: Type.Optional(
            Type.String({
              description:
                "Optional: the emit_specialist_signal signal_id that motivated this launch (learning-loop link).",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDispatchStrategyExperiment(
          params as DispatchStrategyExperimentParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
