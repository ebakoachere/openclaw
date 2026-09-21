import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: margin_facts (trader calculation suite).
//
// POSTs /api/v1/workspaces/{ws}/risk/margin-facts as the workspace owner
// (PFM_AGENT_TOKEN). REFUSALS ARE DATA: the platform answers 200 with a
// {computed:false, refusal, operand, reason} block when an operand is missing,
// and that is a successful call. This plugin never retries one, never
// rewrites `reason`, and never converts one into an error -- several carry the
// venue's own words out verbatim, which are the most useful sentences on the
// surface.
//
// THE PLUGIN'S BOUND SITS ABOVE THE SERVER'S. `requirement.bound_seconds` is
// the server-side ceiling on the terminal round trip (20 s). The broker
// timeouts on this platform NEST INWARD, and a client that gives up first
// turns a clean, explanatory refusal into an opaque abort -- which is exactly
// how the broker chart surface failed. 30 s is deliberately above it.

export const MARGIN_FACTS_TOOL_NAME = "margin_facts";

export type MarginFactsParams = { account_id: string; symbol: string; volume?: number };

export type MarginFactsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as X-OpenClaw-Thread. */
  threadId?: string;
};

/**
 * This plugin's own abort bound, in milliseconds.
 *
 * IT MUST STAY ABOVE THE PLATFORM'S CEILING, and the ORDERING is the point
 * rather than the value. The platform bounds the terminal round trip at
 * `_MARGIN_ROUND_TRIP_SECONDS = 25.0` (propfirm_manager,
 * `web_api/risk_tools/service.py`, raised from 20.0 by P3d). Whichever bound
 * fires first decides what the trader sees:
 *
 *   platform first -> a REPORTED timeout. The platform knows it waited 25 s
 *                     and says so, and the agent can pass that on.
 *   plugin first   -> an ABORTED fetch. The platform's answer is thrown away
 *                     in flight and the failure arrives with no duration and
 *                     nothing to explain it.
 *
 * P3d lifted the platform bound 20 -> 25 and left 5 s of headroom against this
 * plugin's 30 s. NOTHING IN EITHER REPOSITORY ASSERTED THE ORDERING, so the
 * next lift would silently invert it. 35 s restores 10 s, and the guard beside
 * this file names BOTH numbers so an inversion fails a test rather than a
 * trader's margin question.
 */
const PLUGIN_BOUND_MS = 35_000;

/**
 * The platform's ceiling, mirrored here ONLY so the guard can compare them.
 *
 * It is a copy, and a copy is the honest option: this repository cannot import
 * from propfirm_manager. The alternative is asserting nothing, which is what
 * P3d left behind. The mirror is PAIRED with a test on the platform side that
 * reads its own constant and asserts the same inequality, so a change to
 * either repo fails somewhere rather than nowhere.
 */
export const PLATFORM_MARGIN_ROUND_TRIP_MS = 25_000;

/** Exported for the guard; the plugin itself uses the private constant. */
export const VCTRADERAI_MARGIN_FACTS_BOUND_MS = PLUGIN_BOUND_MS;

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai margin_facts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runMarginFacts(
  params: MarginFactsParams,
  deps: MarginFactsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const accountId = nonEmpty(params.account_id);
  const symbol = nonEmpty(params.symbol);
  if (accountId === undefined) {
    throw new Error("vctraderai margin_facts: account_id is required");
  }
  if (symbol === undefined) {
    throw new Error("vctraderai margin_facts: symbol is required");
  }
  const body: Record<string, unknown> = { account_id: accountId, symbol };
  if (typeof params.volume === "number") {
    body.volume = params.volume;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/margin-facts`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-margin-facts",
  name: "VC Trader AI Margin Facts",
  description:
    "Workspace-scoped read: the broker's own margin figures for one symbol on one account, and what a specific order costs.",
  tools: (tool) => [
    tool({
      name: MARGIN_FACTS_TOOL_NAME,
      label: "Margin Facts",
      description:
        "The broker's own margin figures for one symbol on one account, and what a specific order costs. With a volume, the TERMINAL prices the order through its own OrderCalcMargin, which applies the broker's formula for that symbol's calc mode and is the same figure the terminal shows; the response then also reports the account's free margin and the room the order leaves. Read-only. Honesty: no margin formula is implemented here and none is approximated -- notional divided by leverage is the backtest venue's rule and measurably more permissive than a live account, so it is never used. Without a volume the requirement declines and names volume, because margin is a property of an order rather than of a symbol. When the terminal cannot answer within the stated bound the requirement declines in the venue's own words, the bound is reported, and the broker's rates are still returned. Headroom declines whenever the requirement does, because room measured against an unknown requirement is a guess. A venue-reported margin of zero is a real answer; null means not reported. requirement.bound_seconds states what the server waited for -- report it rather than calling a decline a failure.",
      parameters: Type.Object(
        {
          account_id: Type.String({
            description: "The account whose broker catalogue and terminal to read.",
          }),
          symbol: Type.String({
            description: "Broker symbol exactly as the terminal names it.",
          }),
          volume: Type.Optional(
            Type.Number({
              description:
                "Order size in lots. Supplied, the terminal prices the margin this order requires and the response reports the free margin it would leave.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        // Combined, not replaced: the turn can still cancel this call, and the
        // plugin's own bound only ever fires AFTER the server's.
        const bound = AbortSignal.timeout(PLUGIN_BOUND_MS);
        const signal =
          context.signal === undefined ? bound : AbortSignal.any([context.signal, bound]);
        return runMarginFacts(params as MarginFactsParams, { threadId: context.threadId }, signal);
      },
    }),
  ],
});
