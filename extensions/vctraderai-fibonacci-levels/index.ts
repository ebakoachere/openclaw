import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: fibonacci_levels (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/fibonacci as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const FIBONACCI_LEVELS_TOOL_NAME = "fibonacci_levels";

export type FibonacciLevelsParams = {
  high: number;
  low: number;
  direction?: string;
  retracement_ratios?: number[];
  extension_ratios?: number[];
};

export type FibonacciLevelsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai fibonacci_levels: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runFibonacciLevels(
  params: FibonacciLevelsParams,
  deps: FibonacciLevelsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = { high: params.high, low: params.low };
  const directionValue =
    typeof params.direction === "string" && params.direction.length > 0
      ? params.direction
      : undefined;
  if (directionValue !== undefined) {
    body.direction = directionValue;
  }
  if (Array.isArray(params.retracement_ratios)) {
    body.retracement_ratios = params.retracement_ratios;
  }
  if (Array.isArray(params.extension_ratios)) {
    body.extension_ratios = params.extension_ratios;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/fibonacci`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-fibonacci-levels",
  name: "VC Trader AI Fibonacci Levels",
  description: "Workspace-scoped read: retracement and extension levels between two price anchors.",
  tools: (tool) => [
    tool({
      name: FIBONACCI_LEVELS_TOOL_NAME,
      label: "Fibonacci Levels",
      description:
        "Retracement and extension levels between two price anchors. Read-only. Returns each level with its ratio and price, the range, and anchors_swapped when the two anchors arrived the other way round. Honesty: the ratios are an input with conventional defaults rather than a fixed list, because which ratios a desk uses is a convention. Two identical anchors are declined -- the move has no range to divide. Refusals: out_of_domain, operand one of high/low, direction, retracement_ratios, extension_ratios.",
      parameters: Type.Object(
        {
          high: Type.Number({ description: "One anchor of the move." }),
          low: Type.Number({ description: "The other anchor of the move." }),
          direction: Type.Optional(
            Type.String({
              description:
                "Which way the move ran: up (default) or down. It decides which end retracements count from, never which anchors are used.",
            }),
          ),
          retracement_ratios: Type.Optional(
            Type.Array(Type.Number(), {
              description: "Override the conventional retracement ratios.",
            }),
          ),
          extension_ratios: Type.Optional(
            Type.Array(Type.Number(), {
              description: "Override the conventional extension ratios.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runFibonacciLevels(
          params as FibonacciLevelsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
