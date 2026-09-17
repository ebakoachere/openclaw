import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: consistency_check (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/consistency as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const CONSISTENCY_CHECK_TOOL_NAME = "consistency_check";

export type ConsistencyCheckParams = { daily_pnls: number[]; max_single_day_pct?: number };

export type ConsistencyCheckDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai consistency_check: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runConsistencyCheck(
  params: ConsistencyCheckParams,
  deps: ConsistencyCheckDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = { daily_pnls: params.daily_pnls };
  if (typeof params.max_single_day_pct === "number") {
    body.max_single_day_pct = params.max_single_day_pct;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/consistency`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-consistency-check",
  name: "VC Trader AI Consistency Check",
  description:
    "Workspace-scoped read: whether any single day's profit exceeds the share of total profit a prop-firm challenge allows.",
  tools: (tool) => [
    tool({
      name: CONSISTENCY_CHECK_TOOL_NAME,
      label: "Consistency Check",
      description:
        "Whether any single day's profit exceeds the share of total profit a prop-firm challenge allows. Read-only. Returns whether it is within the limit, the largest day and its share, the limit, total profit and the day counts. Honesty: without a limit the check DECLINES rather than passing -- consistency limits differ by firm and are not assumed, and a pass reported because nothing was configured says the rule held when the rule was never checked. A series with no profitable days declines for the same reason. max_single_day_pct is optional so the platform can decline rather than reject the call: the declining is the feature. Refusals: operand_missing:threshold, operand_missing:daily_pnls, insufficient_sample, out_of_domain.",
      parameters: Type.Object(
        {
          daily_pnls: Type.Array(Type.Number(), {
            description: "Per-day profit and loss, in one currency.",
          }),
          max_single_day_pct: Type.Optional(
            Type.Number({
              description:
                "The challenge variant's consistency limit: the largest share of total profit one day may hold. Accepts a fraction or a percent.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runConsistencyCheck(
          params as ConsistencyCheckParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
