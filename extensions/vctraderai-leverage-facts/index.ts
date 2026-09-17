import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: leverage_facts (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/leverage-facts as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const LEVERAGE_FACTS_TOOL_NAME = "leverage_facts";

export type LeverageFactsParams = { account_id: string; symbol: string };

export type LeverageFactsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai leverage_facts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runLeverageFacts(
  params: LeverageFactsParams,
  deps: LeverageFactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const symbol = nonEmpty(params.symbol);
  if (accountId === undefined) {
    throw new Error("vctraderai leverage_facts: account_id is required");
  }
  if (symbol === undefined) {
    throw new Error("vctraderai leverage_facts: symbol is required");
  }
  const body: Record<string, unknown> = { account_id: accountId, symbol };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/leverage-facts`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-leverage-facts",
  name: "VC Trader AI Leverage Facts",
  description:
    "Workspace-scoped read: whether an account's venue lends against an instrument at all.",
  tools: (tool) => [
    tool({
      name: LEVERAGE_FACTS_TOOL_NAME,
      label: "Leverage Facts",
      description:
        "Whether an account's venue lends against an instrument at all. Returns the size unit the venue prices the order in, the leverage ceiling that unit implies, and whether the venue lends. Read-only. Honesty: the verdict is keyed on how the venue SIZES the order and never on an asset-class label, because a spot purchase has no margin loan to have on any venue while a CFD on the same underlying is legitimately leveraged and must not be tightened -- a label cannot tell those apart. A null ceiling means this rule says nothing and the account's own leverage stands; it does not mean unlimited. The account's own leverage figure is declined with operand_missing:account_leverage, because no read on this surface reports it.",
      parameters: Type.Object(
        {
          account_id: Type.String({
            description: "The account whose venue decides whether it lends.",
          }),
          symbol: Type.String({
            description: "Broker symbol exactly as the terminal names it.",
          }),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runLeverageFacts(
          params as LeverageFactsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
