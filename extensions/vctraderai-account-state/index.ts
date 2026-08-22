import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: account_state.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// two workspace-scoped BFF reads and returns their composed payload. The
// helper guards path egress; the docker sandbox guards network egress.
//
// KNOWN BROKEN for the agent caller, measured against the running app:
//   1. GET /api/v1/workspaces/{ws}/accounts is guarded by require_session
//      (web_api/accounts/v3/router.py:407), and require_session resolves claims
//      from the session COOKIE only (web_api/platform/dependencies.py:37-45).
//      A request carrying the plugin's exact header set and no cookie returns
//      401 {"code":"AUTH_REQUIRED"}. The sibling read /dashboard/home uses
//      require_session_or_agent and gets past auth. Promise.all rejects on the
//      first rejection, so BOTH halves are lost.
//   2. src/internal-http-client.ts reads OPENCLAW_GATEWAY_TOKEN, but
//      core/openclaw/provisioning_constants.py:104-111 names PFM_AGENT_TOKEN as
//      the bearer for /workspaces/{ws}/* calls (which is what every sibling
//      account plugin reads), so the dashboard half is mis-authenticated too.
// Fixing either requires platform/client changes outside this description pass;
// until then the tool description must say the call fails.

export const ACCOUNT_STATE_TOOL_NAME = "account_state";

export type AccountStateResult = {
  stats: unknown;
  accounts: unknown;
};

export type AccountStateDeps = {
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

export async function runAccountState(
  workspaceId: string,
  deps: AccountStateDeps = {},
  signal?: AbortSignal,
): Promise<AccountStateResult> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const [stats, accounts] = await Promise.all([
    bffFetch(`/api/v1/workspaces/${workspaceId}/dashboard/home`, { signal }),
    bffFetch(`/api/v1/workspaces/${workspaceId}/accounts`, {
      signal,
      query: { state: "active" },
    }),
  ]);
  return { stats, accounts };
}

export default defineToolPlugin({
  id: "vctraderai-account-state",
  name: "VC Trader AI Account State",
  description:
    "Read-only inspector for workspace account state. Its accounts read is browser-session-only, so it fails for agent callers.",
  tools: (tool) => [
    tool({
      name: ACCOUNT_STATE_TOOL_NAME,
      label: "Account State",
      description:
        "Read-only; DOES NOT WORK from an agent. Its accounts read (GET /workspaces/{id}/accounts) accepts only a browser session cookie and answers a bearer-token call with 401 AUTH_REQUIRED, which fails the whole tool - the dashboard half is discarded with it. Use list_my_accounts (data.rows) or get_account_snapshot (mt5_account_id from those rows) instead.",
      parameters: Type.Object({
        workspace_id: Type.String({
          description: "Workspace UUID (lowercase hex with dashes).",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAccountState(params.workspace_id, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
