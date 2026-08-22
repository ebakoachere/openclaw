import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_positions.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// `include_closed` is INERT server-side: the route forwards it to
// build_positions_individual -> build_positions, where it is declared and never
// read; no repository implementation of list_open_positions /
// list_broker_positions takes it, and DbLiveReadRepository drops flat /
// zero-quantity rows via _is_open regardless. include_closed=true and =false
// produce byte-identical output, so the flag is NOT offered to the model
// (runListLivePositions still forwards one if a caller passes it).

export const LIST_LIVE_POSITIONS_TOOL_NAME = "list_live_positions";

export type ListLivePositionsDeps = {
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

export type ListLivePositionsParams = {
  account_id: string;
  /** Accepted by the route and inert server-side; not exposed to the model. */
  include_closed?: boolean;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_live_positions: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListLivePositions(
  params: ListLivePositionsParams,
  deps: ListLivePositionsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/positions`, {
    query: {
      account_id: params.account_id,
      include_closed:
        params.include_closed !== undefined ? String(params.include_closed) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-live-positions",
  name: "VC Trader AI List Live Positions",
  description:
    "Read-only workspace-scoped tool: List the signed-in user's live OPEN positions via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_POSITIONS_TOOL_NAME,
      label: "List Live Positions",
      description:
        "List the signed-in user's live OPEN positions via the live read endpoints. Open positions ONLY — a closed position is never returned and this tool cannot show one, so it can neither confirm nor deny that a close happened. Each row carries source='broker' (an individual per-ticket broker read, with the venue's sl/tp) or source='ledger' (the netted fallback served when the broker read fails). READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.String({
          description:
            "Live account id; list_live_accounts_for_deployment returns these as rows[].live_account_id.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListLivePositions(
          params as ListLivePositionsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
