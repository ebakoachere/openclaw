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

  it("teaches the DISPATCHABLE kinds, the window keys, and rule_overlay", async () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    for (const kind of [
      "vbt_backtest",
      "vbt_prop_sim",
      "vbt_walkforward",
      "nautilus_backtest",
      "nautilus_prop_sim",
      "nautilus_walkforward",
      "nautilus_prop_walkforward",
    ]) {
      expect(description).toContain(kind);
    }
    expect(description).toContain("from_ts");
    expect(description).toContain("to_ts");
    // The three prop kinds also require config.rule_overlay
    // (web_api/sandbox/v3/kinds.py:350, :400, :440).
    expect(description).toContain("rule_overlay");
  });

  it("marks stage_b_bundle_run as V3-deferred rather than offering it", async () => {
    // It IS in the 8-kind catalogue, but V3_DEFERRED_KIND_VALUES makes it
    // non-dispatchable in V2: the BFF 422s before anything is staged
    // (web_api/sandbox/v3/kinds.py:148). Teaching it as usable would send the
    // model down a path that can only fail.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    expect(description).toContain("stage_b_bundle_run");
    expect(description).toMatch(/stage_b_bundle_run[^.]*(DEFERRED TO V3|deferred)/i);
    expect(description).toMatch(/seven DISPATCHABLE/);
  });
});
