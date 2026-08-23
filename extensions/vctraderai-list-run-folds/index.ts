import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_run_folds.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const LIST_RUN_FOLDS_TOOL_NAME = "list_run_folds";

export type ListRunFoldsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type ListRunFoldsParams = {
  run_id: string;
  cursor?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_run_folds: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListRunFolds(
  params: ListRunFoldsParams,
  deps: ListRunFoldsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/walkforward/${params.run_id}/fold-summaries`, {
    method: "GET",
    query: {
      cursor: params.cursor,
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-run-folds",
  name: "VC Trader AI List Run Folds",
  description:
    "Per-fold walkforward summaries for one run, cursor-paginated at 50 per page and 200 maximum. Read the folds before trusting an aggregate: a headline metric can hide a single fold carrying the whole result.",
  tools: (tool) => [
    tool({
      name: LIST_RUN_FOLDS_TOOL_NAME,
      label: "List Run Folds",
      description:
        "Per-fold walkforward summaries for one run, cursor-paginated at 50 per page and 200 maximum. Read the folds before trusting an aggregate: a headline metric can hide a single fold carrying the whole result.",
      parameters: Type.Object({
        run_id: Type.String({
          description:
            "Experiment run id. The dispatch job id and the experiment run id are the SAME value under two names.",
          minLength: 1,
        }),
        cursor: Type.Optional(
          Type.String({
            description: "Opaque pagination cursor from a previous page.",
            minLength: 1,
          }),
        ),
        limit: Type.Optional(Type.Integer({ description: "Page size, 1 to 200. Defaults to 50." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListRunFolds(
          params as ListRunFoldsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
