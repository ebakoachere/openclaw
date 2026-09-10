import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: set_trailing_stop.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const SET_TRAILING_STOP_TOOL_NAME = "set_trailing_stop";

export type SetTrailingStopDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type SetTrailingStopParams = {
  account_id: string;
  position_id: string;
  distance: string;
  units: "RELATIVE_PRICE" | "RELATIVE_POINTS" | "RELATIVE_PIPS";
  threshold?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai set_trailing_stop: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runSetTrailingStop(
  params: SetTrailingStopParams,
  deps: SetTrailingStopDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/live/positions/${params.position_id}/agent-trailing-stop`,
    {
      method: "POST",
      body: {
        account_id: params.account_id,
        distance: params.distance,
        units: params.units,
        ...(params.threshold === undefined ? {} : { threshold: params.threshold }),
      },
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-set-trailing-stop",
  name: "VC Trader AI Set Trailing Stop",
  description:
    "Ask the broker to attach a server-side trailing stop to a live position. A success means the broker ACCEPTED the request, never that the trail is active: server-side trailing is broker-dependent and is not proven on the live servers. Blocks during a durable halt, because attaching a trail is not de-risking. If the account is NOT set to act autonomously the call does NOT go through and NOTHING is staged for approval: it returns execution_status 'refused' with a lock_reason and downgraded_to_staged false. Attaching a trail is NOT de-risking, so unlike a close it is still gated by the execution mode. There is no card, no queue entry and no pending approval anywhere. Tell the owner the account is not currently set to act autonomously, name the lock_reason, and ask them to do it themselves or change the account's execution mode. Never say the action is staged or awaiting approval.",
  tools: (tool) => [
    tool({
      name: SET_TRAILING_STOP_TOOL_NAME,
      label: "Set Trailing Stop",
      description:
        "Ask the broker to attach a server-side trailing stop to a live position. A success means the broker ACCEPTED the request, never that the trail is active: server-side trailing is broker-dependent and is not proven on the live servers. Blocks during a durable halt, because attaching a trail is not de-risking. If the account is NOT set to act autonomously the call does NOT go through and NOTHING is staged for approval: it returns execution_status 'refused' with a lock_reason and downgraded_to_staged false. Attaching a trail is NOT de-risking, so unlike a close it is still gated by the execution mode. There is no card, no queue entry and no pending approval anywhere. Tell the owner the account is not currently set to act autonomously, name the lock_reason, and ask them to do it themselves or change the account's execution mode. Never say the action is staged or awaiting approval.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the position.",
          minLength: 1,
        }),
        position_id: Type.String({
          description: "Live OPEN position id to attach the trail to.",
          minLength: 1,
        }),
        distance: Type.String({
          description: "Trailing distance as a decimal STRING. Must be greater than zero.",
          minLength: 1,
        }),
        units: Type.Union(
          [
            Type.Literal("RELATIVE_PRICE"),
            Type.Literal("RELATIVE_POINTS"),
            Type.Literal("RELATIVE_PIPS"),
          ],
          { description: "Unit the distance is expressed in." },
        ),
        threshold: Type.Optional(
          Type.String({
            description: "Optional step ladder threshold, broker-validated.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSetTrailingStop(
          params as SetTrailingStopParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
