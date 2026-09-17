import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: swap_facts (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/swap-facts as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const SWAP_FACTS_TOOL_NAME = "swap_facts";

export type SwapFactsParams = { account_id: string; symbol: string };

export type SwapFactsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai swap_facts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runSwapFacts(
  params: SwapFactsParams,
  deps: SwapFactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const symbol = nonEmpty(params.symbol);
  if (accountId === undefined) {
    throw new Error("vctraderai swap_facts: account_id is required");
  }
  if (symbol === undefined) {
    throw new Error("vctraderai swap_facts: symbol is required");
  }
  const body: Record<string, unknown> = { account_id: accountId, symbol };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/swap-facts`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-swap-facts",
  name: "VC Trader AI Swap Facts",
  description:
    "Workspace-scoped read: the broker's own overnight swap figures for one symbol on one account.",
  tools: (tool) => [
    tool({
      name: SWAP_FACTS_TOOL_NAME,
      label: "Swap Facts",
      description:
        "The broker's own overnight swap figures for one symbol on one account: the long and short rates, the swap MODE that says what unit they are in, the venue's triple-swap weekday, the rollover hour and the expert's own timestamp. Read-only. Honesty: it declines to turn these into an overnight cost, and the reason is sharper than for margin -- the swap modes differ in UNIT rather than merely in formula, so the same figure is points, a percentage, the symbol's currency or an interest rate depending on the mode, and the terminal exposes no calculation for swap the way it does for margin. The rates and the mode are reported so a caller that knows its venue's convention can apply it; the platform does not choose one. The overnight block always carries overnight_charge_not_modelled.",
      parameters: Type.Object(
        {
          account_id: Type.String({
            description: "The account whose broker catalogue to read.",
          }),
          symbol: Type.String({
            description: "Broker symbol exactly as the terminal names it.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSwapFacts(
          params as SwapFactsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
