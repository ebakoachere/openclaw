import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: lint_strategy (validate strategy source against the runtime contract).
//
// Calls the workspace-scoped strategy-authoring lint endpoint as the workspace
// owner (PFM_AGENT_TOKEN) to lint strategy Python source against the SIX-KEY
// runtime contract (run(data,params,context) returning long/short entries+exits
// + positive sl_stop/tp_stop) via core.strategy_lint. Returns
// { passed, errors: [{ code, message, fix_hint }] }. Stateless / read-only (no
// persistence). This is a POST with a JSON body (source can be large).
//
// SHAPE SCOPE (D-127). The BFF route selects its contract with
// `is_class_native_artifact(runtime_tag, entry_function)`, which needs
// runtime_tag == "nautilus" AND entry_function != "run". This plugin does not
// send runtime_tag at all, so the predicate is always false and every lint runs
// the Shape-A/six-key path. Measured against web_api/strategy_authoring/service
// on the repo's own NativeStrategy fixture: this body shape returns passed=false
// with three AST_GUARD_REJECTION denied_import errors while
// validate_nautilus_class_source_contract returns [] on the identical source.
// The tool description must therefore NOT advertise this as the validator for a
// class-native Nautilus artifact.

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
  const body: { source: string; entry_function?: string } = { source };
  const entryFunction = nonEmpty(params.entry_function);
  if (entryFunction !== undefined) {
    body.entry_function = entryFunction;
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
    "Workspace-scoped tool: lint strategy Python source against the six-key vbt runtime contract via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). It cannot lint a class-native Nautilus artifact. Stateless / read-only; persists nothing.",
  tools: (tool) => [
    tool({
      name: LINT_STRATEGY_TOOL_NAME,
      label: "Lint Strategy",
      description:
        "Lint vbt/Shape-A strategy Python against the six-key runtime contract: run(data, params, context) must return { long_entries, short_entries, long_exits, short_exits, sl_stop, tp_stop } with positive-finite sl_stop/tp_stop, using only the allowed imports/helpers. Returns { passed, errors: [{ code, message, fix_hint }] }; passed=false is a normal result, not a call failure. Use it on a vbt run(...) source before create_strategy or update_strategy. It runs ONLY the six-key contract: a valid class-native nautilus_trader Strategy is falsely rejected here with AST_GUARD_REJECTION denied_import errors whose fix_hint says to delete the nautilus_trader imports - do not lint a Nautilus class here and do not follow those hints; create_strategy and update_strategy validate a class artifact against the Nautilus class contract themselves. Persists nothing.",
      parameters: Type.Object({
        source: Type.String({
          description: "The strategy Python source to lint (the full module text).",
        }),
        entry_function: Type.Optional(
          Type.String({
            description:
              "Entry function the six-key contract requires (default 'run'); a class name does not switch contracts.",
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
