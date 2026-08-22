import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetStrategySource, GET_STRATEGY_SOURCE_TOOL_NAME } from "./index.js";

describe("vctraderai-get-strategy-source", () => {
  it("registers the get_strategy_source tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy-source" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_STRATEGY_SOURCE_TOOL_NAME,
      label: "Get Strategy Source",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      strategy_id: "str-1",
      source: "def strategy(...): ...",
      // Was ["postgres://core.strategies"], a table that does not exist anywhere
      // in the platform. get_strategy_source reports
      // _table_sources("strategy_registry.strategy_versions").
      sources: ["postgres:strategy_registry.strategy_versions"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path including the path parameter", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/strategies/str-1/source");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGetStrategySource({ strategy_id: "str-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  // ---------------------------------------------------------------------
  // WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT.
  //
  // strategy_id was described as "Strategy identifier (UUID or short slug)" --
  // the SAME sentence the sibling get_strategy carries, where it is true. Here it
  // is not. `get_strategy_source`'s PHASE 1 entitlement probe is a bare
  //   select 1 from strategy_registry.strategies where strategy_id = %s limit 1
  // and `core.research_registry._resolve_registry_source_row` filters on
  // strategy_id in all three of its branches (pinned version_label,
  // deployment-pinned version_id, head current_version_id). There is no
  // _is_uuid branch and no name fallback, against a `strategy_id uuid primary
  // key` column -- whereas get_strategy explicitly falls back to
  // lower(coalesce(display_name, strategy_name)). The router's own docstring
  // lists get_strategy/get_indicator/get_risk_manager/get_trader as the tools
  // where "UUID or name both work" and pointedly omits this one.
  //
  // The suite never noticed because every test here passes the literal "str-1"
  // through a FAKE fetch: no resolver runs, so a slug and a UUID look identical.
  // The docs half of the trap survived for the same reason -- and the happy-path
  // fixture above additionally echoed a non-existent core.strategies table.
  // ---------------------------------------------------------------------
  it("does not claim the slug lookup that only get_strategy has", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy-source" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const strategyId = tool.parameters?.properties?.strategy_id?.description ?? "";
    // Non-vacuity before the negative assertion.
    expect(strategyId.length).toBeGreaterThan(40);
    expect(strategyId).not.toMatch(/slug\)/);
    expect(strategyId).toMatch(/Only a UUID resolves here/);
    // A model told the parameter but not where its value lives cannot complete
    // the call, so the description must name the producing tool AND field.
    expect(strategyId).toMatch(/list_strategies rows\[\]\.strategy_id/);
    expect(strategyId).toMatch(/get_strategy row\.strategy_id/);
  });

  it("names the version table it reads instead of a generic catalogue", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy-source" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/core\.strategies/);
    expect(description).toMatch(/strategy_registry\.strategy_versions/);
  });
});
