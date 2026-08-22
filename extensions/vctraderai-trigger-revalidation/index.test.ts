import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runTriggerRevalidation, TRIGGER_REVALIDATION_TOOL_NAME } from "./index.js";

describe("vctraderai-trigger-revalidation", () => {
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

  it("registers the trigger_revalidation tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-trigger-revalidation" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: TRIGGER_REVALIDATION_TOOL_NAME,
      label: "Trigger Revalidation",
    });
  });

  // WHAT WAS FALSE: the schema declared `strategy_id` ("Strategy id to revalidate.")
  // and `trader_def_id` ("Trader definition id to revalidate.") as the targets.
  // Neither is a revalidation target. MEASURED against the platform:
  //   - create_revalidation's signature has no strategy_id/trader_def_id parameter
  //     at all (passing one raises TypeError), and it enforces deployment_id XOR
  //     version_id, refusing with code 'target_required' (400) when neither is set.
  //   - the apply adapter _build_trigger_revalidation_kwargs filters the staged
  //     params down to deployment_id/version_id/reason, so both declared ids were
  //     dropped before the service was ever reached (a deployment_id positive
  //     control survives the same builder, so the drop is real, not a dead probe).
  // WHY THE GREEN SUITE HID IT: the old test called the tool with { strategy_id: "x" }
  // and asserted only that the request body echoed it back and that summary was
  // `typeof === "string"`. Both held perfectly -- the plugin does transmit whatever
  // it is given. Nothing in the suite reached the apply-time filter or the service
  // signature, so a schema that could not target anything looked fully exercised.
  it("declares the real XOR target vocabulary (deployment_id / version_id), not strategy_id", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-trigger-revalidation" });
    plugin.register(captured.api);
    const props = (captured.tools[0] as any).parameters.properties;

    // The two ids create_revalidation actually resolves.
    expect(Object.keys(props).sort()).toEqual(["deployment_id", "reason", "version_id"]);

    // The dropped ids must not be advertised as targets again.
    expect(props).not.toHaveProperty("strategy_id");
    expect(props).not.toHaveProperty("trader_def_id");

    // A model needs to know WHERE version_id comes from, not just its name.
    expect(props.version_id.description).toContain("list_strategies");
    expect(props.version_id.description).toContain("current_version_id");

    // deployment_id lives in strategy_registry, and the live-plane id is a trap:
    // live.trader_deployments and strategy_registry.strategy_deployments are
    // separate tables with independent gen_random_uuid() primary keys.
    expect(props.deployment_id.description).toContain("strategy_registry.strategy_deployments");
    expect(props.deployment_id.description).toContain("list_current_deployments");

    // The refusal the model would otherwise walk into, after a human approved it.
    expect(captured.tools[0].description).toContain("target_required");
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
    await runTriggerRevalidation({ version_id: "ver-1" } as any, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.tool_name).toBe("trigger_revalidation");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({ version_id: "ver-1" });
  });

  // The summary is what the human reads before approving. Previously it rendered
  // `Revalidate strategy <strategy_id>`, so a card carrying only the inert
  // strategy_id looked correctly targeted right up to the point Apply failed.
  it("summarises the target that will actually be revalidated", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runTriggerRevalidation({ deployment_id: "dep-1" } as any, { fetchImpl });
    expect(bodies[0].summary).toBe("Revalidate deployment dep-1");

    await runTriggerRevalidation({ version_id: "ver-1" } as any, { fetchImpl });
    expect(bodies[1].summary).toBe("Revalidate strategy version ver-1");

    // No target -> the card must not read as a targeted revalidation.
    await runTriggerRevalidation({ strategy_id: "s-1" } as any, { fetchImpl });
    expect(bodies[2].summary).toContain("target_required");
    expect(bodies[2].summary).not.toContain("s-1");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runTriggerRevalidation({ version_id: "ver-1" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
