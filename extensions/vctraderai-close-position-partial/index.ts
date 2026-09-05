import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: close_position_partial.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const CLOSE_POSITION_PARTIAL_TOOL_NAME = "close_position_partial";

export type ClosePositionPartialDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type ClosePositionPartialParams = {
  account_id: string;
  position_id: string;
  volume: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai close_position_partial: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runClosePositionPartial(
  params: ClosePositionPartialParams,
  deps: ClosePositionPartialDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/live/positions/${params.position_id}/agent-partial-close`,
    {
      method: "POST",
      body: { account_id: params.account_id, volume: params.volume },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-close-position-partial",
  name: "VC Trader AI Close Position Partial",
  description:
    "Scale out of a live OPEN position by an explicit volume in LOTS while the account is set to act autonomously. When it is not, the call downgrades and returns lock_reason, and NO card is created for anyone to approve.",
  tools: (tool) => [
    tool({
      name: CLOSE_POSITION_PARTIAL_TOOL_NAME,
      label: "Close Position Partial",
      description:
        "Scale out of a live OPEN position by an explicit volume in LOTS while the account is set to act autonomously. When it is not, the call downgrades and returns lock_reason, and NO card is created for anyone to approve.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the position.",
          minLength: 1,
        }),
        position_id: Type.String({
          description: "Live OPEN position id to scale out of.",
          minLength: 1,
        }),
        volume: Type.String({
          description:
            "Volume to close, in LOTS, as a decimal STRING (for example 0.05). Must be greater than zero and less than the position size.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runClosePositionPartial(
          params as ClosePositionPartialParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
