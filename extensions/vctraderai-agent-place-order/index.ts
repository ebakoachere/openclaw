import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_place_order (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response.
//
// W19 LIVE-CLOSE (platform PR #1864): a place in MANUAL mode is STAGED as a
// one-click approval card -- a real openclaw.staged_actions row, whose id comes
// back as staged_action_id with execution_status 'staged_for_approval'. This
// description used to say the opposite, in these words: "There is no card, no
// queue entry and no pending approval anywhere ... Never say the action is
// staged, pending approval or awaiting a card." That was true when it was
// written and became false when Task 18 added the staging arm, so the model was
// being INSTRUCTED to deny an approval card that existed. On 2026-09-09 an
// order really was waiting on the owner's card and was relayed to him as a flat
// refusal.
//
// A true refusal (an emergency brake) returns execution_status 'refused' with a
// lock_reason and stages nothing; downgraded_to_staged is now FALSE everywhere.
// Read execution_status and next_step, never the flag.
//
// The response carries accepted_queued / executed / execution_status /
// lock_reason / staged_action_id / next_step.
//
// NO-NAKED-STOP RULE (D-W17-9): stop_loss is REQUIRED for every order the
// platform holds a stop for, and the PLATFORM decides which those are - this tool
// knows the account's id, not its venue. Omitting stop_loss is only accepted on a
// venue that holds no stop for the instrument anyway (an Alpaca crypto pair); the
// boundary refuses it BY NAME everywhere else and nothing is placed. Send
// risk_basis="notional" with the omission so the owner's choice is recorded rather
// than inferred. intended_price stays required so the BFF can compute worst-case
// risk - for a notional order that worst case is the WHOLE position.

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
  stop_loss?: string | number;
  intended_price: string | number;
  take_profit?: string | number;
  client_order_id?: string;
  risk_basis?: "at_risk" | "notional";
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
    intended_price: params.intended_price,
  };
  // Forwarded ONLY when supplied, exactly like qty and take_profit below. A
  // stopless order must leave the key OFF the body rather than send null: the
  // boundary's schema makes stop_loss optional and its venue policy decides
  // whether the absence is allowed, so a null would be a second way to say the
  // same thing.
  if (params.stop_loss !== undefined) {
    body.stop_loss = params.stop_loss;
  }
  if (params.risk_basis !== undefined) {
    body.risk_basis = params.risk_basis;
  }
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
    "Autonomously place a live order while the account is set to act autonomously. Requires account_id, symbol, side and intended_price, and normally a protective stop_loss. NEVER INVENT A STOP: if the owner asks for a size with no stop, omit stop_loss and send risk_basis 'notional' (the whole position is the risk). The platform allows that only where the venue holds no stop for the instrument anyway - a crypto pair on Alpaca - and refuses it by name everywhere else, placing nothing; relay that refusal as itself. With a stop, send risk_basis 'at_risk' (the size follows the stop distance). On a venue that does not hold the stop it is recorded as advisory: it sizes the trade and does not protect it, and the owner's approval card says so. qty is OPTIONAL: omit it and the platform sizes the order from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing. qty is in the BROKER'S OWN units -- LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC) -- never a cash amount; on MT5 a qty of 1 is ONE STANDARD LOT, which for XAUUSD is 100 ounces, so size from the instrument rather than from the number. The account's own unit is named on its Risk Settings page beside 'Max size per trade'. IF IT IS NOT, THE ORDER IS STAGED AS AN APPROVAL CARD, NOT REFUSED: it returns execution_status 'staged_for_approval' with a real staged_action_id and an expiry. Tell the owner a card is waiting, name the instrument and side, and say it expires; the order goes to the broker when they approve it. Read the card's state with get_staged_action(staged_action_id=...) -- proposed means still waiting, applied means the owner approved it and the platform submitted it (which is NOT yet a fill: take target_decision_id to get_order_outcome for that), rejected and expired mean it will not fill. Do NOT re-place a staged order and never describe it as refused, blocked or failed: a second card for one intent is a hazard, because the owner can approve one while the other is still live. A GENUINE refusal is a different answer and looks different: execution_status 'refused', a lock_reason, no staged_action_id, and nothing staged anywhere -- that happens on an emergency brake (a durable HALT, a closed live-execution gate, revoked consent, or the pre-trade circuit breaker), and you should relay the lock_reason as written. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full PRE-TRADE risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
  tools: (tool) => [
    tool({
      name: AGENT_PLACE_ORDER_TOOL_NAME,
      label: "Agent Place Order",
      description:
        "Autonomously place a live order while the account is set to act autonomously. Requires account_id, symbol, side and intended_price, and normally a protective stop_loss. NEVER INVENT A STOP: if the owner asks for a size with no stop, omit stop_loss and send risk_basis 'notional' (the whole position is the risk). The platform allows that only where the venue holds no stop for the instrument anyway - a crypto pair on Alpaca - and refuses it by name everywhere else, placing nothing; relay that refusal as itself. With a stop, send risk_basis 'at_risk' (the size follows the stop distance). On a venue that does not hold the stop it is recorded as advisory: it sizes the trade and does not protect it, and the owner's approval card says so. qty is OPTIONAL: omit it and the platform sizes the order from the account's own Risk Settings page (risk per trade x balance), which is the normal way to place one; supply it only to override that sizing. qty is in the BROKER'S OWN units -- LOTS on MT5, SHARES on an Alpaca equity or ETF, and the BASE ASSET itself on a crypto pair (on BTC/USD a qty of 0.01 is 0.01 BTC) -- never a cash amount; on MT5 a qty of 1 is ONE STANDARD LOT, which for XAUUSD is 100 ounces, so size from the instrument rather than from the number. The account's own unit is named on its Risk Settings page beside 'Max size per trade'. IF IT IS NOT, THE ORDER IS STAGED AS AN APPROVAL CARD, NOT REFUSED: it returns execution_status 'staged_for_approval' with a real staged_action_id and an expiry. Tell the owner a card is waiting, name the instrument and side, and say it expires; the order goes to the broker when they approve it. Read the card's state with get_staged_action(staged_action_id=...) -- proposed means still waiting, applied means the owner approved it and the platform submitted it (which is NOT yet a fill: take target_decision_id to get_order_outcome for that), rejected and expired mean it will not fill. Do NOT re-place a staged order and never describe it as refused, blocked or failed: a second card for one intent is a hazard, because the owner can approve one while the other is still live. A GENUINE refusal is a different answer and looks different: execution_status 'refused', a lock_reason, no staged_action_id, and nothing staged anywhere -- that happens on an emergency brake (a durable HALT, a closed live-execution gate, revoked consent, or the pre-trade circuit breaker), and you should relay the lock_reason as written. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full PRE-TRADE risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled. THREE OUTCOMES THAT ARE NOT FAILURES OF YOURS, and must be relayed as themselves rather than as a generic error: place_route_undetermined (503) means the platform could not tell which execution path owns this account, so it refused rather than guessing; account_not_live_capable (409) means the account is not configured for live orders at all, which no retry fixes; place_simulated_unexpectedly (503) means a path that should have been live returned a simulated fill, and the order was refused rather than reported as real. Say which one happened and what it means; never collapse them into one failure.",
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
        stop_loss: Type.Optional(
          Type.Union([Type.String(), Type.Number()], {
            description:
              "Protective stop-loss price. Required for every order the venue holds a stop for - which is every account except a crypto pair on Alpaca. OMIT IT rather than inventing a number when the owner asks for a size with no stop, and send risk_basis 'notional' with the omission. The platform refuses the omission by name where it does not apply, and places nothing.",
          }),
        ),
        risk_basis: Type.Optional(
          Type.Union([Type.Literal("at_risk"), Type.Literal("notional")], {
            description:
              "Which reading of a percent-risk instruction the OWNER chose. 'at_risk' sizes from the stop distance (send a stop_loss). 'notional' means no stop and the whole position is the risk (omit stop_loss). Ask him which he means rather than choosing one; the answer is recorded on the order's own ledger row.",
          }),
        ),
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
