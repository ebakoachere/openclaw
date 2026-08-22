import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runGetSituationalAwareness,
  GET_SITUATIONAL_AWARENESS_TOOL_NAME,
} from "./index.js";

const WORKSPACE_ID = "6c9176ed-88b4-404f-8b51-70cd63cdeeff";

describe("vctraderai-get-situational-awareness", () => {
  let priorWorkspaceId: string | undefined;

  beforeEach(() => {
    priorWorkspaceId = process.env.PFM_WORKSPACE_ID;
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });

  afterEach(() => {
    if (priorWorkspaceId === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = priorWorkspaceId;
    }
  });

  function captured(): any {
    const registration = createCapturedPluginRegistration({
      id: "vctraderai-get-situational-awareness",
    });
    plugin.register(registration.api);
    return registration.tools[0] as any;
  }

  // Type.Optional may render either inline or as a union depending on the
  // typebox build; unwrap so the assertion reads the real parameter schema.
  function param(name: string): any {
    const raw = captured().parameters.properties[name];
    return raw?.type ? raw : (raw?.anyOf?.[0] ?? raw);
  }

  it("registers the get_situational_awareness tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({
      id: "vctraderai-get-situational-awareness",
    });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({
      name: GET_SITUATIONAL_AWARENESS_TOOL_NAME,
      label: "Get Situational Awareness",
    });
  });

  // FALSE DESCRIPTION (fixed), part 1: the tool advertised "risk-budget
  // headroom" as its first payload item. No TRADING risk headroom is ever
  // returned. gather_situational_bundle reads the caps via
  // read_config(..., store=get_default_store()); get_default_store() returns a
  // process-global InMemoryRiskConfigStore whose `identities` map has ZERO
  // production writers (register_account's only callers are two test modules),
  // so resolve_identity returns None, read_config raises unknown_account, and
  // the best-effort except degrades BOTH members. Measured by running the real
  // gatherer: daily_loss and drawdown come back {label: "unavailable"} on every
  // call. This is not a missing-DB artifact -- the production risk_config
  // router reads that same empty store, and PostgresRiskConfigStore is
  // instantiated nowhere.
  //
  // The member that DOES carry a number, llm_spend_cap, is an LLM API spend
  // budget, not the trading budget the phrase "risk-budget headroom" implies.
  it("does not promise trading risk headroom, and separates llm_spend_cap from it", () => {
    const description = String(captured().description ?? "");
    expect(description).not.toMatch(/risk-budget headroom/);
    expect(description).toMatch(/NO trading risk headroom/);
    expect(description).toMatch(/daily_loss and \.drawdown are always \{label: "unavailable"\}/);
    expect(description).toMatch(/LLM API spend budget, not a trading budget/);
  });

  // FALSE DESCRIPTION (fixed), part 2: the tool advertised "account-health" as
  // snapshot content and documented account_id as scoping it. On this route the
  // block is always unavailable. _default_account_health_source calls
  // engine.agent.tools.live_trading_read_tools.get_live_account_state, whose
  // _agent_config() requires PFM_BFF_BASE_URL / PFM_AGENT_TOKEN /
  // PFM_AGENT_WORKSPACE_ID -- an AGENT-container env triple that is not set on
  // the web_api ECS task serving this endpoint (infra/terraform/ecs.tf:346 is
  // the only `uvicorn web_api.main:app` task and none of the three appear in
  // it). market_regime dies by the identical mechanism via
  // perception_tools.classify_regime. Both were measured by running the real
  // functions with the triple absent:
  //   {"error": "PFM_BFF_BASE_URL is not configured for this agent."}
  //
  // WHY THE GREEN SUITE HID IT: every platform test injects a fake
  // account_health_source or stubs the whole gather with label "live", and this
  // plugin's own happy-path test used a hand-built snapshot fixture asserting
  // {status: "healthy"}. Nothing ever exercised the real production path.
  it("states that account_health and market_regime are unavailable, and names the alternative", () => {
    const description = String(captured().description ?? "");
    expect(description).toMatch(/account_health and market_regime are also always/);
    expect(description).toMatch(/PFM_BFF_BASE_URL is not configured for this agent/);
    expect(description).toMatch(/get_live_account_state/);
  });

  // Consequence, measured by running the real _derive_posture: _DEGRADED_LABELS
  // is frozenset({"fail_closed", "unavailable"}) and both cap members are
  // permanently unavailable, so even a best-case bundle returns "degraded".
  // Positive control from the same run: an all-live bundle returns "normal",
  // so the derivation is not hardwired -- the caps are what pin it.
  it("warns that overall_posture can never be normal or caution", () => {
    const description = String(captured().description ?? "");
    expect(description).toMatch(/overall_posture is always "degraded" or "locked"/);
    expect(description).toMatch(/never be "normal" or "caution"/);
  });

  // FALSE DESCRIPTION (fixed), part 3: "instrument narrows regime/econ
  // context". It narrows the regime block ONLY. gather_situational_bundle calls
  // econ_source(workspace_id=ws) -- instrument is never forwarded -- and the
  // default source is econ_calendar_tail(n=5), whose only parameter is n (fixed
  // now..now+48h window, statuses=['active'], no symbol/currency filter).
  // _econ_block receives instrument but its only use is a comment and a bare
  // `pass`. Measured by running the real gatherer twice: the econ block is
  // byte-identical with instrument=None and instrument="XAUUSD", while the
  // regime block differs. A model reading next_high_impact as gold-relevant is
  // reading the whole calendar for any currency.
  it("scopes instrument to market_regime only and says econ is the whole-workspace calendar", () => {
    const tool = captured();
    const description = String(tool.description ?? "");
    expect(description).not.toMatch(/narrows regime\/econ context/);
    expect(description).toMatch(/NOT filtered by instrument/);
    expect(description).toMatch(/whole-workspace calendar for the next 48 hours/);
    const instrument = String(param("instrument").description ?? "");
    expect(instrument).toMatch(/Applied ONLY to market_regime/);
    expect(instrument).toMatch(/never applied to econ_news_proximity/);
  });

  // account_id is not inert -- it is also passed to the autonomous_unlock
  // consult, which does return a value -- so the parameter text must not claim
  // it does nothing.
  it("describes what account_id actually reaches", () => {
    const accountId = String(param("account_id").description ?? "");
    expect(accountId).toMatch(/autonomous_unlock/);
    expect(accountId).toMatch(/account_health and market_regime/);
  });

  // Was: a hand-built fixture with `risk_budget: {used_pct, remaining_pct}` and
  // `account_health: {status: "healthy"}` -- fields the route has never
  // returned. It passed because the plugin is pass-through, so the fixture
  // tested the author's BELIEF about the payload rather than the payload. This
  // version uses the block shape measured from the real gatherer.
  it("returns the situational-awareness snapshot verbatim on the happy path", async () => {
    const snapshot = {
      kind: "situational_awareness_snapshot",
      overall_posture: "degraded",
      stale_labels: ["account_health:unavailable", "market_regime:unavailable"],
      metaapi_used: false,
      risk_budget: {
        daily_loss: { label: "unavailable", source: "risk_config" },
        drawdown: { label: "unavailable", source: "risk_config" },
        llm_spend_cap: {
          allowed: true,
          current_cents: 0,
          cap_cents: 0,
          label: "live",
          source: "workspace_llm_usage",
        },
      },
      market_regime: {
        label: "unavailable",
        source: "classify_regime",
        error: "PFM_BFF_BASE_URL is not configured for this agent.",
      },
      econ_news_proximity: {
        label: "stale",
        source: "econ_calendar_tail",
        next_high_impact: null,
        events_window: [],
      },
      account_health: {
        label: "unavailable",
        source: "get_live_account_state",
        error: "PFM_BFF_BASE_URL is not configured for this agent.",
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetSituationalAwareness({}, { fetchImpl });
    expect(result).toEqual(snapshot);
  });

  it("calls the situational-awareness path and forwards workspace + params + tool header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedInit = init;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSituationalAwareness({ account_id: "acc-1", instrument: "XAUUSD" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/situational-awareness");
    expect(parsed.searchParams.get("workspace_id")).toBe(WORKSPACE_ID);
    expect(parsed.searchParams.get("account_id")).toBe("acc-1");
    expect(parsed.searchParams.get("instrument")).toBe("XAUUSD");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-openclaw-tool")).toBe(GET_SITUATIONAL_AWARENESS_TOOL_NAME);
  });

  it("omits undefined optional params from the query string", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSituationalAwareness({}, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("workspace_id")).toBe(WORKSPACE_ID);
    expect(parsed.searchParams.has("account_id")).toBe(false);
    expect(parsed.searchParams.has("instrument")).toBe(false);
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetSituationalAwareness({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  it("throws when PFM_WORKSPACE_ID is not set", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runGetSituationalAwareness({}, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
