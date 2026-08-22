import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runEnqueueBacktestWorkerJob,
  ENQUEUE_BACKTEST_WORKER_JOB_TOOL_NAME,
} from "./index.js";

describe("vctraderai-enqueue-backtest-worker-job", () => {
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

  it("registers the enqueue_backtest_worker_job tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-enqueue-backtest-worker-job",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: ENQUEUE_BACKTEST_WORKER_JOB_TOOL_NAME,
      label: "Enqueue Backtest Worker Job",
    });
  });

  // WHAT WAS FALSE: the description said "This STAGES a proposal for the human to
  // review + Apply in the chat ... PROPOSE_ONLY per ADR 0078." Staging is the one
  // thing this tool cannot do. MEASURED against the platform:
  //   - 'enqueue_backtest_worker_job' in ALLOWLIST (133 entries) -> False
  //   - 'enqueue_backtest_worker_job' in RETIRED_ENGINE_TOOLS      -> True
  //   - gate_tool_call('enqueue_backtest_worker_job') raises ToolForbiddenError
  //     "...is not in the allowlist; the agent cannot invoke it", which /stage
  //     converts to 403 openclaw_tool_forbidden BEFORE persisting anything.
  //   - POSITIVE CONTROL on the same gate: gate_tool_call('dispatch_strategy_experiment')
  //     returns kind=ToolKind.PROPOSE_ONLY, so the refusal is real, not a dead probe.
  // WHY THE GREEN SUITE HID IT: no test asserted the description, and the 403 case
  // below was written as one branch among several ("tool forbidden / not
  // propose_only") rather than as the tool's guaranteed outcome -- so a suite in
  // which every real call 403s looked exactly like a healthy propose plugin.
  it("describes itself as retired rather than as a working propose path", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-enqueue-backtest-worker-job",
    });
    plugin.register(captured.api);
    const description = captured.tools[0].description ?? "";

    expect(description).toContain("RETIRED");
    expect(description).toContain("403 openclaw_tool_forbidden");

    // Must not re-promise the staging behaviour the chokepoint refuses.
    expect(description).not.toContain("STAGES a proposal");
    expect(description).not.toContain("PROPOSE_ONLY per ADR 0078");

    // The retirement was explicitly NOT a merge into dispatch_strategy_experiment
    // (allowlist.py _BACKTEST_DISPATCH_TOOLS: "a capability RETIREMENT, not a
    // merge"), so the description must not sell it as a drop-in replacement.
    expect(description).toContain("dispatch_strategy_experiment is NOT an equivalent");
  });

  it("posts to the stage path with the staging envelope (tool_name = allowlist key)", async () => {
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
    await runEnqueueBacktestWorkerJob({ trader_def_id: "x" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("enqueue_backtest_worker_job");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ trader_def_id: "x" });
    expect(typeof capturedBody.summary).toBe("string");
  });

  // This is not an edge case for THIS tool: it is what every real call returns,
  // because the name is off the allowlist and /stage gates before it persists.
  it("surfaces a structured error on the 403 openclaw_tool_forbidden it always gets", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runEnqueueBacktestWorkerJob({ trader_def_id: "x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
