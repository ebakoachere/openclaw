import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_orders.
//
// READ_ONLY per propfirm_manager ADR 0078. GET /live/orders is NOT a broker
// read-back for a prop-firm/MT5 account: ProviderAwareLiveReadRepository serves
// the live venue only for an Alpaca Paper anchor and otherwise delegates to
// DbLiveReadRepository, whose list_broker_orders is a plain SELECT over the
// platform's own execution_router.orders (state IN NEW/PLACING/PLACED). The
// symbol/quantity/stop/target it returns are the router-recorded OrderIntent,
// written once at insert; the only UPDATE on that table sets state,
// executed_price and updated_at, so those four fields are never refreshed from
// the venue and cannot verify what the broker actually applied.

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
    "Read-only workspace-scoped tool: working orders for a live account, read from the platform's own order ledger (not a broker read).",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_ORDERS_TOOL_NAME,
      label: "List Live Orders",
      description:
        "Working orders (NEW/PLACING/PLACED) for a live account, read from the platform's own order ledger, not from the venue. Filled, rejected and cancelled orders are absent, so an empty list is not proof an order never reached the broker. symbol, qty, protective_stop_price and target_price are the intent the router recorded when it accepted the order and are never refreshed from the broker, so they cannot confirm the venue applied them; only `status` is written back from the broker response. For the stop/target actually resting at the venue use list_live_positions (sl/tp on rows with source='broker'). READ_ONLY per ADR 0078.",
      parameters: Type.Object({
        account_id: Type.String({
          description:
            "Live account id; list_live_accounts_for_deployment returns these as rows[].live_account_id.",
          minLength: 1,
        }),
        limit: Type.Optional(
          Type.Integer({
            description:
              "Maximum orders to return (default 50). Over 200 the API returns HTTP 422.",
            minimum: 1,
            maximum: 200,
          }),
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
