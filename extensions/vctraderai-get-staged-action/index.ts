import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: get_staged_action (read an approval card the agent staged).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped live read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.
//
// WHY IT EXISTS. agent_place_order has returned a staged_action_id since Task
// 18, and until W19 (platform PR #1864) that id was a WRITE-ONLY HANDLE: every
// reader of openclaw.staged_actions served a human surface, so no agent tool
// among the 130 registered could read a card back. An agent could stage an
// order, tell the owner a card was waiting, and then have no way at all to
// learn whether the owner approved it. On 2026-09-09 it was asked exactly that
// about an order the owner HAD approved and which HAD filled.
//
// APPLIED IS NOT FILLED. The card's vocabulary stops at 'applied' -- the owner
// clicked approve and the platform submitted the order. What the BROKER then
// did is a different question with a different answer, and it is the one the
// owner is actually asking; that is why target_decision_id comes back with the
// card, as the handle get_order_outcome resolves. Two calls, because there are
// two facts.

export const GET_STAGED_ACTION_TOOL_NAME = "get_staged_action";

export type GetStagedActionDeps = {
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

export type GetStagedActionParams = {
  staged_action_id: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai get_staged_action: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runGetStagedAction(
  params: GetStagedActionParams,
  deps: GetStagedActionDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const stagedActionId =
    typeof params.staged_action_id === "string" ? params.staged_action_id.trim() : "";
  // Guarded here so a malformed call fails fast with a clear message rather
  // than as a 400 the model has to interpret.
  if (stagedActionId.length === 0) {
    throw new Error("vctraderai get_staged_action: staged_action_id is required");
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/live/staged-action`, {
    query: { staged_action_id: stagedActionId },
    signal,
  });
}

const TOOL_DESCRIPTION =
  "Read the state of an approval card you staged earlier. Required: staged_action_id -- the id agent_place_order returned when the account was in Manual mode and the order was STAGED rather than placed. Owner-scoped to the agent's own workspace. Returns status: proposed (still waiting on the owner), applied (the owner approved it and the platform submitted the order), rejected (the owner declined) or expired (it timed out) -- plus params (the order the card holds), summary, expires_at, applied_at and target_decision_id. APPLIED DOES NOT MEAN FILLED: it means the owner clicked approve and the platform submitted the order, which is a different fact from what the broker did with it. To learn whether it filled, take target_decision_id (or the order's idempotency_key) to get_order_outcome and wait for a terminal status there -- never tell the owner an order filled on the strength of applied alone. found false means no such card exists in this workspace, which is NOT the same as rejected or expired and must never be relayed as either. Call this whenever the owner asks what happened to an order you staged, before answering from memory: a card you were told about at the time may since have been approved, declined or expired, and the answer you remember is the one thing that cannot have changed.";

export default defineToolPlugin({
  id: "vctraderai-get-staged-action",
  name: "VC Trader AI Get Staged Action",
  description:
    "Read-only workspace-scoped tool: the state of an approval card the agent staged (proposed / applied / rejected / expired) via the live read endpoints.",
  tools: (tool) => [
    tool({
      name: GET_STAGED_ACTION_TOOL_NAME,
      label: "Get Staged Action",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object({
        staged_action_id: Type.String({
          description:
            "The approval card's id, as returned by agent_place_order in staged_action_id when execution_status was 'staged_for_approval'.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGetStagedAction(
          params as GetStagedActionParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
