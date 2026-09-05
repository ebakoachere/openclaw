import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_place_order (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response. The BFF gates the
// placement against the owner's autonomous-unlock window SERVER-SIDE: if the
// window is open it accepts/executes the order; otherwise it downgrades the
// request returns execution_status 'downgraded' and stages nothing. The response carries
// accepted_queued / executed / downgraded_to_staged / lock_reason.
//
// NO-NAKED-STOP RULE: stop_loss is MANDATORY at the tool boundary - the agent
// may never place a live order without a protective stop. intended_price is also
// required so the BFF can compute worst-case risk.

export const AGENT_PLACE_ORDER_TOOL_NAME = "agent_place_order";

export type AgentPlaceOrderDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export type AgentPlaceOrderParams = {
  account_id: string;
  symbol: string;
  side: string;
  /**
   * OPTIONAL. Omitted, the platform sizes the order from the account's own Risk
   * Settings page (risk per trade x balance) before the order reaches the broker.
   * Supplied, it is forwarded untouched and overrides that sizing.
   *
   * It is forwarded ONLY when present: the boundary refuses a body that carries
   * both a qty and a risk-budget sizing request, so an `undefined` must not be
   * serialised as a null.
   */
  qty?: string | number;
  stop_loss: string | number;
  intended_price: string | number;
  take_profit?: string | number;
  client_order_id?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_place_order: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runAgentPlaceOrder(
  params: AgentPlaceOrderParams,
  deps: AgentPlaceOrderDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = {
    account_id: params.account_id,
    symbol: params.symbol,
    side: params.side,
    stop_loss: params.stop_loss,
    intended_price: params.intended_price,
  };
  // Forwarded ONLY when supplied, exactly like take_profit below. An absent qty
  // must leave the key OFF the body rather than send null: the platform reads a
  // missing qty as "size this from the account's Risk Settings page", and it
  // refuses a body that tries to say both things at once.
  if (params.qty !== undefined) {
    body.qty = params.qty;
  }
  if (params.take_profit !== undefined) {
    body.take_profit = params.take_profit;
  }
  if (params.client_order_id !== undefined) {
    body.client_order_id = params.client_order_id;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/orders/agent-place`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-agent-place-order",
  name: "VC Trader AI Agent Place Order",
  description:
    "Autonomously place a live order, with a MANDATORY stop-loss, while the account is set to act autonomously. Requires account_id, symbol, side, stop_loss and intended_price. qty is OPTIONAL: omit it and the platform sizes the order from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing. qty is in the BROKER'S OWN units -- LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC) -- never a cash amount; on MT5 a qty of 1 is ONE STANDARD LOT, which for XAUUSD is 100 ounces, so size from the instrument rather than from the number. The account's own unit is named on its Risk Settings page beside 'Max size per trade'. If it is not, the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the account is not currently set to act autonomously, name the lock_reason, and ask them to place it themselves or change the account's execution mode. Never say the action is staged, pending approval or awaiting a card. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full PRE-TRADE risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
  tools: (tool) => [
    tool({
      name: AGENT_PLACE_ORDER_TOOL_NAME,
      label: "Agent Place Order",
      description:
        "Autonomously place a live order, with a MANDATORY stop-loss, while the account is set to act autonomously. Requires account_id, symbol, side, stop_loss and intended_price. qty is OPTIONAL: omit it and the platform sizes the order from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing. qty is in the BROKER'S OWN units -- LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC) -- never a cash amount; on MT5 a qty of 1 is ONE STANDARD LOT, which for XAUUSD is 100 ounces, so size from the instrument rather than from the number. The account's own unit is named on its Risk Settings page beside 'Max size per trade'. If it is not, the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the account is not currently set to act autonomously, name the lock_reason, and ask them to place it themselves or change the account's execution mode. Never say the action is staged, pending approval or awaiting a card. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full PRE-TRADE risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to place the order on.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Instrument symbol to trade (e.g. XAU_USD).",
          minLength: 1,
        }),
        side: Type.String({
          description: "Order side: buy or sell.",
          minLength: 1,
        }),
        qty: Type.Optional(
          Type.Union([Type.String(), Type.Number()], {
            description:
              "OPTIONAL. Omit it to size from the account's Risk Settings page (risk per trade x balance) -- that is the platform's own sizing and the normal way to place an order. Supply it only to override, in the BROKER'S OWN units: LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC). NEVER a cash amount. On MT5 it is never a count of ounces either: qty=1 is one standard lot, which for XAUUSD is 100 ounces, and 0.01 is the usual micro-lot. On a crypto pair it IS the coin count. The platform floors whatever you send to the increment that venue publishes. Confirm the instrument before choosing a number.",
          }),
        ),
        stop_loss: Type.Union([Type.String(), Type.Number()], {
          description: "Protective stop-loss price. MANDATORY - no naked orders.",
        }),
        intended_price: Type.Union([Type.String(), Type.Number()], {
          description: "Intended entry price for worst-case risk computation.",
        }),
        take_profit: Type.Optional(
          Type.Union([Type.String(), Type.Number()], {
            description: "Optional take-profit price.",
          }),
        ),
        client_order_id: Type.Optional(
          Type.String({ description: "Optional client-supplied idempotency id." }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentPlaceOrder(
          params as AgentPlaceOrderParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
