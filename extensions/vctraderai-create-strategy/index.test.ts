import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runCreateStrategy, CREATE_STRATEGY_TOOL_NAME } from "./index.js";

describe("vctraderai-create-strategy", () => {
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

  it("registers the create_strategy tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-strategy" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_STRATEGY_TOOL_NAME,
      label: "Create Strategy",
    });
  });

  it("creates directly through the guarded registry endpoint", async () => {
    const descriptor = { strategy_id: "strategy-1", source_kind: "python_authored" };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runCreateStrategy(
      {
        intent_brief: "trend-follow EURUSD",
        name: "Trendy",
        runtime_tag: "vbt",
        entry_function: "run",
        source_text: "def run(data, params=None, context=None):\n    return {}",
      },
      { fetchImpl },
    );
    expect(result).toEqual(descriptor);
  });

  it("posts authored source to the guarded registry path", async () => {
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
    await runCreateStrategy(
      {
        intent_brief: "mean reversion",
        name: "MR",
        instruments: ["EUR_USD"],
        runtime_tag: "vbt",
        entry_function: "run",
        source_text: "def run(data, params=None, context=None):\n    return {}",
      },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/registry/create-strategy");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({
      intent_brief: "mean reversion",
      name: "MR",
      instruments: ["EUR_USD"],
      source_text: "def run(data, params=None, context=None):\n    return {}",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runCreateStrategy(
        {
          // `name` is REQUIRED (see the block below); this call used to omit it,
          // quietly modelling the very shape the BFF rejects with a 422.
          name: "X",
          intent_brief: "x",
          runtime_tag: "vbt",
          entry_function: "run",
          source_text: "def run(data, params=None, context=None):\n    return {}",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  // ---------------------------------------------------------------------
  // WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT.
  //
  // `name` was declared `Type.Optional(...)` with the description "Human-readable
  // strategy name.", and the tool description named only source_text as required.
  // On the agent path `name` is required, harder than source_text is:
  //   - web_api/openclaw_internal/router.py
  //     `_REGISTRY_CREATE_STRATEGY_REQUIRED = ("name", "source_text")`, checked
  //     pre-dispatch as `not str(kwargs.get(key) or "").strip()` -> HTTP 422
  //     `openclaw_registry_mutation_failed`, "create_strategy is missing required
  //     field(s): name." Verified by running that predicate over omitted / None /
  //     "" / "   " (all missing) and "My Strat" (not missing).
  //   - Behind it, `create_strategy_tool(*, name: str, ...)` has NO default:
  //     calling it without name raises TypeError. `source_text`, the one field
  //     the schema DID mark required, defaults to None there.
  // Every test above happened to pass a name, or (the 500 case) never reached a
  // real server -- so a schema that told the model `name` was optional stayed
  // green while a name-less call would 422 in production.
  // ---------------------------------------------------------------------
  const capturedTool = () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-strategy" });
    plugin.register(captured.api);
    return captured.tools[0] as {
      description?: string;
      parameters?: {
        required?: string[];
        properties?: Record<string, { description?: string }>;
      };
    };
  };

  it("declares name as required in the schema the model actually sees", () => {
    const required = capturedTool().parameters?.required ?? [];
    // Control: source_text was already required, so a passing `name` assertion
    // is not passing because `required` is empty or unread.
    expect(required).toContain("source_text");
    expect(required).toContain("name");
    expect(required).toContain("runtime_tag");
    expect(required).toContain("entry_function");
  });

  it("says in the description that both name and source_text are required", () => {
    const description = capturedTool().description ?? "";
    expect(description.length).toBeGreaterThan(80);
    expect(description).toMatch(/runtime_tag/);
    expect(description).toMatch(/StrategyConfig/);
  });

  it("names the refusal on the name parameter itself", () => {
    const name = capturedTool().parameters?.properties?.name?.description ?? "";
    expect(name).toMatch(/Required/);
    expect(name).toMatch(/whitespace-only/);
  });
});
