import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: risk_gate_preview (pre-trade risk-gate dry run).
//
// Calls the workspace-scoped risk/gate-preview endpoint as the workspace owner
// (PFM_AGENT_TOKEN) to dry-run the real 14-check pre-trade risk gate for a
// hypothetical order and return the per-check pass/fail matrix plus the blocking
// check. This is a POST with a JSON body, mirroring the research/fetch template
// it is derived from.

export const RISK_GATE_PREVIEW_TOOL_NAME = "risk_gate_preview";

export type RiskGatePreviewDeps = {
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

export type RiskGatePreviewParams = {
  account_id: string;
  instrument: string;
  direction: string;
  strategy_id?: string;
  entry_price?: number;
  stop_loss_price?: number;
  take_profit_price?: number;
  quantity?: number;
  market_mid?: number;
  account_status?: string;
  strategy_symbol_allowlist?: string[];
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai risk_gate_preview: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runRiskGatePreview(
  params: RiskGatePreviewParams,
  deps: RiskGatePreviewDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const instrument = nonEmpty(params.instrument);
  const direction = nonEmpty(params.direction);
  // Required fields; the BFF returns 400 otherwise. Guard here so a malformed
  // call fails fast with a clear message instead of a 400.
  if (accountId === undefined) {
    throw new Error("vctraderai risk_gate_preview: account_id is required");
  }
  if (instrument === undefined) {
    throw new Error("vctraderai risk_gate_preview: instrument is required");
  }
  if (direction === undefined) {
    throw new Error("vctraderai risk_gate_preview: direction is required");
  }
  // Build the request body from all declared params that are present; omit
  // undefined optionals so the BFF sees only the fields the caller supplied.
  const body: Record<string, unknown> = {
    account_id: accountId,
    instrument,
    direction,
  };
  const strategyId = nonEmpty(params.strategy_id);
  if (strategyId !== undefined) {
    body.strategy_id = strategyId;
  }
  if (typeof params.entry_price === "number") {
    body.entry_price = params.entry_price;
  }
  if (typeof params.stop_loss_price === "number") {
    body.stop_loss_price = params.stop_loss_price;
  }
  if (typeof params.take_profit_price === "number") {
    body.take_profit_price = params.take_profit_price;
  }
  if (typeof params.quantity === "number") {
    body.quantity = params.quantity;
  }
  if (typeof params.market_mid === "number") {
    body.market_mid = params.market_mid;
  }
  const accountStatus = nonEmpty(params.account_status);
  if (accountStatus !== undefined) {
    body.account_status = accountStatus;
  }
  if (Array.isArray(params.strategy_symbol_allowlist)) {
    body.strategy_symbol_allowlist = params.strategy_symbol_allowlist;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/gate-preview`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-risk-gate-preview",
  name: "VC Trader AI Risk Gate Preview",
  description:
    "Workspace-scoped tool: dry-run the real 14-check pre-trade risk gate for a hypothetical order via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). Returns the per-check pass/fail matrix + the blocking check.",
  tools: (tool) => [
    tool({
      name: RISK_GATE_PREVIEW_TOOL_NAME,
      label: "Risk Gate Preview",
      description:
        'Dry-run the 14 pre-trade risk-gate checks against a hypothetical order and see EVERY check at once instead of only the first rejection. Provide account_id, instrument and direction; optionally strategy_id, entry_price, stop_loss_price, take_profit_price, quantity, market_mid, account_status and strategy_symbol_allowlist. Nothing is executed. TWO THINGS A PASS DOES NOT MEAN. (1) Unless you pass market_mid, the preview builds its quote FROM YOUR OWN entry_price, so the price-sanity deviation is exactly zero by construction for any symbol at any price -- that check carries no information at all, and an APPROVE on it is not evidence your price is sane. Pass market_mid to make it mean something. (2) Every other reader is a permissive fresh-account stub, so the caps arithmetic shows the SHAPE of the gate, not the verdict your live account state would produce. Use it for order shape and for which check name fires first; never relay it as "the gate approved this".',
      parameters: Type.Object({
        account_id: Type.String({
          description: "The account id the hypothetical order would run against.",
        }),
        instrument: Type.String({
          description: "The instrument symbol for the hypothetical order (e.g. EUR_USD).",
        }),
        direction: Type.String({
          description: "The order direction (e.g. buy or sell / long or short).",
        }),
        strategy_id: Type.Optional(
          Type.String({
            description: "Optional strategy id the hypothetical order belongs to.",
          }),
        ),
        entry_price: Type.Optional(Type.Number({ description: "Optional intended entry price." })),
        stop_loss_price: Type.Optional(Type.Number({ description: "Optional stop-loss price." })),
        take_profit_price: Type.Optional(
          Type.Number({ description: "Optional take-profit price." }),
        ),
        quantity: Type.Optional(
          Type.Number({ description: "Optional order quantity, in the BROKER'S OWN volume units -- LOTS on MT5, SHARES on Alpaca. Not a cash amount. The caps arithmetic is only as meaningful as this number." }),
        ),
        market_mid: Type.Optional(
          Type.Number({
            description:
              "Current market mid price. WITHOUT it the preview centres its quote on YOUR OWN entry_price, so the price-sanity deviation is exactly zero by construction and that check tells you nothing. Supply a real mid whenever you have one.",
          }),
        ),
        account_status: Type.Optional(
          Type.String({ description: "Optional account status to evaluate the gate against." }),
        ),
        strategy_symbol_allowlist: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional list of symbols the strategy is allowed to trade.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRiskGatePreview(
          params as RiskGatePreviewParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
