import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_run_equity_curve.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const GET_RUN_EQUITY_CURVE_TOOL_NAME = "get_run_equity_curve";

export type GetRunEquityCurveDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type GetRunEquityCurveParams = {
  run_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_run_equity_curve: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetRunEquityCurve(
  params: GetRunEquityCurveParams,
  deps: GetRunEquityCurveDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/experiments/${params.run_id}/run-studio`, {
    method: "GET",
    query: {},
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-run-equity-curve",
  name: "VC Trader AI Get Run Equity Curve",
  description:
    "Equity curve for one experiment run, returned with its LINEAGE and its metrics. Always report the lineage alongside the curve: a curve shown without it reads as authoritative when it may be derived or reconstructed.",
  tools: (tool) => [
    tool({
      name: GET_RUN_EQUITY_CURVE_TOOL_NAME,
      label: "Get Run Equity Curve",
      description:
        "Equity curve for one experiment run, returned with its LINEAGE and its metrics. Always report the lineage alongside the curve: a curve shown without it reads as authoritative when it may be derived or reconstructed.",
      parameters: Type.Object({
        run_id: Type.String({
          description:
            "Experiment run id. The dispatch job id and the experiment run id are the SAME value under two names.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetRunEquityCurve(
          params as GetRunEquityCurveParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
