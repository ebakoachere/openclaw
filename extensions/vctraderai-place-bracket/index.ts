import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: place_bracket.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const PLACE_BRACKET_TOOL_NAME = "place_bracket";

export type PlaceBracketDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type PlaceBracketParams = {
  account_id: string;
  symbol: string;
  side: string;
  qty: string;
  stop_loss: string;
  take_profit: string;
  intended_price: string;
  client_order_id?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai place_bracket: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runPlaceBracket(
  params: PlaceBracketParams,
  deps: PlaceBracketDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/orders/agent-place-bracket`, {
    method: "POST",
    body: {
      account_id: params.account_id,
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      stop_loss: params.stop_loss,
      take_profit: params.take_profit,
      intended_price: params.intended_price,
      ...(params.client_order_id === undefined ? {} : { client_order_id: params.client_order_id }),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-place-bracket",
  name: "VC Trader AI Place Bracket",
  description:
    "Publish a bracket entry with a stop-loss AND a take-profit, both mandatory. A success returns accepted_queued, which is NOT executed: a runtime node runs the full pre-trade risk gate and submits to the broker afterwards. Poll the minted idempotency_key for the real outcome and never report a fill from this response.",
  tools: (tool) => [
    tool({
      name: PLACE_BRACKET_TOOL_NAME,
      label: "Place Bracket",
      description:
        "Publish a bracket entry with a stop-loss AND a take-profit, both mandatory. A success returns accepted_queued, which is NOT executed: a runtime node runs the full pre-trade risk gate and submits to the broker afterwards. Poll the minted idempotency_key for the real outcome and never report a fill from this response.",
      parameters: Type.Object({
        account_id: Type.String({ description: "Live account id to place on.", minLength: 1 }),
        symbol: Type.String({ description: "Instrument symbol.", minLength: 1 }),
        side: Type.String({ description: "BUY or SELL.", minLength: 1 }),
        qty: Type.String({
          description: "Order quantity as a decimal STRING, in the broker own volume units.",
          minLength: 1,
        }),
        stop_loss: Type.String({
          description: "Stop-loss price as a decimal STRING. MANDATORY.",
          minLength: 1,
        }),
        take_profit: Type.String({
          description: "Take-profit price as a decimal STRING. MANDATORY.",
          minLength: 1,
        }),
        intended_price: Type.String({
          description: "Intended entry price as a decimal STRING.",
          minLength: 1,
        }),
        client_order_id: Type.Optional(
          Type.String({ description: "Optional caller-supplied correlation id.", minLength: 1 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runPlaceBracket(
          params as PlaceBracketParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
