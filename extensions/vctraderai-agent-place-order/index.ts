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
  qty: string | number;
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
    qty: params.qty,
    stop_loss: params.stop_loss,
    intended_price: params.intended_price,
  };
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
    "Autonomously place a live order, with a MANDATORY stop-loss, while the owner's autonomous-unlock window is open. Requires account_id, symbol, side, qty, stop_loss and intended_price. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full 25-check risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled.",
  tools: (tool) => [
    tool({
      name: AGENT_PLACE_ORDER_TOOL_NAME,
      label: "Agent Place Order",
      description:
        "Autonomously place a live order, with a MANDATORY stop-loss, while the owner's autonomous-unlock window is open. Requires account_id, symbol, side, qty, stop_loss and intended_price. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. On success the boundary PUBLISHES the intent onto the workspace command queue and returns execution_status 'published_pending' with an idempotency_key -- that is NOT a fill. The node runs the full 25-check risk gate and submits to the broker afterwards, so confirm the real terminal outcome with get_order_outcome(idempotency_key=...) before telling the owner anything filled.",
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
        qty: Type.Union([Type.String(), Type.Number()], {
          description: "Order quantity / volume.",
        }),
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
