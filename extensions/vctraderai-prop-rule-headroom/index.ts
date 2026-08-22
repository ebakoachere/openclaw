import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: prop_rule_headroom (config-side prop-firm rule thresholds).
//
// Calls the workspace-scoped risk/prop-headroom endpoint as the workspace owner
// (PFM_AGENT_TOKEN) for a variant + account size. POST with a JSON body.
//
// NAME WARNING: despite "headroom", this path returns NO live room. The BFF
// service `preview_prop_headroom` declares no `account_state` parameter and
// `PropHeadroomRequest` is extra="forbid" with only variant_id + account_size,
// so the engine's `account_state` kwarg is structurally unreachable from here.
// Every `room_usd` / `room_pct` is null and `live_available` is false on every
// call; only the static config thresholds are populated.

export const PROP_RULE_HEADROOM_TOOL_NAME = "prop_rule_headroom";

export type PropRuleHeadroomDeps = {
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

export type PropRuleHeadroomParams = {
  variant_id: string;
  account_size: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai prop_rule_headroom: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runPropRuleHeadroom(
  params: PropRuleHeadroomParams,
  deps: PropRuleHeadroomDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const variantId = nonEmpty(params.variant_id);
  // Required fields; the BFF returns 400 otherwise. Guard here so a malformed
  // call fails fast with a clear message instead of a 400.
  if (variantId === undefined) {
    throw new Error("vctraderai prop_rule_headroom: variant_id is required");
  }
  if (typeof params.account_size !== "number") {
    throw new Error("vctraderai prop_rule_headroom: account_size is required (number)");
  }
  // Build the request body from all declared params that are present.
  const body: Record<string, unknown> = {
    variant_id: variantId,
    account_size: params.account_size,
  };
  return bffFetch(`/api/v1/workspaces/${workspaceId}/risk/prop-headroom`, {
    method: "POST",
    body,
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-prop-rule-headroom",
  name: "VC Trader AI Prop Rule Headroom",
  description:
    "Workspace-scoped tool: STATIC prop-firm rule thresholds (profit target / max-DD / daily loss) for a variant + account size, via the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). Never returns live room.",
  tools: (tool) => [
    tool({
      name: PROP_RULE_HEADROOM_TOOL_NAME,
      label: "Prop Rule Headroom",
      description:
        'STATIC per-stage prop-firm rule thresholds for a variant + account size. Returns NO live headroom despite the name: this path cannot receive account state, so `live_available` is false and every `room_usd`/`room_pct` is null on every call. Only config values are populated (`limit_pct`, `target_usd`, `limit_usd_static`, `basis`, `trailing`, `measurement`). Do NOT read `limit_usd_static` as room remaining - it is the FULL allowance, true only on an untouched account; to answer "how much before I breach?" you need live equity/PnL from another tool. Pass `variant_id` from list_prop_firm_challenges `rows[].rule_set_id` and `account_size` from `rows[].account_size` of that same row; a pair with no matching phase is refused 404.',
      parameters: Type.Object({
        variant_id: Type.String({
          description:
            "Prop-firm variant id - the `rows[].rule_set_id` field of a list_prop_firm_challenges response.",
        }),
        account_size: Type.Number({
          description:
            "Account size in USD - the `rows[].account_size` field of that same list_prop_firm_challenges row. Must match a stage row for the variant or the call is refused 404.",
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runPropRuleHeadroom(
          params as PropRuleHeadroomParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
