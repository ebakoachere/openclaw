import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_fresh_candles.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// THE NAME OVERPROMISES. `/live/candles` serves a set from ONE OF THREE places
// -- a broker fetch, this process's short-lived cache, or the node's warm
// session feed -- and the envelope carries `source` and `age_seconds` saying
// which and how old. The description must send the model to those two fields
// rather than to the tool's name, or a cached set gets read out as live. The
// tool NAME is a cross-repo contract (the allowlist, the gate, the parity
// list) and is deliberately left alone; only what the model is TOLD changes.

export const GET_FRESH_CANDLES_TOOL_NAME = "get_fresh_candles";

export type GetFreshCandlesDeps = {
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

export type GetFreshCandlesParams = {
  account_id: string;
  symbol: string;
  timeframe?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_fresh_candles: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetFreshCandles(
  params: GetFreshCandlesParams,
  deps: GetFreshCandlesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/candles`, {
    query: {
      account_id: params.account_id,
      symbol: params.symbol,
      timeframe: params.timeframe !== undefined ? params.timeframe : "1h",
      limit: params.limit !== undefined ? String(params.limit) : "100",
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-fresh-candles",
  name: "VC Trader AI Get Fresh Candles",
  description:
    "Read-only workspace-scoped tool: Fresh historical candles for a symbol directly from the live broker via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_FRESH_CANDLES_TOOL_NAME,
      label: "Get Fresh Candles",
      description:
        'Historical candles for a symbol from the live broker read path (not the stale daily batch). NOT ALWAYS A FRESH FETCH, and the payload says so: read its `source` and `age_seconds`, which are authoritative. `source` is "broker" (fetched just now, age_seconds 0), "cache" (a set this same process fetched moments ago) or "warm" (the node session feed); `age_seconds` is how old the SET is. State the age if it is not 0 and never describe the bars as live without checking those two fields. Required: symbol, account_id. Optional: timeframe (e.g. 1m/1h/1d, default 1h), limit (default 100, max 1000).',
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id to read candles for.",
          minLength: 1,
        }),
        symbol: Type.String({
          description: "Symbol to read candles for, e.g. EURUSD or XAUUSD.",
          minLength: 1,
        }),
        timeframe: Type.Optional(
          Type.String({ description: "Candle timeframe, e.g. 1m/1h/1d. Default 1h." }),
        ),
        limit: Type.Optional(
          Type.Integer({ description: "Maximum candles to return.", minimum: 1, maximum: 1000 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetFreshCandles(
          params as GetFreshCandlesParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
