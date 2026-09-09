import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: render_card.
//
// The model asks for a card; the PLATFORM composes it. The card is built
// server-side from a real read, reaches the user on its own frame, and NEVER
// passes through this tool's result.
//
// WHY THE RESULT IS ONE LINE, and why that is a contract rather than a style
// choice: a tool result is replayed into the model's context on every later
// turn of the thread, exactly like the model's own text. Returning the card
// here would put the whole payload back into the conversation and undo the
// entire reason this tool exists — the numbers would also be re-read by the
// model rather than rendered from the store. `index.test.ts` fails if the
// result is not a single line.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py).

export const RENDER_CARD_TOOL_NAME = "render_card";

/**
 * The card kinds the platform can render, by NAME, mirroring
 * `web_api/agent_alpha/artifact_schema.py::_TYPES`.
 *
 * `approval` is DELIBERATELY ABSENT: the platform renders the governed
 * approval card from the staged action itself, and a second, unauthoritative
 * copy is exactly what the persona forbids. Offering it here would invite a
 * call that can only be refused.
 *
 * The list is pinned by `index.test.ts`. It lives in two repositories, so the
 * pin is what makes a drift loud on THIS side; the propfirm_manager side pins
 * its own half against `_TYPES`.
 */
export const RENDER_CARD_KINDS = [
  "account",
  "alerts",
  "backtest",
  "change_summary",
  "chart",
  "comparison",
  "data",
  "decision",
  "digest",
  "econ",
  "news",
  "notebook_output",
  "order_ticket",
  "positions",
  "post_trade",
  "risk",
  "signal",
  "subagent",
  "watchlist",
] as const;

export type RenderCardParams = {
  kind: string;
  params?: Record<string, unknown>;
};

export type RenderCardDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /** Per-turn BFF thread id, forwarded as `X-OpenClaw-Thread`. */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai render_card: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

/** Longest confirmation the model is ever handed, in characters. */
const MAX_RESULT_CHARS = 240;

/**
 * Reduce any answer to ONE LINE, and cap it.
 *
 * The BFF returns `{ok, kind, confirmation}` or `{ok: false, reason}`, and this
 * function does not TRUST that: it takes the first line and truncates. The
 * contract is enforced at the boundary the model actually reads, so a change on
 * the server — a stack trace in a reason, a card appended to a confirmation —
 * cannot quietly put a payload back into every later turn of the thread. That
 * is the whole reason this tool exists, and it should not depend on the other
 * side of the wire continuing to behave.
 */
function oneLine(text: string): string {
  const first = text.split(/[\r\n]/, 1)[0].trim();
  return first.length > MAX_RESULT_CHARS ? `${first.slice(0, MAX_RESULT_CHARS - 1)}…` : first;
}
export function summariseCardResult(payload: unknown): string {
  const body =
    payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)
      ? (payload as Record<string, unknown>).data
      : payload;
  if (!body || typeof body !== "object") {
    return "render_card: the platform returned no answer; say so rather than assuming a card appeared.";
  }
  const row = body as Record<string, unknown>;
  if (row.ok === true) {
    const confirmation = typeof row.confirmation === "string" ? oneLine(row.confirmation) : "";
    const kind = typeof row.kind === "string" && row.kind.length > 0 ? row.kind : "card";
    return confirmation || `${kind} rendered.`;
  }
  const reason = typeof row.reason === "string" ? oneLine(row.reason) : "";
  return reason
    ? oneLine(`No card: ${reason}`)
    : "No card, and the platform gave no reason; say so rather than describing one.";
}

export async function runRenderCard(
  params: RenderCardParams,
  deps: RenderCardDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const payload = await bffFetch(`/api/v1/workspaces/${workspaceId}/agent/cards/compose`, {
    method: "POST",
    body: { kind: params.kind, params: params.params ?? {} },
    signal,
  });
  // The envelope is deliberately NOT returned: see the header note.
  return summariseCardResult(payload);
}

export default defineToolPlugin({
  id: "vctraderai-render-card",
  name: "VC Trader AI Render Card",
  description:
    "Read-only workspace-scoped tool: render an in-chat card, composed server-side from platform data.",
  tools: (tool) => [
    tool({
      name: RENDER_CARD_TOOL_NAME,
      label: "Render Card",
      description:
        "Render an in-chat card. The PLATFORM composes it from real data and shows it to the user; you get back one line saying what appeared, never the card itself. Use this instead of writing the card out yourself: the numbers then come from the store rather than from you, and they cannot be mistyped. TODAY ONLY `chart` COMPOSES (alerts and post_trade follow once their reads land); every other kind returns a one-line refusal telling you to write it as a vn-artifact fence instead, so do not reach for this tool for a digest, a watchlist, a comparison, a change summary, an order ticket, a signal, a specialist report or a news card. Required: kind. Optional: params (what the card is about — e.g. symbol and timeframe for a chart). If the data is not there you are told why, in one sentence; say that rather than describing a card the user cannot see.",
      parameters: Type.Object({
        kind: Type.Union(
          RENDER_CARD_KINDS.map((kind) => Type.Literal(kind)),
          {
            description:
              "Which card to render. Judgement-shaped cards (digest, watchlist, comparison, change_summary, order_ticket, signal, subagent, news) are yours to write as a vn-artifact fence instead; asking for them here returns a one-line refusal saying so.",
          },
        ),
        params: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "What the card is about. For a chart: symbol, timeframe, and optionally bars, indicators, annotations, playbook, read.",
            },
          ),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runRenderCard(
          params as RenderCardParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
