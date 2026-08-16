import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_orders.
//
// READ_ONLY per propfirm_manager ADR 0078. This is the broker-authoritative
// read-back: Agent Alpha uses it to verify symbol, quantity, stop, and target
// at the venue after the governed router accepts an order.

export const LIST_LIVE_ORDERS_TOOL_NAME = "list_live_orders";

export type ListLiveOrdersDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

export type ListLiveOrdersParams = {
  account_id: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_live_orders: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListLiveOrders(
  params: ListLiveOrdersParams,
  deps: ListLiveOrdersDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/orders`, {
    query: {
      account_id: params.account_id,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-live-orders",
  name: "VC Trader AI List Live Orders",
  description:
    "Read-only workspace-scoped tool: List broker-authoritative live orders, including stop and target protection.",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_ORDERS_TOOL_NAME,
      label: "List Live Orders",
      description:
        "List broker-authoritative live orders. Use this to verify the governed order's symbol, quantity, stop, and target at the venue. READ_ONLY per ADR 0078.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read broker orders for.",
          minLength: 1,
        }),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum orders to return.", minimum: 1, maximum: 500 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListLiveOrders(
          params as ListLiveOrdersParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
