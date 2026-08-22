import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { HEARTBEAT_NOW_TOOL_NAME, runHeartbeatNow } from "./index.js";

// This plugin previously shipped with NO test file at all, which is why the
// false description below was never read by any assertion.
describe("vctraderai-heartbeat-now", () => {
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
    const registration = createCapturedPluginRegistration({ id: "vctraderai-heartbeat-now" });
    plugin.register(registration.api);
    return registration.tools[0] as any;
  }

  it("registers the heartbeat_now tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-heartbeat-now" });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({ name: HEARTBEAT_NOW_TOOL_NAME });
  });

  // FALSE DESCRIPTION (fixed): the tool said "Mark an Agent Alpha heartbeat
  // policy due now WITHOUT BYPASSING the normal heartbeat runner gates."
  //
  // It does not bypass the status gate -- it OVERWRITES the state that gate
  // reads, which is why no refusal is ever recorded. Route -> service
  // .heartbeat_now -> repository.queue_policy_now is an unconditional chain
  // (queue_policy_now contains zero branch nodes) ending in an UPDATE that sets
  // status='enabled', next_due_at=now and stopped_at=NULL keyed only on
  // workspace_id + policy_id. That is the exact inverse of stop_policy
  // (status='stopped', next_due_at=NULL, stopped_at=now).
  //
  // The runner DOES have a guard -- `policy.status not in {"enabled",
  // "degraded"}` -> skipped -- but it reads the row AFTER this write, so the
  // gate is satisfied by mutation. The reassurance in the old sentence is
  // therefore about the one gate this tool defeats: a policy deliberately
  // stopped, or paused by the failure breaker, is restarted rather than
  // refused, and stays restarted.
  it("does not claim it respects the runner gates, and states that it restarts a policy", () => {
    const description = String(captured().description ?? "");
    expect(description).not.toMatch(/without bypassing the normal heartbeat runner gates/i);
    expect(description).toMatch(/NOT a safe poke/);
    expect(description).toMatch(/status='enabled'/);
    expect(description).toMatch(/stopped_at=NULL/);
    expect(description).toMatch(/inverse of stop_heartbeat/);
    expect(description).toMatch(/RESTARTS/);
    expect(description).toMatch(/paused/);
    // And it points at the read that would have prevented the mistake.
    expect(description).toMatch(/get_heartbeat_status/);
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
    // _update_status_time returns {"policy_id":..., "status":"missing"} when no
    // row matches, and the route passes that straight through on a 200.
    expect(String(tool.description ?? "")).toMatch(/status: "missing"\} with HTTP 200/);
  });

  it("posts to the guarded heartbeat now route with the tool header", async () => {
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

    await runHeartbeatNow({ policy_id: "pol-1" }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/heartbeat/now");
    expect(capturedHeaders["x-openclaw-tool"]).toBe("heartbeat_now");
    expect(capturedBody).toMatchObject({ policy_id: "pol-1", workspace_id: "ws-001" });
  });

  it("throws when PFM_WORKSPACE_ID is not set", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runHeartbeatNow({ policy_id: "pol-1" }, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
