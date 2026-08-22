import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: generate_session_playbook. DEAD ON THIS SURFACE.
//
// Two measured facts, both against propfirm_manager as of 2026-08-22:
//
//  1. `generate_session_playbook` is in core/openclaw/allowlist.py's
//     RETIRED_ENGINE_TOOLS and absent from the 133-entry ALLOWLIST.
//  2. The path below, `POST /api/v1/openclaw/playbooks/session`, matches NO
//     route on the assembled app (Starlette Match.NONE; positive controls
//     POST /api/v1/openclaw/notifications/send and GET /api/v1/reports/daily
//     both match FULL). So the call 404s.
//
// It was ALSO never read-only. This header used to say "the BFF persists
// nothing on this path". The only implementation of the generator anywhere,
// engine/agent/specialists/session_playbook.py, ends generate() with an
// unconditional save_playbook -> `insert into research.session_playbooks ...`
// + conn.commit(), and returns that row's id; generation spends an LLM call
// (llm_provider / llm_model / generation_time_ms are columns on the row).
// ADR 0078 defines read_only as "no side effects beyond an audit row" and does
// not list this tool, so the ADR refuted the label rather than granting it.

export const GENERATE_SESSION_PLAYBOOK_TOOL_NAME = "generate_session_playbook";

export type GenerateSessionPlaybookDeps = {
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

export type GenerateSessionPlaybookParams = {
  workspace_id: string;
  session: string;
};

export async function runGenerateSessionPlaybook(
  params: GenerateSessionPlaybookParams,
  deps: GenerateSessionPlaybookDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const body: Record<string, unknown> = {
    workspace_id: params.workspace_id,
    session: params.session,
  };
  return bffFetch("/api/v1/openclaw/playbooks/session", {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-generate-session-playbook",
  name: "VC Trader AI Generate Session Playbook",
  description: "Session playbook generator - retired; its route no longer exists.",
  tools: (tool) => [
    tool({
      name: GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
      label: "Generate Session Playbook",
      description:
        "UNAVAILABLE - do not call. This tool is retired from the OpenClaw allowlist and the " +
        "route it posts to (/api/v1/openclaw/playbooks/session) matches no route, so every call " +
        "returns 404 and no playbook. It is also NOT read-only where it does run: the generator " +
        "spends an LLM call and inserts a row into research.session_playbooks.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
        session: Type.String({
          description:
            "london, new_york, tokyo or sydney (case-insensitive). Anything else - including " +
            "every code list_sessions returns (ASIA, LDN, NY, TWENTYFOUR_HR) - is SILENTLY " +
            "coerced to london with no error.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runGenerateSessionPlaybook(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
