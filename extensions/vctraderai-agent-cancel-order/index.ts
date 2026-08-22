import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_cancel_order (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response. The BFF gates the
// cancel against the owner's autonomous-unlock window SERVER-SIDE: if the window
// is open it accepts/executes the cancel; otherwise it returns 200 with
// execution_status 'downgraded' and writes NOTHING. The field is named
// downgraded_to_staged, but no staged card is created and none can be: the
// only staged-card route requires PROPOSE_ONLY + a staged_action, and this
// tool is EXECUTE / None (403 openclaw_tool_not_propose_only). The response
// carries accepted_queued / executed / downgraded_to_staged / lock_reason.

export const AGENT_CANCEL_ORDER_TOOL_NAME = "agent_cancel_order";

export type AgentCancelOrderDeps = {
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

export type AgentCancelOrderParams = {
  account_id: string;
  order_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_cancel_order: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runAgentCancelOrder(
  params: AgentCancelOrderParams,
  deps: AgentCancelOrderDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/orders/${params.order_id}/agent-cancel`, {
    method: "POST",
    body: { account_id: params.account_id },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-agent-cancel-order",
  name: "VC Trader AI Agent Cancel Order",
  description:
    "Autonomously cancel a live working order while the owner's autonomous-unlock window is open. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. A cancel that does not go through leaves the order LIVE and still able to fill.",
  tools: (tool) => [
    tool({
      name: AGENT_CANCEL_ORDER_TOOL_NAME,
      label: "Agent Cancel Order",
      description:
        "Autonomously cancel a live working order while the owner's autonomous-unlock window is open. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. A cancel that does not go through leaves the order LIVE and still able to fill.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the order.",
          minLength: 1,
        }),
        order_id: Type.String({
          description: "Live working order id to cancel.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentCancelOrder(
          params as AgentCancelOrderParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
