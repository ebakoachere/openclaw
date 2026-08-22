import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetStrategy, GET_STRATEGY_TOOL_NAME } from "./index.js";

describe("vctraderai-get-strategy", () => {
  it("registers the get_strategy tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_STRATEGY_TOOL_NAME,
      label: "Get Strategy",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      row: {
        strategy_id: "str-1",
        name: "trend_follower_v1",
      },
      // This fixture used to read ["postgres://core.strategies"], inventing a
      // table that does not exist. The real tool's `sources` is produced by
      // `_table_sources("strategy_registry.strategies", ...)`; a live run of the
      // sibling update-preview path emitted exactly
      // ["postgres:strategy_registry.strategies"] (one colon, no slashes).
      sources: ["postgres:strategy_registry.strategies"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetStrategy({ strategy_id: "str-1" }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path including the path parameter", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetStrategy({ strategy_id: "str-1" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/strategies/str-1");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetStrategy({ strategy_id: "str-1" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  // ---------------------------------------------------------------------
  // WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT.
  //
  // The description read "a single strategy row from the propfirm_manager
  // core.strategies catalogue". There is no core.strategies table: a ripgrep of
  // the platform returns 0 occurrences while the control term
  // strategy_registry.strategies returns 423 across 98 files, and the live
  // introspection dump audit/2026-05-22/artifacts/table_list.txt enumerates all
  // 16 core.* tables (asset_classes ... venues) with no `strategies` among them.
  // `engine.agent.tools.registry_tools.get_strategy` reads the workspace-scoped
  // registry head strategy_registry.strategies (+ strategy_versions, + the
  // research.strategy_* manifests) and reports itself as
  // postgres:strategy_registry.strategies.
  //
  // Nothing caught it because the tests only asserted URL shape and error
  // plumbing -- and the happy-path FIXTURE ABOVE repeated the invented name back
  // to itself as `["postgres://core.strategies"]`, so the lie was pinned by the
  // suite rather than exposed by it.
  // ---------------------------------------------------------------------
  it("names the table it actually reads, not a table that does not exist", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/core\.strategies/);
    expect(description).toMatch(/strategy_registry\.strategies/);
  });

  it("describes the identifier forms the resolver really supports", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-strategy" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    // PHASE 1 branches on _is_uuid(probe) and otherwise matches
    // lower(coalesce(display_name, strategy_name)) -- unlike get_strategy_source,
    // which is UUID-only.
    const strategyId = tool.parameters?.properties?.strategy_id?.description ?? "";
    expect(strategyId).toMatch(/UUID/);
    expect(strategyId).toMatch(/case-insensitiv/i);
  });
});
