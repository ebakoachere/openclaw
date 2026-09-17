import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: drawdown_facts (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/drawdown as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const DRAWDOWN_FACTS_TOOL_NAME = "drawdown_facts";

export type DrawdownFactsParams = { equity: number[] };

export type DrawdownFactsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai drawdown_facts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runDrawdownFacts(
  params: DrawdownFactsParams,
  deps: DrawdownFactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = { equity: params.equity };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/drawdown`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-drawdown-facts",
  name: "VC Trader AI Drawdown Facts",
  description: "Workspace-scoped read: peak-to-trough and current drawdown over an equity series.",
  tools: (tool) => [
    tool({
      name: DRAWDOWN_FACTS_TOOL_NAME,
      label: "Drawdown Facts",
      description:
        "Peak-to-trough and current drawdown over an equity series. Read-only; no account and no instrument. Returns the maximum drawdown in absolute and percentage terms, the current drawdown, the peak and trough and their positions in the series, whether the account recovered to that peak afterwards, and the number of observations. Honesty: the observation count is reported because a drawdown over three points looks identical to one over three thousand, and a series too short to describe a peak and a trough is declined rather than answered. The measures describe the series as given -- daily closes in, daily-close drawdown out. Refusals: operand_missing:equity, insufficient_sample, out_of_domain.",
      parameters: Type.Object(
        {
          equity: Type.Array(Type.Number(), {
            description:
              "Account values in one currency, oldest first. At least three, because two points can only describe one move.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runDrawdownFacts(
          params as DrawdownFactsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
