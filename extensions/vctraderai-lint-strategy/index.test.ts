import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runLintStrategy, LINT_STRATEGY_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-lint-strategy", () => {
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

  it("registers the lint_strategy tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-lint-strategy" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LINT_STRATEGY_TOOL_NAME,
      label: "Lint Strategy",
    });
  });

  it("POSTs a JSON body to the workspace-scoped strategy-authoring/lint endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "GET";
    let capturedAuth: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: { source?: string; entry_function?: string } | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedContentType = headers.get("content-type");
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ data: { passed: true, errors: [] }, trace_id: "t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runLintStrategy(
      { source: "def run(data, params, context):\n    return {}\n", entry_function: "run" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/strategy-authoring/lint`);
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toEqual({
      source: "def run(data, params, context):\n    return {}\n",
      entry_function: "run",
    });
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("omits entry_function from the body when not provided", async () => {
    let capturedBody: { source?: string; entry_function?: string } | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runLintStrategy({ source: "def run(): pass" }, { fetchImpl });
    expect(capturedBody).toEqual({ source: "def run(): pass" });
  });

  it("requires source", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runLintStrategy({ source: "" }, { fetchImpl })).rejects.toThrow(
      /source is required/,
    );
    await expect(runLintStrategy({} as { source: string }, { fetchImpl })).rejects.toThrow(
      /source is required/,
    );
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(
      runLintStrategy({ source: "def run(): pass" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });

  // ---------------------------------------------------------------------
  // WHAT WAS FALSE BEFORE, AND WHAT IS FALSE NOW.
  //
  // ROUND ONE (v1.42.8). The description ended with the unconditional directive
  // "Use it to VALIDATE and REPAIR source BEFORE calling create_strategy",
  // which was true only for a vbt/Shape-A source: the BFF route picks its
  // contract with `is_class_native_artifact(runtime_tag, entry_function)` and
  // this plugin never sent runtime_tag, so the six-key path always ran and a
  // correct Nautilus class came back with 3x AST_GUARD_REJECTION telling the
  // model to delete its nautilus_trader imports. The fix then was a WARNING in
  // the description: "do not lint a Nautilus class here".
  //
  // ROUND TWO (this change). The warning is now the lie. WS-2/WS-4 landed
  // `runtime_tag`, `manifest` and `default_params` on `LintStrategyRequest`
  // (web_api/strategy_authoring/schemas.py, extra="forbid"), and the authoring
  // guide tells the agent to call lint_strategy WITH them -- a promise this
  // plugin could not keep, because it still sent `{source, entry_function}`
  // only. A tool that refuses the very artifact the guide tells the agent to
  // lint is worse than no tool: the agent follows the fix_hints and destroys a
  // deployable class. So the body forwards all three when present, and the
  // description says to lint Nautilus classes HERE and to trust the hints.
  //
  // The tests below therefore pin the NEW contract. The old ones pinned the
  // absence of runtime_tag and the presence of the warning; both were correct
  // for v1.42.8 and are wrong for this lineage.
  // ---------------------------------------------------------------------
  const capturedTool = () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-lint-strategy" });
    plugin.register(captured.api);
    return captured.tools[0] as {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
  };

  it("does not present itself as the validator for every create_strategy shape", () => {
    const description = capturedTool().description ?? "";
    // Non-vacuity before the negative assertions.
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/Use it to VALIDATE and REPAIR source BEFORE calling/);
    expect(description).toMatch(/create_strategy/); // control: the name is still there
  });

  it("tells the agent to lint a Nautilus class HERE, and to trust the hints", () => {
    const description = capturedTool().description ?? "";
    // Non-vacuity first: there is a real description to assert against.
    expect(description.length).toBeGreaterThan(80);
    // The v1.42.8 warning is now false and must be gone -- it would send the
    // agent away from the only tool that can pre-validate its artifact.
    expect(description).not.toMatch(/do not lint a Nautilus class here/i);
    expect(description).not.toMatch(/do not follow those hints/i);
    expect(description).not.toMatch(/AST_GUARD_REJECTION/);
    // And it must say what the tool now does.
    expect(description).toMatch(/nautilus/i);
    expect(description).toMatch(/update_strategy/);
  });

  it("forwards runtime_tag, manifest and default_params when the agent sends them", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runLintStrategy(
      {
        source: "class NativeStrategy(Strategy): pass",
        entry_function: "NativeStrategy",
        runtime_tag: "nautilus",
        manifest: { name: "ict", default_params: { lookback: 3 } },
        default_params: { lookback: 3 },
      },
      { fetchImpl },
    );
    // `is_class_native_artifact` needs runtime_tag == "nautilus" AND an
    // entry_function that is not "run"; both now reach the route.
    expect(capturedBody).toEqual({
      source: "class NativeStrategy(Strategy): pass",
      entry_function: "NativeStrategy",
      runtime_tag: "nautilus",
      manifest: { name: "ict", default_params: { lookback: 3 } },
      default_params: { lookback: 3 },
    });
  });

  it("omits the three new keys entirely when the agent omits them", async () => {
    // `LintStrategyRequest` is extra="forbid" and every new field is optional,
    // so an omitted field must be ABSENT, never null: a null runtime_tag would
    // be a 422 on a call that used to work, which is the silent-degradation
    // shape this repo refuses.
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runLintStrategy({ source: "def run(): pass", entry_function: "run" }, { fetchImpl });
    expect(Object.keys(capturedBody ?? {}).toSorted()).toEqual(["entry_function", "source"]);
  });

  it("declares the three new parameters on the tool schema", () => {
    const properties = capturedTool().parameters?.properties ?? {};
    expect(Object.keys(properties).toSorted()).toEqual([
      "default_params",
      "entry_function",
      "manifest",
      "runtime_tag",
      "source",
    ]);
  });

  it("names the Nautilus runtime and all engine-injected config fields", () => {
    const description = capturedTool().description ?? "";
    expect(description).toContain("runtime_tag='nautilus'");
    expect(description).toContain("instrument_id");
    expect(description).toContain("pfm_initial_cash");
    expect(description).toContain("pfm_risk_fraction");
  });
});
