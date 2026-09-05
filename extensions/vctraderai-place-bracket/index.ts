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
  /**
   * OPTIONAL. Omitted, the platform sizes the order from the account's own Risk
   * Settings page (risk per trade x balance). Supplied, it is forwarded
   * untouched and overrides that sizing.
   *
   * Forwarded ONLY when present: the boundary refuses a body that carries both a
   * qty and a risk-budget sizing request, so an `undefined` must not become a null.
   */
  qty?: string;
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
      // Forwarded ONLY when supplied, in the same idiom client_order_id uses
      // below. An absent qty must leave the key OFF the body rather than send
      // null: the platform reads a missing qty as "size this from the account's
      // Risk Settings page", and refuses a body that says both things at once.
      ...(params.qty === undefined ? {} : { qty: params.qty }),
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
    "Publish a bracket entry with a stop-loss AND a take-profit, both mandatory. qty is OPTIONAL: omit it and the platform sizes the bracket from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing, in the broker's own units (LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC)). A success returns accepted_queued, which is NOT executed: a runtime node runs the full pre-trade risk gate and submits to the broker afterwards. Poll the minted idempotency_key for the real outcome and never report a fill from this response. If the autonomous-unlock window is CLOSED the call does NOT go through and NOTHING is staged for approval: it returns downgraded_to_staged true with a lock_reason, and there is no card, no queue entry and no pending approval anywhere. Tell the owner the window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged or awaiting approval. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
  tools: (tool) => [
    tool({
      name: PLACE_BRACKET_TOOL_NAME,
      label: "Place Bracket",
      description:
        "Publish a bracket entry with a stop-loss AND a take-profit, both mandatory. qty is OPTIONAL: omit it and the platform sizes the bracket from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing, in the broker's own units (LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC)). A success returns accepted_queued, which is NOT executed: a runtime node runs the full pre-trade risk gate and submits to the broker afterwards. Poll the minted idempotency_key for the real outcome and never report a fill from this response. If the autonomous-unlock window is CLOSED the call does NOT go through and NOTHING is staged for approval: it returns downgraded_to_staged true with a lock_reason, and there is no card, no queue entry and no pending approval anywhere. Tell the owner the window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged or awaiting approval. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
      parameters: Type.Object({
        account_id: Type.String({ description: "Live account id to place on.", minLength: 1 }),
        symbol: Type.String({ description: "Instrument symbol.", minLength: 1 }),
        side: Type.String({ description: "BUY or SELL.", minLength: 1 }),
        qty: Type.Optional(
          Type.String({
            description:
              "OPTIONAL. Omit it to size from the account's Risk Settings page (risk per trade x balance) -- that is the platform's own sizing and the normal way to place a bracket. Supply it only to override, as a decimal STRING in the BROKER'S OWN volume units: LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC). On MT5 a qty of 1 is one standard lot -- for XAUUSD that is 100 ounces. The platform floors whatever you send to the increment that venue publishes.",
            minLength: 1,
          }),
        ),
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
