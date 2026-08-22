import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runDispatchStrategyExperiment,
  DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
} from "./index.js";

describe("vctraderai-dispatch-strategy-experiment", () => {
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

  it("registers the dispatch_strategy_experiment tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: DISPATCH_STRATEGY_EXPERIMENT_TOOL_NAME,
      label: "Dispatch Strategy Experiment",
    });
  });

  it("posts to the stage path with the staging envelope + threads origin_signal_id", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runDispatchStrategyExperiment(
      {
        strategy_id: "strat-1",
        experiment_kind: "backtest",
        config: { instrument: "XAUUSD" },
        origin_signal_id: "sig-42",
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("dispatch_strategy_experiment");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({
      strategy_id: "strat-1",
      experiment_kind: "backtest",
      origin_signal_id: "sig-42",
    });
    expect(typeof capturedBody.summary).toBe("string");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "backtest" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
  it("relays the BFF's message + retry_suggestion so the model can self-correct", async () => {
    // The whole point: a 422 used to reach the model as the bare statusText
    // "Unprocessable Entity", so it could not tell a CONTRACT error from a
    // backend outage and retried the same wrong shape forever.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: {
              code: "openclaw_stage_invalid_params",
              message: "config is missing required key(s): from_ts, to_ts.",
              retry_suggestion:
                "Re-call dispatch_strategy_experiment with config.from_ts and config.to_ts (ISO-8601).",
            },
          },
        }),
        { status: 422, statusText: "Unprocessable Entity" },
      )) as typeof globalThis.fetch;

    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "vbt_backtest" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: {
        code: "openclaw_stage_invalid_params",
        status: 422,
        message: "config is missing required key(s): from_ts, to_ts.",
        retrySuggestion:
          "Re-call dispatch_strategy_experiment with config.from_ts and config.to_ts (ISO-8601).",
      },
    });

    // The message is what the tool runner shows the model, so the suggestion
    // has to be IN it, not only on the detail object.
    await expect(
      runDispatchStrategyExperiment(
        { strategy_id: "strat-1", experiment_kind: "vbt_backtest" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/retry_suggestion: Re-call dispatch_strategy_experiment/);
  });

  it("falls back to the status line when the error body is unreadable", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 502, statusText: "Bad Gateway" })) as typeof globalThis.fetch;
    await expect(
      runDispatchStrategyExperiment({ strategy_id: "strat-1" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_502", status: 502, message: "Bad Gateway" },
    });
  });

  // ---------------------------------------------------------------------------
  // Dispatchability vocabulary.
  //
  // THE AUTHORITY IS PYTHON, NOT THIS FILE. `kind_is_dispatchable()` in
  // web_api/sandbox/v3/kinds.py is the single source of truth, and the guard that
  // actually watches it for drift lives where it can run against that module:
  // tests/engine/agent/test_dispatch_strategy_experiment_tool.py
  // ::test_docstring_teaches_exactly_the_dispatchable_kinds. These two lists are a
  // MIRROR of a measured result, re-measured 2026-08-22 by executing the catalogue
  // module. If you are changing them, change that guard's subject in the same wave
  // and re-bake — a description is only true at the tag it was baked from.
  //
  // The lists below have been wrong before, and this file is why they stayed wrong:
  // the previous tests asserted `/vbt_prop_sim \(BFF-stubbed at v1\.0/` and
  // `/never promise the user metrics/`, pinning in place two claims that B1B-05 and
  // #1227/#1229 had already falsified. A green suite was the reason nobody looked.
  const DISPATCHES_FOR_REAL = [
    "vbt_backtest",
    "vbt_walkforward",
    "vbt_prop_sim",
    "nautilus_backtest",
    "nautilus_walkforward",
    "nautilus_prop_sim",
  ] as const;
  const ALWAYS_422 = ["nautilus_prop_walkforward", "stage_b_bundle_run"] as const;

  const toolDescription = (): string => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    return description;
  };

  it("offers every kind that dispatches for real, and warns off every kind that cannot", () => {
    const description = toolDescription();
    // Non-vacuity first: a partition proves nothing if either half is empty, and
    // the split marker must exist before the halves mean anything.
    expect(DISPATCHES_FOR_REAL.length).toBeGreaterThan(0);
    expect(ALWAYS_422.length).toBeGreaterThan(0);
    // Bound the refusal clause at BOTH ends. "everything after the marker" would
    // sweep in the later config paragraph, which names the prop kinds for an
    // entirely legitimate reason (rule_overlay), and the guard would read that as
    // the description warning against a kind it in fact offers.
    const REFUSAL_OPEN = "TWO are refused 422";
    const REFUSAL_CLOSE = "say it is in build";
    const open = description.indexOf(REFUSAL_OPEN);
    const close = description.indexOf(REFUSAL_CLOSE);
    expect(open, "the description no longer names a refused group").toBeGreaterThan(-1);
    expect(close, "the refusal clause has no terminator").toBeGreaterThan(open);
    const offered = description.slice(0, open);
    const refusedHalf = description.slice(open, close);

    for (const kind of DISPATCHES_FOR_REAL) {
      expect(offered, `${kind} dispatches for real but is not offered`).toContain(kind);
      expect(refusedHalf, `${kind} dispatches for real but is warned against`).not.toContain(kind);
    }
    for (const kind of ALWAYS_422) {
      expect(refusedHalf, `${kind} can only 422 but is not warned about`).toContain(kind);
      expect(offered, `${kind} can only 422 but is offered`).not.toContain(kind);
    }
  });

  it("teaches the window keys and the prop-firm config the resolver actually demands", () => {
    const description = toolDescription();
    expect(description).toContain("from_ts");
    expect(description).toContain("to_ts");
    expect(description).toContain("rule_overlay");
    // rule_overlay="prop_firm" ALSO needs prop_firm_variant_id + prop_account_size, and
    // payload_resolver refuses rather than defaults either one — an absent size resolves
    // against the catalogue's literal `account_size = 'all_sizes'` phase templates and
    // returns a real-looking spec for an account the firm does not sell. Until this
    // description said so, the only documented prop path ended in a 422 the model had
    // been given no way to avoid.
    expect(description).toContain("prop_firm_variant_id");
    expect(description).toContain("prop_account_size");
    // And it must say WHERE those come from. list_prop_firm_challenges returns the
    // variant id under the name `rule_set_id` (backtest_tools.py: `v.id as rule_set_id`),
    // so a model told only the parameter name has no way to find the value.
    expect(description).toContain("rule_set_id");
    expect(description).toContain("list_prop_firm_challenges");
    // The window keys must be taught as canonical, WITHOUT claiming start/end are
    // rejected: staged_params._CONFIG_KEY_ALIASES folds start/end onto from_ts/to_ts
    // before the required-key check (web_api/openclaw_internal/router.py:548). A
    // future reader who "fixes" the plugin by deleting that fold would re-open the
    // 2026-07-29 browser-proof bug.
    expect(description).not.toMatch(/"start"\/"end" are NOT accepted/);
  });

  it("no longer claims a prop sim parks without computing anything", () => {
    // Both prop-sim kinds reach a real engine now: the vbt one since B1B-05 (the
    // firm's real rules resolved from public.prop_firm_* instead of an empty
    // rules={} spec) and the nautilus one since #1227/#1229 (native segment adapter
    // + worker route). The old copy told the model to never promise metrics from
    // them, which on a prop-firm platform means refusing the flagship request.
    const description = toolDescription();
    expect(description).not.toContain("deferred_pending");
    expect(description).not.toMatch(/never promise the user metrics/);
  });

  it("offers project_id, because an unprojected run is invisible", async () => {
    // Every agent-dispatched experiment used to land with project_id NULL, and the
    // only experiments list in the product is project-scoped — so the run executed,
    // succeeded, stored its metrics, and could not be found anywhere in the UI.
    // Until this param existed the model had no way to express where a run belongs.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const project = tool.parameters?.properties?.project_id;
    expect(project, "project_id must be an accepted parameter").toBeDefined();
    // Accepts a NAME as well as an id — the BFF resolver handles both, and a human
    // talking to the agent says "put it in Alpha Research", not a UUID.
    expect(project?.description ?? "").toMatch(/NAME/i);
    // And the consequence of omitting it must be stated, not left implicit.
    expect(project?.description ?? "").toMatch(/invisible/i);
  });

  it("marks stage_b_bundle_run as V3-deferred rather than offering it", () => {
    // It IS in the 8-kind catalogue, but V3_DEFERRED_KIND_VALUES makes it
    // non-dispatchable in V2: the BFF 422s before anything is staged
    // (web_api/sandbox/v3/kinds.py). Teaching it as usable would send the
    // model down a path that can only fail.
    const description = toolDescription();
    expect(description).toContain("stage_b_bundle_run");
    expect(description).toMatch(/stage_b_bundle_run \(deferred to V3\)/i);
  });

  it("tells the model what to say instead of staging a kind that cannot run", () => {
    // A refusal the model cannot explain becomes a retry loop or an invented
    // excuse. The description has to give it the honest sentence.
    const description = toolDescription();
    expect(description).toMatch(/say it is in build/i);
  });
});
