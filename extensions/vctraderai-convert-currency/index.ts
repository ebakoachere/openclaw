import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: convert_currency (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/convert-currency as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.

export const CONVERT_CURRENCY_TOOL_NAME = "convert_currency";

export type ConvertCurrencyParams = { account_id: string; symbol: string; provider?: string };

export type ConvertCurrencyDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai convert_currency: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runConvertCurrency(
  params: ConvertCurrencyParams,
  deps: ConvertCurrencyDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const symbol = nonEmpty(params.symbol);
  if (accountId === undefined) {
    throw new Error("vctraderai convert_currency: account_id is required");
  }
  if (symbol === undefined) {
    throw new Error("vctraderai convert_currency: symbol is required");
  }
  const body: Record<string, unknown> = { account_id: accountId, symbol };
  const providerValue = nonEmpty(params.provider);
  if (providerValue !== undefined) {
    body.provider = providerValue;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/convert-currency`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-convert-currency",
  name: "VC Trader AI Convert Currency",
  description:
    "Workspace-scoped read: whether an instrument's profit and loss reaches an account's own currency.",
  tools: (tool) => [
    tool({
      name: CONVERT_CURRENCY_TOOL_NAME,
      label: "Convert Currency",
      description:
        "Whether an instrument's profit and loss reaches an account's own currency. Returns kind -- identity when the quote currency IS the account's, with rate 1.0; inverse_of_price when the account currency is the instrument's base, where the rate is one over that instrument's own price and no second series is needed; or unresolved -- plus the three currencies, currency_source and a conversion block. Read-only. Honesty: the account currency is the one the broker terminal reports for that account and is never assumed to be dollars; an unresolved conversion carries no rate at all rather than a substituted 1.0, and names the exact currency pair the platform does not hold; inverse_of_price carries no rate either, because the price belongs to the caller. Use it before comparing any figure denominated in an instrument's quote currency against an account limit. Refusals in conversion -- operand_missing:account_currency, operand_missing:quote_currency, conversion_unresolved whose operand is the pair -- are the answer; pass them through.",
      parameters: Type.Object(
        {
          account_id: Type.String({
            description: "The account whose deposit currency is the conversion target.",
          }),
          symbol: Type.String({
            description: "Broker symbol exactly as the terminal names it.",
          }),
          provider: Type.Optional(
            Type.String({
              description: "Market-data provider for catalogue economics resolution.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runConvertCurrency(
          params as ConvertCurrencyParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
