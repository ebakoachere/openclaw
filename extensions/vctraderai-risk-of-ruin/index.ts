import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: risk_of_ruin (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/risk-of-ruin as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const RISK_OF_RUIN_TOOL_NAME = "risk_of_ruin";

export type RiskOfRuinParams = {
  win_rate: number;
  payoff_ratio: number;
  risk_per_trade_pct: number;
  trades: number;
  ruin_threshold_pct?: number;
};

export type RiskOfRuinDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai risk_of_ruin: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runRiskOfRuin(
  params: RiskOfRuinParams,
  deps: RiskOfRuinDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = {
    win_rate: params.win_rate,
    payoff_ratio: params.payoff_ratio,
    risk_per_trade_pct: params.risk_per_trade_pct,
    trades: params.trades,
  };
  if (typeof params.ruin_threshold_pct === "number") {
    body.ruin_threshold_pct = params.ruin_threshold_pct;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/risk-of-ruin`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-risk-of-ruin",
  name: "VC Trader AI Risk Of Ruin",
  description:
    "Workspace-scoped read: probability of losing a stated share of the account over a horizon.",
  tools: (tool) => [
    tool({
      name: RISK_OF_RUIN_TOOL_NAME,
      label: "Risk Of Ruin",
      description:
        "Probability of losing a stated share of the account over a horizon. Read-only; no account and no instrument. Returns the probability, the model's name, the number of simulated paths and the assumptions the number rests on. Honesty: risk of ruin is model-dependent and the same inputs give different answers under different models, so the model and its assumptions come back with every answer and belong in what you report -- a bare probability without them reads as fact. Ruin is a threshold rather than zero because a fixed-fractional account never reaches zero. Costs, slippage and correlation between trades are not modelled. Refusals: out_of_domain, whose operand names the input.",
      parameters: Type.Object(
        {
          win_rate: Type.Number({
            description: "Probability of a winning trade, strictly between 0 and 1.",
          }),
          payoff_ratio: Type.Number({
            description: "Average win divided by average loss. Above zero.",
          }),
          risk_per_trade_pct: Type.Number({
            description: "Share of current equity risked per trade, in percent.",
          }),
          trades: Type.Integer({
            description: "How many trades the horizon covers.",
          }),
          ruin_threshold_pct: Type.Optional(
            Type.Number({
              description:
                "How much of the starting account has to be lost to count as ruin, in percent. Default 50.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRiskOfRuin(
          params as RiskOfRuinParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
