import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: update_heartbeat.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.
//
// TIMING IS A SINGLE COUPLED WRITE. AgentAlphaHeartbeatService.update_heartbeat
// calls normalize_heartbeat_timing(cadence, timeout) whenever EITHER is
// supplied, and that helper always returns a non-null PAIR; update_policy then
// writes both through `coalesce(%(field)s, field)`, so a non-null value always
// wins. Sending one of the two therefore overwrites the other.

export const UPDATE_HEARTBEAT_TOOL_NAME = "update_heartbeat";

export type UpdateHeartbeatDeps = {
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

export type UpdateHeartbeatParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai update_heartbeat: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runUpdateHeartbeat(
  params: UpdateHeartbeatParams,
  deps: UpdateHeartbeatDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/update", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": UPDATE_HEARTBEAT_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-update-heartbeat",
  name: "VC Trader AI Update Heartbeat",
  description:
    "Update an existing Agent Alpha heartbeat policy. cadence and timeout are a single " +
    "coupled write: sending one alone overwrites the other.",
  tools: (tool) => [
    tool({
      name: UPDATE_HEARTBEAT_TOOL_NAME,
      label: "Update Heartbeat",
      description:
        "Update an existing Agent Alpha heartbeat policy. instructions, model_route_key, " +
        "price_symbols and provider_config update independently. cadence_seconds and " +
        "turn_timeout_seconds DO NOT — they are recomputed together and both written, " +
        "so sending one alone silently overwrites the other: turn_timeout_seconds=600 " +
        "alone resets cadence to 660 (= max(180, timeout + 60)), and cadence_seconds=3600 " +
        "alone resets turn_timeout to the 120s default. To change either, send BOTH. " +
        "policy_id is the `policy_id` field of enable_heartbeat's response. This tool " +
        "never touches status: it cannot create, stop or restart a policy, and an unknown " +
        'policy_id returns {policy_id, status: "missing"} with HTTP 200, not an error.',
      parameters: Type.Object(
        {
          policy_id: Type.String({
            description:
              "Heartbeat policy id — the `policy_id` field of enable_heartbeat's response.",
            minLength: 1,
          }),
          cadence_seconds: Type.Optional(
            Type.Integer({
              description:
                "Heartbeat cadence in seconds. Raised server-side to " +
                "max(180, turn_timeout_seconds + 60); above 86400 the call fails with a " +
                "500. Sending this WITHOUT turn_timeout_seconds resets the stored timeout " +
                "to 120.",
              minimum: 180,
              maximum: 86400,
            }),
          ),
          turn_timeout_seconds: Type.Optional(
            Type.Integer({
              description:
                "Per-turn timeout in seconds. Raised server-side to at least 120. Sending " +
                "this WITHOUT cadence_seconds discards the stored cadence and recomputes " +
                "it as max(180, this + 60).",
              minimum: 120,
            }),
          ),
          model_route_key: Type.Optional(
            Type.String({ description: "Model route key, usually heartbeat." }),
          ),
          instructions: Type.Optional(Type.String({ description: "Heartbeat instructions." })),
          price_symbols: Type.Optional(Type.Array(Type.String())),
          provider_config: Type.Optional(Type.Record(Type.String(), Type.Any())),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runUpdateHeartbeat(
          params as UpdateHeartbeatParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
