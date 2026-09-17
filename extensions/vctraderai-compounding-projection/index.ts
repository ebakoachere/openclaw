import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: compounding_projection (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/compounding as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const COMPOUNDING_PROJECTION_TOOL_NAME = "compounding_projection";

export type CompoundingProjectionParams = {
  starting_balance: number;
  return_per_period_pct: number;
  periods: number;
  contribution_per_period?: number;
};

export type CompoundingProjectionDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai compounding_projection: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runCompoundingProjection(
  params: CompoundingProjectionParams,
  deps: CompoundingProjectionDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = {
    starting_balance: params.starting_balance,
    return_per_period_pct: params.return_per_period_pct,
    periods: params.periods,
  };
  if (typeof params.contribution_per_period === "number") {
    body.contribution_per_period = params.contribution_per_period;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/compounding`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-compounding-projection",
  name: "VC Trader AI Compounding Projection",
  description: "Workspace-scoped read: the balance path implied by repeating a per-period return.",
  tools: (tool) => [
    tool({
      name: COMPOUNDING_PROJECTION_TOOL_NAME,
      label: "Compounding Projection",
      description:
        "The balance path implied by repeating a per-period return. Read-only; no account and no instrument. Returns the whole path period by period, the ending balance, total growth, total contributions, and depleted_at_period when a withdrawal outruns the return. Honesty: this is arithmetic on the numbers supplied under conditions the response states -- that the return repeats exactly, that costs and variation between periods are not modelled -- and it is not a statement about future results. Report it as a projection under those conditions. Refusals: out_of_domain, operand one of starting_balance, return_per_period_pct, periods.",
      parameters: Type.Object(
        {
          starting_balance: Type.Number({ description: "Opening balance, above zero." }),
          return_per_period_pct: Type.Number({
            description: "The return repeated in every period, in percent.",
          }),
          periods: Type.Integer({ description: "How many periods to trace." }),
          contribution_per_period: Type.Optional(
            Type.Number({
              description: "Added after each period's return. Negative for a withdrawal.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCompoundingProjection(
          params as CompoundingProjectionParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
