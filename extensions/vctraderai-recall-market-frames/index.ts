import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: recall_market_frames (MCF PR 3 -- the live tool surface).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Reads
// the workspace-scoped Market Context Frame store through the BFF as the
// workspace owner (PFM_AGENT_TOKEN) and returns the envelope VERBATIM.
//
// THE ENVELOPE MUST NOT BE RESHAPED HERE. web_api/market_frames/schemas.py is
// built so a REFUSAL cannot be misread as an empty corpus: `ran`, `withheld`,
// `disposition` and `reason` are separate fields precisely because an agent told
// "nothing found" reasons as though there were nothing, and would go on to
// narrate a market without precedent that in fact has a thousand. Any summarising
// or flattening in this plugin would re-create exactly that failure, so the
// response is passed through untouched.
//
// THE TOOL SHIPS IN SHADOW. The server decides whether frames may be returned
// (`mode` = off | shadow | live). During shadow the route answers with
// `withheld: true` and a `reason` in words. That refusal is the enforcement and
// it lives server-side ON PURPOSE -- a second gate implemented here would be a
// control with two implementations, one of which is wrong.
//
// NAME. The tool is registered as `recall_market_frames` EXACTLY. The gateway's
// closed-world gate matches by lowercased string against the allowlist snapshot
// and does NOT derive a tool name from the directory id, so the directory being
// `vctraderai-recall-market-frames` is irrelevant to admission.

export const RECALL_MARKET_FRAMES_TOOL_NAME = "recall_market_frames";

/**
 * The anchor timeframes the encoder validates at its door.
 *
 * Mirrors `SUPPORTED_TIMEFRAMES` in `core/openclaw/market_frames.py` verbatim.
 * anchor_tf is part of frame IDENTITY and clusters NEVER mix anchors, so an
 * unsupported value is a refused read rather than a wider search. Pinning the
 * vocabulary here turns a server-side 422 into a schema the model cannot get
 * wrong in the first place.
 */
const ANCHOR_TIMEFRAMES = ["m1", "m5", "m15", "h1", "h4", "d1", "w1"] as const;

/** Mirrors service.DEFAULT_LIMIT / service.MAX_LIMIT. */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type RecallMarketFramesParams = {
  symbol?: string;
  anchor_tf?: string;
  limit?: number;
};

