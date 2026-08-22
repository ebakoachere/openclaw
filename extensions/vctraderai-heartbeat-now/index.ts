import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: heartbeat_now.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.
//
// IT DOES NOT RESPECT THE STATUS GATE -- IT REWRITES IT. Route ->
// AgentAlphaHeartbeatService.heartbeat_now -> queue_policy_now is an
// unconditional chain ending in an UPDATE that sets status='enabled',
// next_due_at=now and stopped_at=NULL, keyed only on workspace_id + policy_id.
// That is the exact inverse of stop_policy. The runner's own guard
// (`policy.status not in {"enabled","degraded"}`) is real but reads the row
// AFTER this write, so it can never refuse a policy this tool has queued.

export const HEARTBEAT_NOW_TOOL_NAME = "heartbeat_now";

export type HeartbeatNowDeps = {
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

export type HeartbeatNowParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai heartbeat_now: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runHeartbeatNow(
  params: HeartbeatNowParams,
  deps: HeartbeatNowDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/now", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": HEARTBEAT_NOW_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-heartbeat-now",
  name: "VC Trader AI Heartbeat Now",
  description:
    "Queue an Agent Alpha heartbeat policy to run on the next scan. It rewrites the " +
    "policy's status to 'enabled', so it restarts a stopped or paused policy.",
  tools: (tool) => [
    tool({
      name: HEARTBEAT_NOW_TOOL_NAME,
      label: "Heartbeat Now",
      description:
        "Make an Agent Alpha heartbeat policy due immediately, so the next scheduler scan " +
        "selects it. NOT a safe poke: with no status check anywhere in the route, service " +
        "or repository, it unconditionally writes status='enabled', next_due_at=now and " +
        "stopped_at=NULL — the exact inverse of stop_heartbeat. Called on a policy that " +
        "stop_heartbeat stopped, or that the failure breaker set to 'paused', it RESTARTS " +
        "that policy on its recurring cadence instead of being refused. Read the current " +
        "`status` with get_heartbeat_status before calling, and use enable_heartbeat / " +
        "stop_heartbeat for deliberate on/off. policy_id is the `policy_id` field of " +
        "enable_heartbeat's response; an unknown id returns {policy_id, status: " +
        '"missing"} with HTTP 200, not an error.',
      parameters: Type.Object(
        {
          policy_id: Type.String({
            description:
              "Heartbeat policy id — the `policy_id` field of enable_heartbeat's response.",
            minLength: 1,
          }),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runHeartbeatNow(
          params as HeartbeatNowParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
