import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: build_prop_spec.
//
// READ_ONLY per ADR 0078. Calls the BFF
// `GET /api/v1/openclaw/catalogue/prop-spec?challenge_id=<id>` endpoint, which
// forwards `challenge_id` to the propfirm_manager engine function
// `engine.agent.tools.backtest_tools.build_prop_spec(challenge_id)` and returns
// the envelope {prop_spec, fee_usd, refund_policy, stages, sources} for one
// prop-firm challenge template. No mutation - the spec is rebuilt on each call
// from public.prop_firm_variants + public.prop_firm_phases.
//
// FEE WARNING: `fee_usd` is the hardcoded literal 0.0 for EVERY challenge.
// ADR 0064 Phase 3 moved the per-challenge entry fee to the dispatch-time field
// `research.sandbox_configuration_prop.fee_usd`; the canonical public.* prop
// model this resolver reads has no entry-fee column, so nothing is composed
// into it. `refund_policy` IS real (from public.prop_firm_payout_rules), but a
// refund amount computed against fee_usd=0.0 is always 0.0.
//
// The challenge_id comes from list_prop_firm_challenges (the catalogue). NOTE
// the engine signature is build_prop_spec(challenge_id) - a single challenge id
// - NOT (prop_firm_id, account_size); GET /catalogue/prop-spec is the matching
// BFF surface (the workspace-agnostic openclaw read-only-tool family), and the
// only one the per-plugin egress allowlist admits (the openclaw segment after
// /openclaw/ must be [a-z]+, so the legacy /openclaw/prop-spec/build path was
// rejected before a socket opened).

export const BUILD_PROP_SPEC_TOOL_NAME = "build_prop_spec";

export type BuildPropSpecDeps = {
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

export type BuildPropSpecParams = {
  challenge_id: string;
};

export async function runBuildPropSpec(
  params: BuildPropSpecParams,
  deps: BuildPropSpecDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/catalogue/prop-spec", {
    query: { challenge_id: params.challenge_id },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-build-prop-spec",
  name: "VC Trader AI Build Prop Spec",
  description: "Read-only builder for a prop-firm challenge spec envelope.",
  tools: (tool) => [
    tool({
      name: BUILD_PROP_SPEC_TOOL_NAME,
      label: "Build Prop Spec",
      description:
        "Compose and return the prop-firm challenge spec envelope for one challenge template: {prop_spec, stages (per-stage rules incl. profit target and max drawdown), refund_policy, fee_usd, sources}. `fee_usd` is ALWAYS the literal 0.0 - the entry fee is NOT composed here (it is a dispatch-time field), so never use it for entry cost, net-of-fee expectancy, challenge ranking or refund amounts; a `full_fee_refund` policy against it computes 0.0. Pass `challenge_id` from the `rows[].challenge_id` field of a list_prop_firm_challenges response; a challenge not mapped to a public variant is refused. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        challenge_id: Type.String({
          description:
            "Prop-firm challenge template identifier - must match a `rows[].challenge_id` value returned by list_prop_firm_challenges.",
          minLength: 1,
        }),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runBuildPropSpec(params, { threadId: context.threadId }, context.signal);
      },
    }),
  ],
});
