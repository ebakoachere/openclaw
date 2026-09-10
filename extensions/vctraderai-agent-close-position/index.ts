import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_close_position (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response.
//
// W19 LIVE-CLOSE (platform PR #1864) changed what that boundary does, and this
// description had to change with it. A CLOSE IS DE-RISKING, so Manual mode no
// longer refuses one: the account's execution mode gates ENTRIES. The close
// executes, reduce-only by construction (it can only name a position the venue
// reports open on that account), and the platform reports 'executed' only after
// the broker's out-deal confirms it.
//
// The durable HALT, a closed live-execution gate and a revoked per-account
// consent still refuse a close. Such a refusal now returns execution_status
// 'refused' with a lock_reason, and downgraded_to_staged is FALSE.
//
// That field used to come back TRUE on every refusal while nothing whatsoever
// was staged -- it was the exact opposite of its name, on all thirteen sites
// that set it. It is now false everywhere on this surface. Read
// execution_status, not the flag.
//
// The response carries accepted_queued / executed / execution_status /
// lock_reason / next_step.

export const AGENT_CLOSE_POSITION_TOOL_NAME = "agent_close_position";

export type AgentClosePositionDeps = {
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

export type AgentClosePositionParams = {
  account_id: string;
  position_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_close_position: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runAgentClosePosition(
  params: AgentClosePositionParams,
  deps: AgentClosePositionDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/live/positions/${params.position_id}/agent-close`,
    {
      method: "POST",
      body: { account_id: params.account_id },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-agent-close-position",
  name: "VC Trader AI Agent Close Position",
  description:
    "Close a live OPEN position. A CLOSE IS DE-RISKING, so it does NOT require the account to be set to act autonomously -- the execution mode gates entries, not exits, and this executes in Manual mode too. It is reduce-only: it can only close a position the venue reports OPEN on that account, and it can never open or add exposure. Required: account_id, position_id. THE PLATFORM SAYS 'closed' ONLY AFTER THE BROKER CONFIRMS IT with an out-deal; execution_status 'executed' is that confirmation, and until you see it the honest thing to tell the owner is that the close was submitted and you are waiting on the broker. Never narrate a close from the absence of an error. IT CAN STILL BE REFUSED, by conditions that are not the execution mode: a durable trading HALT, a closed live-execution gate, or agent consent revoked for the account. A refusal returns execution_status 'refused' with a lock_reason, downgraded_to_staged false, and NOTHING is staged -- there is no card and no queue entry, so relay the lock_reason as written and tell the owner they can close it themselves. It is also refused when the position cannot be confirmed open: position_not_open means the venue shows no such open position (it may already have closed -- say so rather than asserting it is still open), while position_book_unreadable, position_book_not_visible and position_book_stale all mean the platform cannot currently SEE the account's positions and is refusing rather than guessing. None of those four means the account is flat; say which one happened.",
  tools: (tool) => [
    tool({
      name: AGENT_CLOSE_POSITION_TOOL_NAME,
      label: "Agent Close Position",
      description:
        "Close a live OPEN position. A CLOSE IS DE-RISKING, so it does NOT require the account to be set to act autonomously -- the execution mode gates entries, not exits, and this executes in Manual mode too. It is reduce-only: it can only close a position the venue reports OPEN on that account, and it can never open or add exposure. Required: account_id, position_id. THE PLATFORM SAYS 'closed' ONLY AFTER THE BROKER CONFIRMS IT with an out-deal; execution_status 'executed' is that confirmation, and until you see it the honest thing to tell the owner is that the close was submitted and you are waiting on the broker. Never narrate a close from the absence of an error. IT CAN STILL BE REFUSED, by conditions that are not the execution mode: a durable trading HALT, a closed live-execution gate, or agent consent revoked for the account. A refusal returns execution_status 'refused' with a lock_reason, downgraded_to_staged false, and NOTHING is staged -- there is no card and no queue entry, so relay the lock_reason as written and tell the owner they can close it themselves. It is also refused when the position cannot be confirmed open: position_not_open means the venue shows no such open position (it may already have closed -- say so rather than asserting it is still open), while position_book_unreadable, position_book_not_visible and position_book_stale all mean the platform cannot currently SEE the account's positions and is refusing rather than guessing. None of those four means the account is flat; say which one happened.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the position.",
          minLength: 1,
        }),
        position_id: Type.String({
          description: "Live OPEN position id to close.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentClosePosition(
          params as AgentClosePositionParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
