import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runUpdateStrategy, UPDATE_STRATEGY_TOOL_NAME } from "./index.js";

describe("vctraderai-update-strategy", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("registers the update_strategy tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-update-strategy" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: UPDATE_STRATEGY_TOOL_NAME,
      label: "Update Strategy",
    });
  });

  it("updates directly through the guarded registry endpoint", async () => {
    const descriptor = { strategy_id: "str-9", version: 2 };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runUpdateStrategy(
      { strategy_id: "str-9", intent_brief: "widen stop" },
      { fetchImpl },
    );
    expect(result).toEqual(descriptor);
  });

  it("posts the update to the guarded registry path", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runUpdateStrategy(
      { strategy_id: "str-9", intent_brief: "widen stop", timeframes: ["H1"] },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/registry/update-strategy");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({
      strategy_id: "str-9",
      intent_brief: "widen stop",
      timeframes: ["H1"],
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runUpdateStrategy({ strategy_id: "str-9" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  // ---------------------------------------------------------------------
  // WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT.
  //
  // The description used to read: "A vbt run(...) artifact remains research-only;
  // a Nautilus promotion names a Strategy class in entry_function with
  // runtime_tag=nautilus." No such promotion exists. `update_strategy_tool`
  // refuses BOTH doors, measured by running the real tool against a stubbed
  // vbt row:
  //   runtime_tag='nautilus' + class entry_function
  //     -> {"error": "runtime_tag is immutable on update. Create the target-runtime
  //         artifact deliberately, then backtest that pinned version."}
  //   class entry_function, runtime_tag omitted (so it defaults to the row's 'vbt')
  //     -> NAUTILUS_CLASS_RUNTIME_REQUIRED, "A class-native entry_function is
  //         permitted only on a nautilus strategy."
  // A matching-tag rename returned a real would_write preview, so both refusals
  // are genuine guard hits and not setup failures. Stronger still: runtime_tag is
  // never written at all -- `sync_registry_on_research_update` is called with
  // source_text/source_kind/entry_function/default_params/display_name only.
  //
  // Every existing test above passes an ordinary metadata edit through a FAKE
  // fetch, so nothing here ever exercised runtime_tag and nothing ever read the
  // description. The suite was green and the tool was lying.
  // ---------------------------------------------------------------------
  const capturedTool = () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-update-strategy" });
    plugin.register(captured.api);
    return captured.tools[0] as {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
  };

  it("does not advertise a Nautilus promotion this tool always refuses", () => {
    const description = capturedTool().description ?? "";
    // Non-vacuity: a `not.toMatch` on an empty string passes, so prove we are
    // looking at a real description first.
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/promotion/i);
    // Positive control for the negative above: the word the old sentence paired
    // with "promotion" is still present, so the regex is searching real text.
    expect(description).toMatch(/nautilus/i);
  });

  it("states that runtime_tag is immutable and names the tool that can set it", () => {
    const description = capturedTool().description ?? "";
    expect(description).toMatch(/runtime_tag is immutable/i);
    expect(description).toMatch(/create_strategy/);
  });

  it("tells the model where the current runtime_tag actually lives", () => {
    // A model told a parameter but not where its only legal value comes from
    // cannot complete the call. get_strategy does NOT return runtime_tag (its
    // PHASE 2 select is strategy_id/name/strategy_type_id/entrypoint/
    // default_params/created_at); list_strategies does.
    const runtimeTag = capturedTool().parameters?.properties?.runtime_tag?.description ?? "";
    expect(runtimeTag.length).toBeGreaterThan(20);
    expect(runtimeTag).toMatch(/immutable/i);
    expect(runtimeTag).toMatch(/list_strategies rows\[\]\.runtime_tag/);
  });

  it("says a class entry_function is only accepted on an already-nautilus strategy", () => {
    const entryFunction = capturedTool().parameters?.properties?.entry_function?.description ?? "";
    expect(entryFunction.length).toBeGreaterThan(20);
    expect(entryFunction).toMatch(/already runtime_tag=nautilus/);
  });
});
