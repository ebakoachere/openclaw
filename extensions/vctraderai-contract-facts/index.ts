import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: contract_facts (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/contract-facts as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const CONTRACT_FACTS_TOOL_NAME = "contract_facts";

export type ContractFactsParams = { account_id: string; symbol: string };

export type ContractFactsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai contract_facts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runContractFacts(
  params: ContractFactsParams,
  deps: ContractFactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const symbol = nonEmpty(params.symbol);
  if (accountId === undefined) {
    throw new Error("vctraderai contract_facts: account_id is required");
  }
  if (symbol === undefined) {
    throw new Error("vctraderai contract_facts: symbol is required");
  }
  const body: Record<string, unknown> = { account_id: accountId, symbol };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/contract-facts`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-contract-facts",
  name: "VC Trader AI Contract Facts",
  description:
    "Workspace-scoped read: what one lot IS for a symbol on an account's venue, from the executing broker's own symbol block.",
  tools: (tool) => [
    tool({
      name: CONTRACT_FACTS_TOOL_NAME,
      label: "Contract Facts",
      description:
        "What one lot is for a symbol on an account's venue, read from the executing broker's own symbol block. Returns contract size, volume min/step/max, digits, point, tick size, tick value and its currency, plus value_per_point_per_lot -- the money one point moves on one lot. Read-only. It takes an account and never a bare symbol, because the venue decides these figures and an account resolves to exactly one venue by a row that exists. Honesty: nothing is derived from reference data; a zero is a real figure while null means the terminal did not send it; value_per_point_per_lot is null with value_per_point_operands_missing naming the gap whenever an operand is absent; and no pip value is reported at all -- a pip is a naming convention over points rather than a broker figure, so the tool reports the point size and declines to name a pip. The pip_value block always carries model_not_implemented:pip_convention; pass it through as the answer it is.",
      parameters: Type.Object(
        {
          account_id: Type.String({
            description:
              "The account whose venue decides these figures. Anchor, live, WDBA or broker-terminal id.",
          }),
          symbol: Type.String({
            description: "Broker symbol exactly as the terminal names it.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runContractFacts(
          params as ContractFactsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
