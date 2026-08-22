import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runPropRuleHeadroom,
  PROP_RULE_HEADROOM_TOOL_NAME,
  type PropRuleHeadroomParams,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

// The real config-side response, measured by running
// engine.backtests.prop_rule_headroom.prop_rule_headroom(spec=spec) exactly as
// the BFF invokes it (no account_state) against a synthetic 100k PropSpec with
// an 8% profit target, a 10% static max loss and a 5% daily loss. Every room
// value is null; only the static thresholds carry numbers. The five
// config-threshold rules (minimum_profitable_days, max_trading_days,
// inactivity, mandatory_sl, news_restriction) carry no room key at all.
const PROP_HEADROOM_RESPONSE = {
  data: {
    provider: "SynthFirm",
    program: "Synth100k",
    live_available: false,
    stages: [
      {
        stage: "phase_1",
        stage_type: "evaluation",
        initial_balance: 100000.0,
        rules: {
          profit_target: {
            limit_pct: 0.08,
            measurement: "balance",
            target_usd: 8000.0,
            progress_usd: null,
            room_usd: null,
            room_pct: null,
            live_available: false,
          },
          max_loss: {
            limit_pct: 0.1,
            basis: "balance",
            trailing: "static",
            limit_usd_static: 10000.0,
            reference_usd: null,
            drawdown_usd: null,
            room_usd: null,
            room_pct: null,
            live_available: false,
          },
          max_daily_loss: {
            limit_pct: 0.05,
            basis: "balance",
            includes_unrealised: true,
            limit_usd_static: 5000.0,
            loss_today_usd: null,
            room_usd: null,
            room_pct: null,
            live_available: false,
          },
          minimum_profitable_days: { config: { days: 3 }, live_available: false },
        },
      },
    ],
  },
  trace_id: "trace-001",
};

describe("vctraderai-prop-rule-headroom", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalAgentToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalAgentToken;
    }
  });

  it("registers the prop_rule_headroom tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-prop-rule-headroom" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: PROP_RULE_HEADROOM_TOOL_NAME,
      label: "Prop Rule Headroom",
    });
  });

  // The description used to end: "Returns the room remaining against each
  // prop-firm rule for that variant at the given account size." That was FALSE.
  // `preview_prop_headroom` (web_api/risk_tools/service.py) declares no
  // `account_state` parameter and `PropHeadroomRequest` is extra="forbid" with
  // only variant_id + account_size, so the engine's `account_state` kwarg is
  // structurally unreachable through this tool. Running the engine function the
  // way the BFF invokes it (prop_rule_headroom(spec=spec), 100k / 8% target /
  // 10% max loss / 5% daily loss) returns live_available=false with room_usd and
  // room_pct null on profit_target, max_loss and max_daily_loss — only
  // target_usd=8000.0, limit_usd_static=10000.0 and limit_usd_static=5000.0 are
  // populated. The old suite never looked at the description at all, so a green
  // run said nothing about it; these assertions pin the corrected fact.
  it("describes itself as static thresholds only and never promises live room", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-prop-rule-headroom" });
    plugin.register(captured.api);
    const description = captured.tools[0]?.description ?? "";
    // The retired lie must not come back in any form.
    expect(description).not.toMatch(/room remaining against each prop-firm rule/i);
    expect(description).not.toMatch(/returns the room remaining/i);
    // The refusal the model would otherwise walk into.
    expect(description).toContain("Returns NO live headroom");
    expect(description).toMatch(/`live_available` is false/);
    expect(description).toMatch(/`room_usd`\/`room_pct` is null on every call/);
    // The false-calm substitution the harm turns on.
    expect(description).toMatch(/Do NOT read `limit_usd_static` as room remaining/);
    // Where the parameter values actually live.
    expect(description).toContain("list_prop_firm_challenges");
    expect(description).toContain("rows[].rule_set_id");
    expect(description).toContain("rows[].account_size");
  });

  it("POSTs a JSON body to the workspace-scoped risk/prop-headroom endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "GET";
    let capturedAuth: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedContentType = headers.get("content-type");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      // Was: { profit_target_room: 1000, max_dd_room: 2000, daily_loss_room: 500 }
      // — a fixture the endpoint can never produce. It invented populated room
      // fields and so quietly corroborated the false description. Replaced with
      // the shape MEASURED off the engine (POST /risk/prop-headroom wraps the
      // engine dict as {data, trace_id} per RiskToolEnvelope).
      return new Response(JSON.stringify(PROP_HEADROOM_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runPropRuleHeadroom({ variant_id: "variant-1", account_size: 100000 }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/risk/prop-headroom`);
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({ variant_id: "variant-1", account_size: 100000 });
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("passes through a response whose room values are all null", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(PROP_HEADROOM_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = (await runPropRuleHeadroom(
      { variant_id: "variant-1", account_size: 100000 },
      { fetchImpl },
    )) as typeof PROP_HEADROOM_RESPONSE;
    // This is what the description now promises, and what the engine actually
    // produces on this path: config thresholds populated, room absent.
    expect(result.data.live_available).toBe(false);
    const rules = result.data.stages[0].rules;
    for (const key of ["profit_target", "max_loss", "max_daily_loss"] as const) {
      expect(rules[key].room_usd).toBeNull();
      expect(rules[key].room_pct).toBeNull();
      expect(rules[key].live_available).toBe(false);
    }
    // The static thresholds ARE populated — which is exactly why the old
    // "room remaining" wording was dangerous: limit_usd_static sits beside a
    // null room_usd and reads as the answer, while being the full untouched
    // daily-loss budget.
    expect(rules.profit_target.target_usd).toBe(8000);
    expect(rules.max_loss.limit_usd_static).toBe(10000);
    expect(rules.max_daily_loss.limit_usd_static).toBe(5000);
    // Config-threshold rules carry no room key at all.
    expect(rules.minimum_profitable_days).not.toHaveProperty("room_usd");
  });

  it("requires variant_id and account_size", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(
      runPropRuleHeadroom({ variant_id: "", account_size: 100000 }, { fetchImpl }),
    ).rejects.toThrow(/variant_id is required/);
    await expect(
      runPropRuleHeadroom({ variant_id: "variant-1" } as PropRuleHeadroomParams, { fetchImpl }),
    ).rejects.toThrow(/account_size is required/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(
      runPropRuleHeadroom({ variant_id: "variant-1", account_size: 100000 }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });
});
