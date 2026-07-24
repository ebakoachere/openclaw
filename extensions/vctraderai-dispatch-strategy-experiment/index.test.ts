import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runDispatchStrategyExperiment,
  CATALOGUE_EXPERIMENT_KINDS,
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

  it("teaches exactly the 8 catalogue experiment kinds and stays propose-only", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-dispatch-strategy-experiment",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as any;
    // Schema enum matches the platform catalogue (kinds.py CUSTOMER_KIND_VALUES).
    expect(tool.parameters.properties.experiment_kind.enum).toEqual([
      "vbt_backtest",
      "vbt_prop_sim",
      "vbt_walkforward",
      "nautilus_backtest",
      "nautilus_prop_sim",
      "nautilus_walkforward",
      "nautilus_prop_walkforward",
      "stage_b_bundle_run",
    ]);
    expect(tool.parameters.properties.experiment_kind.enum).toEqual([
      ...CATALOGUE_EXPERIMENT_KINDS,
    ]);
    // Descriptions teach the catalogue vocabulary + runtime-prefix rule and
    // keep the propose-only framing.
    expect(tool.description).toContain("does NOT dispatch directly");
    expect(tool.description).toContain("PROPOSE_ONLY");
    expect(tool.description).toContain("get_strategy");
    for (const kind of CATALOGUE_EXPERIMENT_KINDS) {
      expect(tool.description).toContain(kind);
    }
    // The old wrong vocabulary must not resurface as a bare kind suggestion.
    expect(tool.description).not.toMatch(/\(backtest\/walkforward\)/);
    expect(tool.parameters.properties.experiment_kind.description).not.toContain("e.g. backtest");
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
        experiment_kind: "vbt_backtest",
        config: {
          instrument: "XAU_USD",
          from_ts: "2026-01-01T00:00:00Z",
          to_ts: "2026-06-30T00:00:00Z",
        },
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
      experiment_kind: "vbt_backtest",
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
        { strategy_id: "strat-1", experiment_kind: "vbt_backtest" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
