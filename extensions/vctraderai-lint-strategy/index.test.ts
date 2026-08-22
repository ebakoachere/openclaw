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
  // WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT.
  //
  // The description used to end with the unconditional directive: "Use it to
  // VALIDATE and REPAIR source BEFORE calling create_strategy." That is true only
  // for a vbt/Shape-A source. The BFF route picks its contract with
  // `is_class_native_artifact(runtime_tag, entry_function)`, which requires
  // runtime_tag == "nautilus" AND entry_function != "run" -- and this plugin
  // never sends runtime_tag, so the predicate is always false and the six-key
  // path always runs. Measured against web_api/strategy_authoring/service with
  // the repo's own NativeStrategy fixture and exactly the body this plugin POSTs:
  //   lint_source(NAUTILUS_CLASS_SOURCE, entry_function="NativeStrategy")
  //     -> passed=false, 3x AST_GUARD_REJECTION denied_import
  //        (nautilus_trader.config / .model.identifiers / .trading.strategy),
  //        each with fix_hint "Remove denied imports/attributes..."
  //   validate_nautilus_class_source_contract(same source) -> []
  //   vbt control on the same route -> passed=true (so the probe discriminates)
  // Since create_strategy advertises the nautilus lane as the only deployable
  // one, the old directive told the model to delete the nautilus_trader imports
  // from a correct, deployable artifact.
  //
  // The existing tests all lint a run(...) stub through a FAKE fetch, so the
  // class-native shape was never sent and the false negative never appeared.
  // Green suite, lying tool.
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

  it("warns that a valid Nautilus class is falsely rejected here", () => {
    const description = capturedTool().description ?? "";
    expect(description).toMatch(/AST_GUARD_REJECTION/);
    expect(description).toMatch(/do not follow those hints/i);
    expect(description).toMatch(/update_strategy/);
  });

  it("never sends runtime_tag, which is why only the six-key contract can run", () => {
    // The mechanism behind the scope warning, pinned as behaviour rather than
    // prose: the body carries source (+ entry_function) and nothing else, so
    // is_class_native_artifact is always false server-side.
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    return runLintStrategy(
      { source: "class NativeStrategy(Strategy):\n    pass\n", entry_function: "NativeStrategy" },
      { fetchImpl },
    ).then(() => {
      expect(capturedBody).toBeDefined();
      expect(Object.keys(capturedBody ?? {}).sort()).toEqual(["entry_function", "source"]);
      expect(capturedBody).not.toHaveProperty("runtime_tag");
    });
  });
});
