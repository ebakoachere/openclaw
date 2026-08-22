import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runEnqueueWalkforwardWorkerJob,
  ENQUEUE_WALKFORWARD_WORKER_JOB_TOOL_NAME,
} from "./index.js";

describe("vctraderai-enqueue-walkforward-worker-job", () => {
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

  it("registers the enqueue_walkforward_worker_job tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-enqueue-walkforward-worker-job",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: ENQUEUE_WALKFORWARD_WORKER_JOB_TOOL_NAME,
      label: "Enqueue Walkforward Worker Job",
    });
  });

  // WHAT WAS FALSE (1): the description said "This STAGES a proposal for the human
  // to review + Apply in the chat ... PROPOSE_ONLY per ADR 0078." MEASURED:
  //   - 'enqueue_walkforward_worker_job' in ALLOWLIST (133 entries) -> False
  //   - 'enqueue_walkforward_worker_job' in RETIRED_ENGINE_TOOLS    -> True
  //   - gate_tool_call(...) raises ToolForbiddenError "...is not in the allowlist;
  //     the agent cannot invoke it"; /stage returns 403 openclaw_tool_forbidden
  //     before persisting anything, so the tool errors instead of proposing.
  //   - POSITIVE CONTROL: gate_tool_call('dispatch_strategy_experiment') returns
  //     kind=ToolKind.PROPOSE_ONLY, so the gate is not refusing vacuously.
  // WHY THE GREEN SUITE HID IT: nothing asserted the description text, and the 403
  // was framed as one possible branch rather than the guaranteed outcome.
  it("describes itself as retired rather than as a working propose path", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-enqueue-walkforward-worker-job",
    });
    plugin.register(captured.api);
    const description = captured.tools[0].description ?? "";

    expect(description).toContain("RETIRED");
    expect(description).toContain("403 openclaw_tool_forbidden");
    expect(description).not.toContain("STAGES a proposal");
    expect(description).not.toContain("PROPOSE_ONLY per ADR 0078");
    expect(description).toContain("dispatch_strategy_experiment is NOT an equivalent");
  });

  // WHAT WAS FALSE (2): the schema declared `n_splits` ("Number of walkforward
  // folds.", minimum 1, maximum 100) -- bounds that read as a validated contract.
  // MEASURED: `n_splits` occurs ZERO times anywhere in the platform (0 hits in
  // *.py and 0 hits across all file types), with a positive control on the same
  // trees of 118 *.py hits for `walkforward_spec`. No fold-count input exists
  // under any other name either: walkforward_spec takes train/test/step/gap/
  // warmup/seed and the fold count is derived from that window geometry.
  // WHY THE GREEN SUITE HID IT: the suite only ever asserted that the plugin
  // forwards whatever params it is handed, which is true of a fabricated key as
  // much as a real one. A model would have believed it set the fold count.
  it("declares no fabricated fold-count parameter", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-enqueue-walkforward-worker-job",
    });
    plugin.register(captured.api);
    const props = (captured.tools[0] as any).parameters.properties;

    expect(props).not.toHaveProperty("n_splits");
    // Nothing else may quietly reintroduce a fold count under another name.
    expect(Object.keys(props)).not.toContain("folds");
    expect(Object.keys(props)).not.toContain("n_folds");
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
    await runEnqueueWalkforwardWorkerJob({ trader_def_id: "x" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("enqueue_walkforward_worker_job");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ trader_def_id: "x" });
    expect(typeof capturedBody.summary).toBe("string");
  });

  // Not an edge case for THIS tool: it is what every real call returns, because
  // the name is off the allowlist and /stage gates before it persists.
  it("surfaces a structured error on the 403 openclaw_tool_forbidden it always gets", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runEnqueueWalkforwardWorkerJob({ trader_def_id: "x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
