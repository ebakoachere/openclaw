import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: emit_specialist_signal.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.

export const EMIT_SPECIALIST_SIGNAL_TOOL_NAME = "emit_specialist_signal";

export type EmitSpecialistSignalDeps = {
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

export type EmitSpecialistSignalParams = Record<string, unknown>;

// THE LEVELS AND THE CHART (W21 defect 1).
//
// Derived from the backend that validates them -- core/trade_plan.py and
// core/chart_window.py in propfirm_manager. Every shape below was checked
// against `from_mapping` there rather than taken on description: `entry`
// accepts {at}, {lo, hi} or a bare number; `stop` accepts {at} or a bare
// number; `label` is optional on the wire and defaults to `TP<n>`; a
// `close_pct` of 0 or over 100 is refused by name; and an explicit unknown
// must carry a reason, because `_level_or_not_reported` refuses an empty one.
//
// THE TIMEFRAME VOCABULARY IS DELIBERATELY NOT ENUMERATED HERE. The backend
// validates it against ACCEPTED_TIMEFRAMES and refuses by name; a copy in this
// plugin would be a third home for that list and would drift out of agreement
// with the two that already exist.
const NotReported = Type.Object({ not_reported: Type.String({ minLength: 1 }) });
const Price = Type.Number();

const TradePlan = Type.Object({
  instrument: Type.String({ minLength: 1 }),
  side: Type.Union([Type.Literal("long"), Type.Literal("short")]),
  entry: Type.Union([
    Type.Object({ at: Price }),
    Type.Object({ lo: Price, hi: Price }),
    Price,
    NotReported,
  ]),
  stop: Type.Union([Type.Object({ at: Price }), Price, NotReported]),
  legs: Type.Union([
    Type.Array(
      Type.Object({
        price: Type.Union([Price, NotReported]),
        close_pct: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
        label: Type.Optional(Type.String()),
        // `then` is the WIRE field name and it is fixed by the backend:
        // core/trade_plan.py's Leg carries `then` and from_mapping reads
        // `item["then"]`, so renaming it here would silently drop every
        // management action a specialist asked for. The rule guards against an
        // object being mistaken for a promise; this is a TypeBox schema
        // DESCRIBING a JSON payload — never awaited, never resolved.
        //
        // The directive must be the LAST comment line before the property:
        // `disable-next-line` means the very next line, and with the prose after
        // it the suppression landed on another comment and the rule still fired.
        // oxlint-disable-next-line unicorn/no-thenable -- wire field name, fixed by the backend
        then: Type.Optional(
          Type.Union([
            Type.Literal("stop_to_breakeven"),
            Type.Literal("stop_to_entry"),
            Type.Literal("trail"),
          ]),
        ),
      }),
      { minItems: 1 },
    ),
    NotReported,
  ]),
  note: Type.Optional(Type.String()),
});

const ChartWindow = Type.Object({
  timeframe: Type.String(),
  candles: Type.Optional(Type.Integer({ minimum: 60, maximum: 1000 })),
});

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai emit_specialist_signal: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runEmitSpecialistSignal(
  params: EmitSpecialistSignalParams,
  deps: EmitSpecialistSignalDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/signals/emit", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": EMIT_SPECIALIST_SIGNAL_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-emit-specialist-signal",
  name: "VC Trader AI Emit Specialist Signal",
  description:
    "Emit a read-only specialist signal for Agent Alpha PM review; does not execute trades.",
  tools: (tool) => [
    tool({
      name: EMIT_SPECIALIST_SIGNAL_TOOL_NAME,
      label: "Emit Specialist Signal",
      description:
        "Emit a read-only specialist signal for Agent Alpha PM review; does not execute trades. " +
        "THE LEVELS AND THE CHART. Optional trade_plan: the trade this view proposes, as " +
        "{instrument, side (long|short), entry ({at: price} or {lo, hi} for a zone), stop ({at: price}), legs}. " +
        "legs is an ORDERED list of exits, each {price, close_pct, label, then}. close_pct is how much of the " +
        "position closes at that leg — so tp1/tp2/tp3 is a partial-exit plan, not three prices. The legs may " +
        "total LESS THAN 100, and the remainder is a RUNNER, shown on screen as one. then is optional and is " +
        "one of stop_to_breakeven, stop_to_entry, trail. Every level is required, but any one may be marked " +
        'explicitly unknown as {"not_reported": "why you do not have it"} — a reason is required, and silence ' +
        "is not the same as an explicit unknown. A plan whose entry, stop and legs are ALL marked unknown is " +
        "refused: that is a thesis, not a plan, so emit it without a trade_plan instead. A stop on the " +
        "profitable side of entry, a target behind entry, exits out of order, two exits with the same label, " +
        "or legs totalling over 100 are each refused by name at emit. Optional chart_window: the chart YOU " +
        "want shown with this signal, as {timeframe, candles}. timeframe is one of the platform's accepted " +
        "timeframes; candles is between 60 and 1000 (240 if omitted) and is REFUSED rather than clamped " +
        "outside that. The chart is interactive — the reader can change the timeframe and scroll — so candles " +
        "buys scrollback rather than squashing the chart. Choose a window where the plan's full span, stop " +
        "through furthest target, fills roughly a fifth to two fifths of the opening view.",
      parameters: Type.Object(
        {
          specialist_key: Type.Optional(
            Type.String({ description: "Specialist key, usually gold_specialist." }),
          ),
          route_key: Type.Optional(Type.String({ description: "Model route key." })),
          requested_model: Type.Optional(Type.String({ description: "Requested model id." })),
          served_model: Type.Optional(Type.String({ description: "Served model id." })),
          instrument: Type.Optional(Type.String({ description: "Instrument, e.g. XAUUSD." })),
          topic: Type.Optional(Type.String({ description: "Signal topic." })),
          thesis: Type.String({ description: "Specialist thesis.", minLength: 1 }),
          confidence: Type.Number({
            description: "Confidence from 0 to 1.",
            minimum: 0,
            maximum: 1,
          }),
          horizon: Type.Optional(Type.String({ description: "Signal horizon." })),
          evidence: Type.Optional(Type.Record(Type.String(), Type.Any())),
          source_urls: Type.Optional(Type.Array(Type.String())),
          trade_plan: Type.Optional(TradePlan),
          chart_window: Type.Optional(ChartWindow),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEmitSpecialistSignal(
          params as EmitSpecialistSignalParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
