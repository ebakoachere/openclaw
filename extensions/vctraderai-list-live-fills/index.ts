import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_live_fills.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// Two BFF facts the schema must not contradict:
//  - limit is bound by Query(ge=1, le=MAX_FILLS_LIMIT) with MAX_FILLS_LIMIT=200,
//    so 201+ is a FastAPI 422 before the handler runs.
//  - pagination does not exist. The route accepts `cursor` and forwards it, but
//    build_fills never reads it and hard-codes next_cursor=None; no repository
//    implementation takes a cursor. `cursor` is therefore NOT offered to the
//    model, though runListLiveFills still forwards one if a caller passes it.

export const LIST_LIVE_FILLS_TOOL_NAME = "list_live_fills";

export type ListLiveFillsDeps = {
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

export type ListLiveFillsParams = {
  account_id: string;
  /** Accepted by the route and inert server-side; not exposed to the model. */
  cursor?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_live_fills: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListLiveFills(
  params: ListLiveFillsParams,
  deps: ListLiveFillsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/fills`, {
    query: {
      account_id: params.account_id,
      cursor: params.cursor,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-live-fills",
  name: "VC Trader AI List Live Fills",
  description:
    "Read-only workspace-scoped tool: List the signed-in user's recent live fills via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: LIST_LIVE_FILLS_TOOL_NAME,
      label: "List Live Fills",
      description:
        "List the signed-in user's recent live fills via the live read endpoints. Returns ONE page: there is no pagination, next_cursor is always null, and a response truncated at `limit` is indistinguishable from the complete history — do not treat it as the account's full fill record. READ_ONLY per ADR 0078 - no mutation. Scoped to the workspace owner.",
      parameters: Type.Object({
        account_id: Type.String({
          description:
            "Live account id; list_live_accounts_for_deployment returns these as rows[].live_account_id.",
          minLength: 1,
        }),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum fills to return (default 50). Over 200 the API returns HTTP 422.",
            minimum: 1,
            maximum: 200,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListLiveFills(
          params as ListLiveFillsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
