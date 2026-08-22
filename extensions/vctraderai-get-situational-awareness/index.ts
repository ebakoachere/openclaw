import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_situational_awareness.
//
// READ_ONLY per ADR 0078. Calls the propfirm_manager internal OpenClaw BFF
// route GET /api/v1/openclaw/situational-awareness with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist
// gates the exact tool before running it. Offline, no broker read.
//
// WHAT THIS ROUTE CAN ACTUALLY RETURN (measured against the platform):
//   * account_health and market_regime are read through
//     engine.agent.tools.{live_trading_read_tools.get_live_account_state,
//     perception_tools.classify_regime}, whose _agent_config() requires
//     PFM_BFF_BASE_URL / PFM_AGENT_TOKEN / PFM_AGENT_WORKSPACE_ID. That triple
//     is bound on the per-workspace AGENT container, never on the web_api ECS
//     task that serves this route (infra/terraform/ecs.tf:346 is the only
//     `uvicorn web_api.main:app` task and none of the three appear in it), so
//     both blocks come back {label: "unavailable", error: "PFM_BFF_BASE_URL is
//     not configured for this agent."}.
//   * risk_budget.daily_loss / .drawdown read risk_config through
//     get_default_store(), a process-global InMemoryRiskConfigStore whose
//     identities map has ZERO production writers, so read_config always raises
//     unknown_account and both members degrade to {label: "unavailable"}.
//   * Consequence: _derive_posture treats "unavailable" as degrading, so
//     overall_posture can only ever be "degraded" or "locked".
//   * gather_situational_bundle calls the econ source with workspace_id ONLY;
//     `instrument` is never forwarded to it.

export const GET_SITUATIONAL_AWARENESS_TOOL_NAME = "get_situational_awareness";

export type GetSituationalAwarenessDeps = {
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

export type GetSituationalAwarenessParams = {
  account_id?: string;
  instrument?: string;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai get_situational_awareness: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildQuery(params: GetSituationalAwarenessParams): Record<string, string | undefined> {
  return {
    workspace_id: readWorkspaceId(),
    account_id: typeof params.account_id === "string" ? params.account_id : undefined,
    instrument: typeof params.instrument === "string" ? params.instrument : undefined,
  };
}

export async function runGetSituationalAwareness(
  params: GetSituationalAwarenessParams,
  deps: GetSituationalAwarenessDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/situational-awareness", {
    method: "GET",
    query: buildQuery(params),
    headers: { "X-OpenClaw-Tool": GET_SITUATIONAL_AWARENESS_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-get-situational-awareness",
  name: "VC Trader AI Get Situational Awareness",
  description:
    "Per-turn situational-awareness snapshot with honesty/staleness labels (read-only, offline, no broker read). On this route account_health, market_regime and the daily-loss/drawdown risk caps are always unavailable.",
  tools: (tool) => [
    tool({
      name: GET_SITUATIONAL_AWARENESS_TOOL_NAME,
      label: "Get Situational Awareness",
      description:
        "Return a per-turn situational-awareness snapshot with honesty/staleness labels. " +
        "READ_ONLY per ADR 0078 — no mutation, offline, no broker read. Read what it " +
        "can actually answer before relying on it. It carries NO trading risk headroom: " +
        'risk_budget.daily_loss and .drawdown are always {label: "unavailable"}, and the ' +
        "llm_spend_cap member that does carry a number is an LLM API spend budget, not a " +
        "trading budget. account_health and market_regime are also always {label: " +
        '"unavailable", error: "PFM_BFF_BASE_URL is not configured for this agent."} on ' +
        "this route — for balance, equity and open PnL call get_live_account_state " +
        "instead. Because those blocks are unavailable, overall_posture is always " +
        '"degraded" or "locked"; it can never be "normal" or "caution", so it cannot ' +
        "distinguish a healthy turn from a degraded one. econ_news_proximity is the " +
        "whole-workspace calendar for the next 48 hours (up to 5 active events) and is " +
        "NOT filtered by instrument.",
      parameters: Type.Object({
        account_id: Type.Optional(
          Type.String({
            description:
              "Account id (optional). Scopes the autonomous_unlock consult, plus the " +
              "account_health and market_regime reads — but both of those are " +
              "unavailable on this route, so it changes little in practice.",
            minLength: 1,
          }),
        ),
        instrument: Type.Optional(
          Type.String({
            description:
              "Instrument, e.g. XAUUSD (optional). Applied ONLY to market_regime, which " +
              "is unavailable on this route; without it that block is labelled " +
              "unknown/no_instrument. It is never applied to econ_news_proximity, which " +
              "is always the whole-workspace 48-hour calendar.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetSituationalAwareness(
          params as GetSituationalAwarenessParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
