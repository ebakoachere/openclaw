import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_portfolios_for_deployment.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// RENAMED FROM list_traders_for_deployment, and the rename is the smaller half.
// That tool's route `/openclaw/deployment/traders` AND its engine callable were
// retired by ADR 0083 PR-8e-3 with the vestigial trader-package layer -- but
// this plugin was left baked and ENABLED, calling a 404, and was never in the
// allowlist either, so the closed-world gate refused it first. It was a ghost in
// both directions. propfirm_manager W10 B2 rebuilt the capability on a route
// that exists (`/openclaw/deployment/portfolios`) and allowlisted the tool.
//
// "Portfolio" is the product's current word for the unit: N strategies run
// together under ONE risk budget. The engine tables keep their trader_* names
// because the live deployment path joins them; only this surface moves.

export const LIST_PORTFOLIOS_FOR_DEPLOYMENT_TOOL_NAME = "list_portfolios_for_deployment";

export type ListPortfoliosForDeploymentDeps = {
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

export type ListPortfoliosForDeploymentParams = {
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_portfolios_for_deployment: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListPortfoliosForDeployment(
  params: ListPortfoliosForDeploymentParams = {},
  deps: ListPortfoliosForDeploymentDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const query =
    typeof params.limit === "number" ? `?limit=${encodeURIComponent(String(params.limit))}` : "";
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/deployment/portfolios${query}`, {
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-portfolios-for-deployment",
  name: "VC Trader AI List Portfolios For Deployment",
  description: "Read-only workspace-scoped tool: List portfolios eligible for deployment.",
  tools: (tool) => [
    tool({
      name: LIST_PORTFOLIOS_FOR_DEPLOYMENT_TOOL_NAME,
      label: "List Portfolios For Deployment",
      description:
        "List the portfolios you can deploy. A portfolio is N strategies run together under ONE risk budget, with a single risk manager. Returns each portfolio's id, name, how many enabled strategies it holds, its risk_manager_id, and -- when already deployed -- the live account and deployment state. Archived portfolios are excluded: this answers what you CAN deploy, not what exists. Scoped to the signed-in operator. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object(
        {
          limit: Type.Optional(
            Type.Integer({
              description: "Maximum portfolios to return. Defaults to 200 server-side.",
              minimum: 1,
              maximum: 1000,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListPortfoliosForDeployment(
          params as ListPortfoliosForDeploymentParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
