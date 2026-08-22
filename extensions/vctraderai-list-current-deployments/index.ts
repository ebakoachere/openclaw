import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_current_deployments.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// THE NAME OVERSELLS THE PLANE. engine/live/deployments.py::
// list_current_deployments selects from live.trader_deployments, INNER-joined to
// research.trader_definitions and live.trader_packages. ADR 0083 PR-8e-3 deleted
// every writer of that table; a repo-wide probe finds `insert into
// live.trader_deployments` in two TEST files and nowhere else, and the only
// non-test mutation is the UPDATE in record_runtime_heartbeat, which returns
// {"configured": false, "reason": "no_current_deployment"} when no row exists and
// so can never create one. The deployments that actually run are the governed
// rows in strategy_registry.strategy_deployments (the sole source for the live
// runtime boot, and the only table web_api/strategies/v3/_deploy_writes.py
// writes); this tool never reads them and has no fallback to them.
//
// So the honest contract is: an empty result means "the legacy plane is empty",
// NOT "nothing is deployed". Saying otherwise licenses a duplicate deploy
// proposal and tells the founder nothing is trading while strategies are armed.

export const LIST_CURRENT_DEPLOYMENTS_TOOL_NAME = "list_current_deployments";

export type ListCurrentDeploymentsDeps = {
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

/** This tool takes no parameters. `Record<string, never>` says exactly that;
 * the `{}` type does not — it admits any non-nullish value. */
export type ListCurrentDeploymentsParams = Record<string, never>;

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_current_deployments: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListCurrentDeployments(
  _params: ListCurrentDeploymentsParams = {},
  deps: ListCurrentDeploymentsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/deployment/current`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-current-deployments",
  name: "VC Trader AI List Current Deployments",
  description:
    "Read-only workspace-scoped tool: list rows from the legacy trader-package deployment plane. Does NOT list governed strategy deployments.",
  tools: (tool) => [
    tool({
      name: LIST_CURRENT_DEPLOYMENTS_TOOL_NAME,
      label: "List Current Deployments",
      description:
        "List rows from the LEGACY trader-package plane: live.trader_deployments joined to live.trader_packages and research.trader_definitions, plus each row's latest heartbeat. ADR 0083 PR-8e-3 deleted every product writer of that table, so this normally returns an empty list. It does NOT list governed strategy deployments (strategy_registry.strategy_deployments, written by deploy_strategy_to_account), which no tool here reads. So an empty result is NOT evidence that nothing is deployed, and it cannot tell you whether a strategy version is already attached to an account. READ_ONLY per ADR 0078. Scoped to the workspace owner.",
      parameters: Type.Object({}),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListCurrentDeployments(
          params as ListCurrentDeploymentsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