export type RecallMarketFramesDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread` so the BFF can tell
   * which sub-agent (specialist) is calling. Sourced from `context.threadId`.
   */
  threadId?: string;
  /**
   * The value sent as `turn_ref`. See {@link runRecallMarketFrames} -- this is
   * deliberately NOT a model-supplied parameter.
   */
  turnRef?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai recall_market_frames: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/**
 * Run one recall.
 *
 * WHY `turn_ref` IS NOT A MODEL PARAMETER. It keys the shadow row, and every
 * gate in the pass/fail bar is a RATIO over recall attempts. A model-invented
 * string would make each retry look like a fresh attempt and would quietly
 * corrupt the denominator of the measurement this whole phase exists to take --
 * a failure that shows up as a plausible number, never as an error. So the
 * plugin supplies it from the runtime's `toolCallId`, which is unique per tool
 * call and stable across a runtime-level retry of that same call.
 *
 * This is an interpretation, and it is worth stating plainly: `toolCallId` is a
 * CALL identifier, not a turn identifier. One deliberate second recall of the
 * same symbol and anchor inside one model turn therefore counts as two
 * attempts, not one. That is the honest reading of "attempt" for a ratio over
 * recalls, and it is the conservative direction -- it can only make coverage
 * read LOWER than reality, never higher.
 *
 * `as_of` IS DELIBERATELY NOT EXPOSED either. It is the lookahead boundary; the
 * server defaults it to now, which is correct for every live turn. A model that
 * sets it wrong reads the FUTURE, which is the precise bias the frame store
 * exists to avoid, and no live agent has a replay use case. Historical replay
 * is an operator/backfill concern and passes through a different door.
 */
export async function runRecallMarketFrames(
  params: RecallMarketFramesParams = {},
  deps: RecallMarketFramesDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();

  const symbol = typeof params.symbol === "string" ? params.symbol.trim() : "";
  if (symbol.length === 0) {
    throw new Error("vctraderai recall_market_frames: symbol is required");
  }
  const anchorTf = typeof params.anchor_tf === "string" ? params.anchor_tf.trim() : "";
  if (anchorTf.length === 0) {
    throw new Error("vctraderai recall_market_frames: anchor_tf is required");
  }

  // Refuse rather than send an empty required query param. An empty `turn_ref`
  // would 422 at the BFF, and a 422 here would read to the model like a broken
  // backend instead of a missing runtime identity.
  const turnRef = typeof deps.turnRef === "string" ? deps.turnRef.trim() : "";
  if (turnRef.length === 0) {
    throw new Error(
      "vctraderai recall_market_frames: no turn identity available from the runtime; " +
        "recall was not attempted rather than recorded against an unknown turn",
    );
  }

  return bffFetch(`/api/v1/workspaces/${workspaceId}/market-frames/recall`, {
    query: {
      symbol,
      anchor_tf: anchorTf,
      turn_ref: turnRef,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-recall-market-frames",
  name: "VC Trader AI Recall Market Frames",
  description:
    "Read-only workspace-scoped tool: recall past market context frames similar to the one this symbol is in now, from the Market Context Frame store. Calls the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). READ_ONLY per ADR 0078.",
  tools: (tool) => [
    tool({
      name: RECALL_MARKET_FRAMES_TOOL_NAME,
      label: "Recall Market Frames",
      description:
        "Recall moments this market has been in a similar state before. Encodes the symbol's CURRENT state on the given anchor timeframe and returns the nearest past frames, each with its distance and how many fields were actually comparable. " +
        "READ THE ENVELOPE BEFORE THE FRAMES. `disposition` is one of off | unconfigured | empty | found, and `ran` and `withheld` are separate booleans: 'it did not run', 'it ran and found nothing', and 'it found something the current mode forbids returning' are three DIFFERENT answers with different remedies, and `reason` says which in words. Never report a withheld or non-running result as 'no precedent' — that is the one misreading this tool is shaped to prevent. " +
        "WHAT THE FRAMES MAY BE USED TO SAY is carried verbatim in `claim` on every response. Quote it, do not paraphrase, and do not extend it: what the measurement supports is how WIDE a move has been from states like this, never which WAY. `sufficient` reports whether the cohort met the statistical floor and is false until that layer exists — treat false as 'not established', not as 'weak but usable'. " +
        "`cohort_distinct_days` matters more than `returned`: forty adjacent hourly frames are one observation of a day, not forty. `refused_for_dimensions` counts candidates too incomparable to rank at all — 'nothing comparable' and 'nothing close' are different problems.",
      parameters: Type.Object({
        symbol: Type.String({
          description:
            "The broker symbol to encode and match, e.g. 'EURUSD'. Use the symbol exactly as your account's broker names it.",
          minLength: 1,
          maxLength: 32,
        }),
        anchor_tf: Type.Union(
          ANCHOR_TIMEFRAMES.map((value) => Type.Literal(value)),
          {
            description:
              "The anchor timeframe to match on. This is part of a frame's IDENTITY — cohorts never mix anchors, so this chooses WHICH population you are asking about, not merely how finely. Match it to the horizon you are reasoning about.",
          },
        ),
        limit: Type.Optional(
          Type.Integer({
            description: `Maximum frames to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
            minimum: 1,
            maximum: MAX_LIMIT,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRecallMarketFrames(
          params as RecallMarketFramesParams,
          { threadId: context.threadId, turnRef: context.toolCallId },
          context.signal,
        );
      },
    }),
  ],
});
