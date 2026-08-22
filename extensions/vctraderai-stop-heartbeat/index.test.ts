import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { STOP_HEARTBEAT_TOOL_NAME, runStopHeartbeat } from "./index.js";

// This plugin shipped with NO test file, which is why nothing ever read its
// description. It is one of two siblings that kept "Heartbeat policy id." after
// heartbeat_now had the same parameter corrected in the audit wave.
describe("vctraderai-stop-heartbeat", () => {
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

  it("registers the stop_heartbeat tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-stop-heartbeat" });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({ name: STOP_HEARTBEAT_TOOL_NAME });
  });

  it("posts to the internal heartbeat stop route with the server-side workspace", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runStopHeartbeat({ policy_id: "p-1" }, { fetchImpl });

    expect(new URL(request?.url ?? "").pathname).toBe("/api/v1/openclaw/heartbeat/stop");
    expect(request?.method).toBe("POST");
    const body = (await request?.json()) as Record<string, unknown>;
    expect(body.policy_id).toBe("p-1");
    // The workspace is read from the environment, never taken from the model.
    expect(body.workspace_id).toBe("ws-001");
  });

  // The whole heartbeat family keys on ONE opaque id and there is no lookup by
  // name or by workspace. `heartbeat_now` was given the value's source in the
  // audit wave; this sibling kept "Heartbeat policy id." — a parameter name
  // restated as its own description, which tells a model nothing it did not
  // already have from the schema key.
  //
  // Found by diffing what the fix wave REMOVED from one plugin against what
  // still exists in the others: a fact that belongs to a FAMILY does not get
  // fixed by repairing the tool a finding happened to name.
  it("names where the policy id comes from, not just what it is called", () => {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-stop-heartbeat" });
    plugin.register(registration.api);
    const tool = registration.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const policyId = tool.parameters?.properties?.policy_id?.description ?? "";
    // Non-vacuity: a missing param would satisfy every assertion below on "".
    expect(policyId.length).toBeGreaterThan(40);
    expect(policyId).toMatch(/enable_heartbeat/);
    expect(policyId).toMatch(/no lookup by name/i);
  });
});
