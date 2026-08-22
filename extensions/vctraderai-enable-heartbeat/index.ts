import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: enable_heartbeat.
//
// Calls the propfirm_manager internal OpenClaw BFF route with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool so the server-side allowlist gates
// the exact tool before running it.
//
// The route is POST /api/v1/openclaw/heartbeat/enable ->
// AgentAlphaHeartbeatService.enable_heartbeat ->
// PostgresHeartbeatPolicyRepository.enable_policy. That repository method mints
// `policy_id = uuid4()` and runs a plain INSERT: there is no upsert, no ON
// CONFLICT on the policy row, and the (workspace_id, thread_id) index is NOT
// unique, so this tool can only CREATE. Accounts are 0..N via a join table.

export const ENABLE_HEARTBEAT_TOOL_NAME = "enable_heartbeat";

export type EnableHeartbeatDeps = {
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

export type EnableHeartbeatParams = Record<string, unknown>;

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai enable_heartbeat: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runEnableHeartbeat(
  params: EnableHeartbeatParams,
  deps: EnableHeartbeatDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/heartbeat/enable", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": ENABLE_HEARTBEAT_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-enable-heartbeat",
  name: "VC Trader AI Enable Heartbeat",
  description:
    "Create an Agent Alpha heartbeat policy through the guarded internal BFF route " +
    "(create-only; use update_heartbeat to change one). Accounts are optional (0..N).",
  tools: (tool) => [
    tool({
      name: ENABLE_HEARTBEAT_TOOL_NAME,
      label: "Enable Heartbeat",
      description:
        "Create a NEW Agent Alpha heartbeat policy; it cannot update one. There is no " +
        "upsert, so a second call for the same thread leaves TWO enabled policies that " +
        "both wake every cycle — to change an existing policy call update_heartbeat " +
        "with the policy_id this call returns. instructions is REQUIRED: an empty or " +
        'whitespace-only value fails as a 500 INTERNAL_ERROR "Unexpected server error.", ' +
        "not a field-level validation error. Timing is silently normalized server-side to " +
        "cadence = max(180, turn_timeout_seconds + 60) and turn_timeout = max(120, " +
        "requested); a resolved cadence above 86400 is a 500. The response is " +
        "{policy_id, status} ONLY and does not echo the stored cadence, so never report " +
        "back the cadence you asked for. account_ids is optional — omit it for an " +
        "account-independent heartbeat.",
      parameters: Type.Object(
        {
          thread_id: Type.Optional(
            Type.String({
              description:
                "Thread id to heartbeat. Omit to use the current turn's thread, which the " +
                "server reads from its own X-OpenClaw-Thread header.",
            }),
          ),
          account_ids: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description:
                "Accounts to check each cycle. OMIT ENTIRELY for an account-independent " +
                "heartbeat, or pass one or more account ids.",
            }),
          ),
          cadence_seconds: Type.Integer({
            description:
              "Heartbeat cadence in seconds. The server raises it to " +
              "max(180, turn_timeout_seconds + 60) without telling you; a resolved " +
              "cadence above 86400 fails with a 500.",
            minimum: 180,
            maximum: 86400,
          }),
          turn_timeout_seconds: Type.Optional(
            Type.Integer({
              description:
                "Per-turn timeout in seconds. The server raises it to at least 120, and it " +
                "in turn raises cadence_seconds to at least this value + 60.",
              minimum: 120,
            }),
          ),
          model_route_key: Type.Optional(
            Type.String({ description: "Model route key, usually heartbeat." }),
          ),
          instructions: Type.String({
            description:
              "Instructions Agent Alpha wakes with. REQUIRED and must be non-empty after " +
              "trimming — the server raises before writing anything and the caller sees " +
              "a 500, not a validation error.",
            minLength: 1,
          }),
          price_symbols: Type.Optional(Type.Array(Type.String())),
          provider_config: Type.Optional(Type.Record(Type.String(), Type.Any())),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEnableHeartbeat(
          params as EnableHeartbeatParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
