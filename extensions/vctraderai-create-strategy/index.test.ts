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

  it("names the Nautilus runtime and all engine-injected config fields", () => {
    const description = capturedTool().description ?? "";
    expect(description).toContain("runtime_tag='nautilus'");
    expect(description).toContain("instrument_id");
    expect(description).toContain("pfm_initial_cash");
    expect(description).toContain("pfm_risk_fraction");
  });

  // ---------------------------------------------------------------------
  // The relay used to drop `problems[]`.
  //
  // The BFF accumulates EVERY contract violation and sends them as
  // `problems[]` (web_api/openclaw_internal/router.py:2870-2884, the same
  // shape the stage 422s use), and its own `retry_suggestion` tells the model
  // to read `problems[].fix_hint`. This client read `code`, `message` and
  // `retry_suggestion` and never read `problems` at all, so the model was
  // instructed to consult a list it had not been given. It therefore learned
  // ONE RULE PER ATTEMPT: the second attempt failed on a rule the first
  // response already carried. Measured on 2026-09-08 and still live on the
  // deployed tag.
  // ---------------------------------------------------------------------

  const problemBody = (problems: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      detail: {
        error: {
          code: "openclaw_registry_mutation_failed",
          message: "Strategy source failed the runtime contract.",
          retry_suggestion: "Fix every problem in problems[].fix_hint, then retry once.",
          ...extra,
          problems,
        },
      },
    });

  const failingCall = (body: string, status = 422) => {
    const fetchImpl = (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    return runCreateStrategy(
      {
        name: "X",
        intent_brief: "x",
        runtime_tag: "vbt",
        entry_function: "run",
        source_text: "def run(data, params=None, context=None):\n    return {}",
      },
      { fetchImpl },
    );
  };

  it("relays every problem, with its code and its fix_hint", async () => {
    const body = problemBody(
      [
        {
          code: "MANIFEST_INVALID",
          message: "Strategy manifest failed validation: missing entry_function",
          fix_hint: "Pass the same valid StrategySpec manifest planned for create_strategy.",
        },
        {
          code: "SIGNATURE_MISMATCH",
          message: "run() must accept (data, params, context)",
          fix_hint: "Declare def run(data, params=None, context=None).",
        },
      ],
      { error_codes: ["MANIFEST_INVALID", "SIGNATURE_MISMATCH"] },
    );

    const error = await failingCall(body).catch((caught: unknown) => caught);

    const message = (error as Error).message;
    // BOTH problems, not just the first: that is the whole defect.
    expect(message).toContain("MANIFEST_INVALID: Strategy manifest failed validation");
    expect(message).toContain("SIGNATURE_MISMATCH: run() must accept");
    // and each carries the fix_hint the retry_suggestion promises
    expect(message).toContain("Declare def run(data, params=None, context=None).");
    expect(message).toContain("Pass the same valid StrategySpec manifest");
    // the suggestion itself still renders
    expect(message).toContain("retry_suggestion:");
    // and the structured detail carries them for a caller that wants to branch
    expect(
      (error as { detail?: { problems?: unknown[]; errorCodes?: string[] } }).detail,
    ).toMatchObject({
      errorCodes: ["MANIFEST_INVALID", "SIGNATURE_MISMATCH"],
    });
    expect((error as { detail: { problems: unknown[] } }).detail.problems).toHaveLength(2);
  });

  it("renders exactly as before when the body carries no problems", async () => {
    const body = JSON.stringify({
      detail: {
        error: {
          code: "openclaw_registry_mutation_failed",
          message: "create_strategy is missing required fields",
          retry_suggestion: "Send name and source_text.",
        },
      },
    });

    const error = await failingCall(body).catch((caught: unknown) => caught);

    const message = (error as Error).message;
    // Byte-identical to the pre-change shape: summary + retry_suggestion, and
    // NO empty "problems:" header. A header with nothing under it would teach
    // the model that the list exists and is empty, which is a different claim.
    expect(message).toBe(
      "vctraderai bff request failed: openclaw_registry_mutation_failed (422) " +
        "create_strategy is missing required fields — retry_suggestion: Send name and source_text.",
    );
    expect(message).not.toContain("problems:");
    expect((error as { detail?: { problems?: unknown } }).detail?.problems).toBeUndefined();
  });

  it("bounds a long list and says how many it dropped", async () => {
    // Each problem is deliberately fat, so the 2000-char budget cannot hold
    // all of them. Silent truncation is the failure mode being avoided: a
    // model that sees four of seven rules and no notice believes it has seen
    // them all -- the same one-rule-per-attempt loop, one level up.
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      code: `RULE_${index}`,
      message: `problem ${index} `.padEnd(120, "x"),
      fix_hint: `hint ${index} `.padEnd(120, "y"),
    }));

    const error = await failingCall(problemBody(many)).catch((caught: unknown) => caught);

    const message = (error as Error).message;
    expect(message).toContain("RULE_0:");
    expect(message).toMatch(/\(\+\d+ more\)/);
    // the count is honest: rendered + omitted === the whole list
    const omitted = Number(/\(\+(\d+) more\)/.exec(message)?.[1]);
    const rendered = (message.match(/^- RULE_\d+:/gm) ?? []).length;
    expect(rendered + omitted).toBe(40);
    expect(rendered).toBeGreaterThan(0);
    // and every problem is still on the structured detail, uncapped
    expect((error as { detail: { problems: unknown[] } }).detail.problems).toHaveLength(40);
  });

  it("names the refusal on the name parameter itself", () => {
    const name = capturedTool().parameters?.properties?.name?.description ?? "";
    expect(name).toMatch(/Required/);
    expect(name).toMatch(/whitespace-only/);
  });
});
