import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { UPDATE_HEARTBEAT_TOOL_NAME, runUpdateHeartbeat } from "./index.js";

// This plugin previously shipped with NO test file at all, which is why the
// false description below was never read by any assertion.
describe("vctraderai-update-heartbeat", () => {
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

  function captured(): any {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-update-heartbeat" });
    plugin.register(registration.api);
    return registration.tools[0] as any;
  }

  it("registers the update_heartbeat tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-update-heartbeat" });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({ name: UPDATE_HEARTBEAT_TOOL_NAME });
  });

  // FALSE DESCRIPTION (fixed): the tool said "Update cadence, timeout, route,
  // symbols, or instructions for an existing Agent Alpha heartbeat policy."
  // The "or" mirrors five independent Optional fields. Two of them are not
  // independent. AgentAlphaHeartbeatService.update_heartbeat calls
  // normalize_heartbeat_timing whenever EITHER timing field is supplied, that
  // helper always returns a non-null (cadence, timeout) PAIR, and update_policy
  // writes both through `coalesce(%(field)s, field)` -- a non-null value always
  // wins the coalesce. Measured against the real function:
  //   turn_timeout_seconds=600 alone  -> cadence 660  (a stored 3600 is lost)
  //   cadence_seconds=3600  alone     -> turn_timeout 120 (a stored 600 is lost)
  // Only calls touching neither timing field leave both stored values intact.
  it("states that cadence and timeout are one coupled write, not five independent fields", () => {
    const description = String(captured().description ?? "");
    expect(description).not.toMatch(/Update cadence, timeout, route, symbols, or instructions/);
    expect(description).toMatch(/silently overwrites the other/i);
    // Both directions of the coupling, with the measured values.
    expect(description).toMatch(/turn_timeout_seconds=600 alone resets cadence to 660/);
    expect(description).toMatch(/cadence_seconds=3600 alone resets turn_timeout to the 120s/);
    expect(description).toMatch(/send BOTH/);
  });

  // A model told a parameter name but not where the value lives cannot make the
  // call: policy_id is only ever minted by enable_heartbeat, and
  // get_heartbeat_status REQUIRES a policy_id so it cannot discover one.
  it("names enable_heartbeat's policy_id response field as the source of policy_id", () => {
    const tool = captured();
    expect(String(tool.description ?? "")).toMatch(
      /policy_id is the `policy_id` field of enable_heartbeat's response/,
    );
    expect(String(tool.parameters.properties.policy_id.description ?? "")).toMatch(
      /enable_heartbeat's response/,
    );
    expect(tool.parameters.required ?? []).toContain("policy_id");
  });

  // The update route/repo never write the status column, and an unmatched row
  // returns {policy_id, status: "missing"} on a 200 rather than an error.
  it("says it cannot create/stop/restart and that an unknown id is a silent 200", () => {
    const description = String(captured().description ?? "");
    expect(description).toMatch(/never touches status/i);
    expect(description).toMatch(/status: "missing"\} with HTTP 200/);
  });

  // Same false `minimum: 1` bound as enable_heartbeat: the real floors are 180
  // (cadence, then raised again to turn_timeout + 60) and 120 (turn_timeout),
  // with an uncaught ValueError -> 500 above 86400.
  it("pins the real timing bounds instead of minimum: 1", () => {
    const properties = captured().parameters.properties;
    const cadence =
      properties.cadence_seconds.type === "integer"
        ? properties.cadence_seconds
        : properties.cadence_seconds.anyOf?.[0];
    expect(cadence.minimum).toBe(180);
    expect(cadence.maximum).toBe(86400);
    const timeout =
      properties.turn_timeout_seconds.type === "integer"
        ? properties.turn_timeout_seconds
        : properties.turn_timeout_seconds.anyOf?.[0];
    expect(timeout.minimum).toBe(120);
    // The per-parameter text has to carry the clobber too: a model reads the
    // field it is about to send, not always the whole tool description.
    expect(String(cadence.description ?? "")).toMatch(/resets the stored timeout to 120/);
    expect(String(timeout.description ?? "")).toMatch(/discards the stored cadence/);
  });

  it("posts to the guarded heartbeat update route with the tool header", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ policy_id: "pol-1", status: "enabled" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    // The shape the corrected description tells the model to send: BOTH timing
    // fields together, because either one alone rewrites the other.
    await runUpdateHeartbeat(
      { policy_id: "pol-1", cadence_seconds: 3600, turn_timeout_seconds: 600 },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/heartbeat/update");
    expect(capturedHeaders["x-openclaw-tool"]).toBe("update_heartbeat");
    expect(capturedBody).toMatchObject({
      policy_id: "pol-1",
      cadence_seconds: 3600,
      turn_timeout_seconds: 600,
      workspace_id: "ws-001",
    });
  });

  it("throws when PFM_WORKSPACE_ID is not set", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runUpdateHeartbeat({ policy_id: "pol-1" }, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
