import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runBuildPropSpec, BUILD_PROP_SPEC_TOOL_NAME } from "./index.js";

describe("vctraderai-build-prop-spec", () => {
  it("registers the build_prop_spec tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-build-prop-spec",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: BUILD_PROP_SPEC_TOOL_NAME,
      label: "Build Prop Spec",
    });
  });

  // The description used to enumerate "per-stage rules, profit target, max
  // drawdown, fee, refund policy" as things this tool composes. "fee" was
  // FALSE: an AST walk of engine/agent/tools/backtest_tools.py shows
  // `_load_prop_spec_from_challenge` has exactly one fee-bearing store —
  // `fee_usd = 0.0` at line 225, unconditional, no branch and no reassignment —
  // and build_prop_spec returns it unchanged through a verbatim BFF wrapper.
  // ADR 0064 Phase 3 moved the entry fee to the dispatch-time field
  // `research.sandbox_configuration_prop.fee_usd`; the canonical public.* prop
  // model has no entry-fee column. 0.0 is a well-formed number, so nothing
  // signalled the value was absent.
  it("describes fee_usd as always 0.0 rather than a composed fee", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-build-prop-spec",
    });
    plugin.register(captured.api);
    const description = captured.tools[0]?.description ?? "";
    // The retired lie: "fee" listed as a composed envelope member.
    expect(description).not.toMatch(/profit target, max drawdown, fee, refund policy/i);
    // The corrected fact plus the reasoning it must not be used for.
    expect(description).toMatch(/`fee_usd` is ALWAYS the literal 0\.0/);
    expect(description).toMatch(/entry fee is NOT composed here/i);
    expect(description).toMatch(/net-of-fee expectancy/i);
    // Where the parameter value lives.
    expect(description).toContain("rows[].challenge_id");
    expect(description).toContain("list_prop_firm_challenges");
  });

  it("returns the prop-spec envelope verbatim on the happy path", async () => {
    // Was a fabricated shape (top-level challenge_id / profit_target_pct /
    // max_drawdown_pct, `sources` as a postgres:// URL, no fee_usd at all).
    // Because it omitted fee_usd entirely, the suite stayed green while the
    // description advertised a fee the envelope never carries. This is the real
    // shape returned by build_prop_spec: {prop_spec, fee_usd, refund_policy,
    // stages, sources}, with _table_sources rendering "postgres:<table>".
    const envelope = {
      prop_spec: {
        provider: "The5ers",
        program: "High Stakes",
        rule_set_id: "11111111-1111-1111-1111-111111111111",
        stages: [{ name: "phase_1", stage_type: "evaluation", initial_balance: 100000 }],
        rules_snapshot: [{ phase_number: 1 }],
        defaults_applied: {},
      },
      fee_usd: 0.0,
      refund_policy: { type: "full_fee_refund" },
      stages: [{ phase_number: 1 }],
      sources: ["postgres:public.prop_firm_variants", "postgres:public.prop_firm_phases"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = (await runBuildPropSpec(
      { challenge_id: "the5ers-100k-stage1" },
      { fetchImpl },
    )) as typeof envelope;
    expect(result).toEqual(envelope);
    // Pin the corrected fact: the key is present and numerically plausible, and
    // is 0.0 even beside a full_fee_refund policy — so a refund computed from
    // it is 0.0 too. That silence is the whole defect.
    expect(result.fee_usd).toBe(0);
    expect(result.refund_policy.type).toBe("full_fee_refund");
  });

  it("calls the BFF catalogue/prop-spec endpoint with GET and a challenge_id query", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/prop-spec");
    expect(parsed.searchParams.get("challenge_id")).toBe("the5ers-100k-stage1");
    expect(capturedMethod).toBe("GET");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runBuildPropSpec({ challenge_id: "the5ers-100k-stage1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
