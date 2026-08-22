import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_my_accounts.
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Calls
// the workspace-scoped BFF read as the workspace owner (PFM_AGENT_TOKEN) and
// returns the verbatim envelope.

export const LIST_MY_ACCOUNTS_TOOL_NAME = "list_my_accounts";

export type ListMyAccountsDeps = {
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

export type ListMyAccountsParams = {
  limit?: number;
  purpose?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_my_accounts: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListMyAccounts(
  params: ListMyAccountsParams = {},
  deps: ListMyAccountsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/openclaw/live/my-accounts`, {
    query: {
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      purpose: params.purpose,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-my-accounts",
  name: "VC Trader AI List My Accounts",
  description: "Read-only workspace-scoped tool: list the workspace owner's MT5 accounts.",
  tools: (tool) => [
    tool({
      name: LIST_MY_ACCOUNTS_TOOL_NAME,
      label: "List My Accounts",
      description:
        "List the workspace owner's MT5 accounts (read-only, workspace-scoped). Returns data.rows[]; each row's mt5_account_id is the id get_account_snapshot takes. A refusal comes back as HTTP 200 with data.error set and zero rows, so check data.error before concluding there are no accounts.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum accounts to return (default 100).",
            minimum: 1,
            maximum: 500,
          }),
        ),
        purpose: Type.Optional(
          Type.String({
            description:
              "Optional filter. ONLY 'personal_journaling' or 'live_bot' is accepted; any other value is refused in-band (HTTP 200, data.error, zero rows). Omit to return both kinds.",
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListMyAccounts(
          params as ListMyAccountsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
