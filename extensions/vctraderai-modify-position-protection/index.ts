import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: modify_position_protection (LIVE EXECUTE).
//
// Calls the workspace-scoped live-execute boundary as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim BFF response. The BFF gates the
// mutation against the owner's autonomous-unlock window SERVER-SIDE: if the
// window is open it accepts/executes the protection change; otherwise it
// returns execution_status 'downgraded' and stages nothing. The response
// carries accepted_queued / executed / downgraded_to_staged / lock_reason.

export const MODIFY_POSITION_PROTECTION_TOOL_NAME = "modify_position_protection";

export type ModifyPositionProtectionDeps = {
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

export type ModifyPositionProtectionParams = {
  account_id: string;
  position_id: string;
  sl?: number;
  tp?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai modify_position_protection: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runModifyPositionProtection(
  params: ModifyPositionProtectionParams,
  deps: ModifyPositionProtectionDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const body: Record<string, unknown> = { account_id: params.account_id };
  if (params.sl !== undefined) {
    body.sl = params.sl;
  }
  if (params.tp !== undefined) {
    body.tp = params.tp;
  }
  return bffFetch(
    `/api/v1/workspaces/${workspaceId}/live/positions/${params.position_id}/agent-protection`,
    {
      method: "POST",
      body,
      signal,
    },
  );
}

export default defineToolPlugin({
  id: "vctraderai-modify-position-protection",
  name: "VC Trader AI Modify Position Protection",
  description:
    "Autonomously modify a live position's stop-loss / take-profit while the owner's autonomous-unlock window is open. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. A protection change that does not go through leaves the position on its OLD stop, or with none.",
  tools: (tool) => [
    tool({
      name: MODIFY_POSITION_PROTECTION_TOOL_NAME,
      label: "Modify Position Protection",
      description:
        "Autonomously modify a live position's stop-loss / take-profit while the owner's autonomous-unlock window is open. If the window is closed the call does NOT go through and NOTHING is staged for approval: it returns 200 with execution_status 'downgraded', downgraded_to_staged true and a lock_reason. There is no card, no queue entry and no pending approval anywhere -- tell the owner the autonomous-unlock window is closed, name the lock_reason, and ask them to open it or act themselves. Never say the action is staged, pending approval or awaiting a card. A protection change that does not go through leaves the position on its OLD stop, or with none.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Live account id that owns the position.",
          minLength: 1,
        }),
        position_id: Type.String({
          description: "Live position id to modify protection for.",
          minLength: 1,
        }),
        sl: Type.Optional(Type.Number({ description: "New stop-loss price." })),
        tp: Type.Optional(Type.Number({ description: "New take-profit price." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runModifyPositionProtection(
          params as ModifyPositionProtectionParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
