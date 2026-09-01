import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { GET_HEARTBEAT_STATUS_TOOL_NAME, runGetHeartbeatStatus } from "./index.js";

// This plugin shipped with NO test file, which is why nothing ever read its
// description. It is the second of two siblings that kept "Heartbeat policy id."
// after heartbeat_now had the same parameter corrected in the audit wave.
describe("vctraderai-get-heartbeat-status", () => {
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

  it("registers the get_heartbeat_status tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({
      id: "vctraderai-get-heartbeat-status",
    });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({ name: GET_HEARTBEAT_STATUS_TOOL_NAME });
  });

  it("reads the internal heartbeat status route with the server-side workspace", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runGetHeartbeatStatus({ policy_id: "p-1" }, { fetchImpl });

    const url = new URL(request?.url ?? "");
    expect(url.pathname).toBe("/api/v1/openclaw/heartbeat/status");
    expect(request?.method).toBe("GET");
    expect(url.searchParams.get("policy_id")).toBe("p-1");
    // The workspace is read from the environment, never taken from the model.
    expect(url.searchParams.get("workspace_id")).toBe("ws-001");
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
  it("names where the policy id comes from, and that omitting it is allowed", () => {
    const registration = createCapturedPluginRegistration({
      id: "vctraderai-get-heartbeat-status",
    });
    plugin.register(registration.api);
    const tool = registration.tools[0] as {
      parameters?: {
        properties?: Record<string, { description?: string }>;
        required?: string[];
      };
    };
    const policyId = tool.parameters?.properties?.policy_id?.description ?? "";
    // Non-vacuity: a missing param would satisfy every assertion below on "".
    expect(policyId.length).toBeGreaterThan(40);
    expect(policyId).toMatch(/enable_heartbeat/);

    // This assertion USED to require the text "no lookup by name or by
    // workspace". That claim became FALSE on 2026-08-25, when the BFF route
    // made `policy_id` optional and added the workspace-wide branch --
    // web_api/openclaw_internal/router.py, `policy_id: UUID | None`. The
    // schema kept demanding the id anyway, so an agent that had not created
    // the policy could not answer "is my heartbeat running?" at all. Asked
    // exactly that, Agent Alpha answered from its own transcript and reported
    // monitoring had run "through the night" while every policy sat stopped.
    // The old assertion was pinning the lie in place, so it is inverted here
    // rather than deleted: the description must now TELL the model it may omit
    // the id, because that is the call the server has accepted all along.
    expect(policyId).toMatch(/optional/i);
    expect(policyId).toMatch(/omit/i);
    expect(policyId).not.toMatch(/no lookup by name/i);
    expect(tool.parameters?.required ?? []).not.toContain("policy_id");
  });
});
