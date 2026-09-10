import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: lint_strategy (validate strategy source against the runtime contract).
//
// Calls the workspace-scoped strategy-authoring lint endpoint as the workspace
// owner (PFM_AGENT_TOKEN) to lint strategy Python source against the contract
// the caller declares: the SIX-KEY vbt contract (run(data,params,context)
// returning long/short entries+exits + positive sl_stop/tp_stop) via
// core.strategy_lint, or the class-native Nautilus contract when
// runtime_tag='nautilus'. Returns { passed, errors: [{ code, message,
// fix_hint }] }. Stateless / read-only (no persistence). This is a POST with a
// JSON body (source can be large).
//
// SHAPE SCOPE (D-127), AND WHY THIS PLUGIN CHANGED.
//
// The BFF route selects its contract with
// `is_class_native_artifact(runtime_tag, entry_function)`, which needs
// runtime_tag == "nautilus" AND entry_function != "run". Until this change the
// plugin sent neither runtime_tag nor the manifest, so the predicate was always
// false, every lint ran the Shape-A/six-key path, and a correct class-native
// Nautilus source came back with three AST_GUARD_REJECTION denied_import errors
// whose fix_hints told the model to delete its nautilus_trader imports.
//
// WS-2/WS-4 landed `runtime_tag`, `manifest` and `default_params` on
// `LintStrategyRequest` (web_api/strategy_authoring/schemas.py, extra="forbid",
// all optional) and the authoring guide now instructs the agent to call
// lint_strategy WITH them -- a promise this plugin could not keep. It forwards
// all three now, so lint runs the SAME contract, the SAME capability
// reconciliation and the SAME smoke arms that create_strategy will run.
//
// Every new field is OMITTED when absent rather than sent as null: the request
// model forbids extras and types runtime_tag as a two-value literal, so a null
// would 422 a call that used to work.

export const LINT_STRATEGY_TOOL_NAME = "lint_strategy";

export type LintStrategyDeps = {
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

export type LintStrategyParams = {
  source: string;
  entry_function?: string;
  runtime_tag?: "vbt" | "nautilus";
  manifest?: Record<string, unknown>;
  default_params?: Record<string, unknown>;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai lint_strategy: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runLintStrategy(
  params: LintStrategyParams,
  deps: LintStrategyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const source = nonEmpty(params.source);
  // `source` is required; the BFF returns 400 (invalid_source) otherwise. Guard
  // here so a malformed call fails fast with a clear message.
  if (source === undefined) {
    throw new Error("vctraderai lint_strategy: source is required (the strategy Python source)");
  }
  const body: {
    source: string;
    entry_function?: string;
    runtime_tag?: string;
    manifest?: Record<string, unknown>;
    default_params?: Record<string, unknown>;
  } = { source };
  const entryFunction = nonEmpty(params.entry_function);
  if (entryFunction !== undefined) {
    body.entry_function = entryFunction;
  }
  const runtimeTag = nonEmpty(params.runtime_tag);
  if (runtimeTag !== undefined) {
    body.runtime_tag = runtimeTag;
  }
  if (params.manifest !== undefined && params.manifest !== null) {
    body.manifest = params.manifest;
  }
  if (params.default_params !== undefined && params.default_params !== null) {
    body.default_params = params.default_params;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/strategy-authoring/lint`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-lint-strategy",
  name: "VC Trader AI Lint Strategy",
  description:
    "Workspace-scoped tool: lint strategy Python source against the runtime contract it declares -- the six-key vbt contract, or the class-native Nautilus contract when runtime_tag='nautilus' -- via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). Stateless / read-only; persists nothing.",
  tools: (tool) => [
    tool({
      name: LINT_STRATEGY_TOOL_NAME,
      label: "Lint Strategy",
      description:
        "Lint strategy Python against the SAME contract create_strategy will run, with nothing persisted. Pass runtime_tag='nautilus' with entry_function=<YourStrategyClassName> to lint a class-native Nautilus strategy; omit runtime_tag (or pass 'vbt') with entry_function='run' for the six-key vbt contract, where run(data, params, context) must return { long_entries, short_entries, long_exits, short_exits, sl_stop, tp_stop } with positive-finite sl_stop/tp_stop. Pass the manifest and default_params you plan to send to create_strategy and lint reconciles the manifest's declared capabilities against the source and smokes with those params, so a green lint is a green create. Returns { passed, errors: [{ code, message, fix_hint }] }; passed=false is a normal result, not a call failure, and every fix_hint is meant to be followed. For a Nautilus class the contract requires its StrategyConfig to declare instrument_id, pfm_initial_cash and pfm_risk_fraction, and the class to READ pfm_risk_fraction and pfm_initial_cash when sizing. Use it before create_strategy or update_strategy. Persists nothing.",
      parameters: Type.Object({
        source: Type.String({
          description: "The strategy Python source to lint (the full module text).",
        }),
        entry_function: Type.Optional(
          Type.String({
            description:
              "Use exactly 'run' for the six-key vbt contract (the default); for runtime_tag='nautilus' use the exact Strategy CLASS name.",
          }),
        ),
        runtime_tag: Type.Optional(
          Type.String({
            enum: ["vbt", "nautilus"],
            description:
              "Which contract to lint against. 'nautilus' (with a class-name entry_function) selects the class-native contract; omitted or 'vbt' keeps the six-key one.",
          }),
        ),
        manifest: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "The StrategySpec manifest planned for create_strategy. Supplying it makes lint reconcile the manifest's declared capabilities against the source, exactly as create will.",
          }),
        ),
        default_params: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "The parameter mapping planned for create_strategy. The bounded smoke runs with these values, so lint and create smoke the same thing.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runLintStrategy(
          params as LintStrategyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
