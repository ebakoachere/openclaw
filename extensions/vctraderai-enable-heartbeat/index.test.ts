import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { ENABLE_HEARTBEAT_TOOL_NAME, runEnableHeartbeat } from "./index.js";

describe("vctraderai-enable-heartbeat", () => {
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
    const registration = createCapturedPluginRegistration({ id: "vctraderai-enable-heartbeat" });
    plugin.register(registration.api);
    return registration.tools[0] as any;
  }

  function schema(): any {
    return captured().parameters as any;
  }

  function toolDescription(): string {
    return String(captured().description ?? "");
  }

  it("registers the enable_heartbeat tool with the plugin api", () => {
    const registration = createCapturedPluginRegistration({ id: "vctraderai-enable-heartbeat" });
    plugin.register(registration.api);
    expect(registration.tools).toHaveLength(1);
    expect(registration.tools[0]).toMatchObject({ name: ENABLE_HEARTBEAT_TOOL_NAME });
  });

  // Accounts went 0..N via a join table in propfirm_manager #1347. The BFF
  // route has only ever read `account_ids`; the singular `account_id` this
  // schema advertised was silently dropped on every call.
  it("exposes account_ids as an OPTIONAL list, not a required singular account_id", () => {
    const parameters = schema();
    expect(parameters.properties.account_id).toBeUndefined();
    const accountIds = parameters.properties.account_ids;
    expect(accountIds).toBeDefined();
    const asArray = accountIds.type === "array" ? accountIds : accountIds.anyOf?.[0];
    expect(asArray?.type).toBe("array");
    expect(parameters.required ?? []).not.toContain("account_ids");
    expect(parameters.required ?? []).not.toContain("account_id");
  });

  it("still requires cadence_seconds", () => {
    expect(schema().required ?? []).toContain("cadence_seconds");
  });

  // FALSE DESCRIPTION (fixed): the tool said "Enable or UPDATE an Agent Alpha
  // heartbeat policy." It cannot update. PostgresHeartbeatPolicyRepository
  // .enable_policy mints `policy_id = uuid4()` and runs a plain INSERT -- no
  // upsert, no ON CONFLICT on the policy row, and the (workspace_id,
  // thread_id) index is NOT unique. Neither the service nor the route looks
  // for an existing policy first, and list_due_policies selects every
  // 'enabled'/'degraded' row, so a second call leaves two policies waking on
  // the same thread every cycle at double LLM spend.
  //
  // WHY THE GREEN SUITE HID IT: every test here exercised the HTTP shape of
  // one call (path, headers, body keys). Nothing asserted anything about the
  // English the model actually plans from, so the word "update" was never
  // read by any assertion.
  it("does not claim it can update a policy, and names update_heartbeat instead", () => {
    const description = toolDescription();
    expect(description).not.toMatch(/enable or update/i);
    expect(description).toMatch(/create a new/i);
    expect(description).toMatch(/update_heartbeat/);
    // The duplicate-policy consequence must be stated, not merely implied.
    expect(description).toMatch(/two enabled policies/i);
  });

  // FALSE SCHEMA (fixed): `instructions` was Type.Optional. The route coerces a
  // missing value to "" and enable_policy raises ValueError("instructions is
  // required") before uuid4()/db_connection. The route's only except catches
  // AccountIdResolutionError, so that ValueError reaches the app-wide handler
  // and the caller gets 500 INTERNAL_ERROR "Unexpected server error." -- never
  // a 422 naming the field. Declaring it optional invited exactly the call
  // (a plain "wake every N minutes" heartbeat) that always 500s.
  it("declares instructions REQUIRED, because the server refuses an empty one", () => {
    const parameters = schema();
    expect(parameters.required ?? []).toContain("instructions");
    const instructions = parameters.properties.instructions;
    expect(instructions.type).toBe("string");
    // Optional would surface as an anyOf/undefined union rather than a bare string.
    expect(instructions.anyOf).toBeUndefined();
    expect(instructions.minLength).toBe(1);
    expect(toolDescription()).toMatch(/instructions is REQUIRED/);
  });

  // FALSE BOUND (fixed): both timing params declared `minimum: 1`, and the
  // description said only "Heartbeat cadence in seconds." The real function
  // normalize_heartbeat_timing floors cadence at MIN_HEARTBEAT_CADENCE_SECONDS
  // = 180 and then raises it again to turn_timeout + 60; turn_timeout floors at
  // DEFAULT_HEARTBEAT_TURN_TIMEOUT_SECONDS = 120. Measured against the real
  // function: cadence 1/30/60/179 -> 180, and cadence 300 with turn_timeout
  // 600 -> 660. The enable response is {policy_id, status} only, so the
  // rewrite is invisible to the caller.
  //
  // WHY THE GREEN SUITE HID IT: the one HTTP test passed cadence_seconds: 300,
  // a value ABOVE the floor, so it round-tripped unchanged. No test ever sent
  // a sub-floor value, which is the only input that exposes the clamp.
  it("pins the real cadence/timeout floors instead of minimum: 1", () => {
    const properties = schema().properties;
    const cadence = properties.cadence_seconds;
    expect(cadence.minimum).toBe(180);
    expect(cadence.maximum).toBe(86400);
    const timeout = properties.turn_timeout_seconds;
    const timeoutSchema = timeout.type === "integer" ? timeout : timeout.anyOf?.[0];
    expect(timeoutSchema.minimum).toBe(120);
    const description = toolDescription();
    expect(description).toMatch(/max\(180, turn_timeout_seconds \+ 60\)/);
    expect(description).toMatch(/max\(120, requested\)/);
    // The response shape is load-bearing: it never echoes the stored cadence.
    expect(description).toMatch(/\{policy_id, status\} ONLY/);
  });

  it("posts account_ids through to the guarded heartbeat route", async () => {
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

    await runEnableHeartbeat(
      {
        cadence_seconds: 300,
        instructions: "check the open positions",
        account_ids: ["acc-1", "acc-2"],
      },
      { fetchImpl },
    );
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/heartbeat/enable");
    expect(capturedHeaders["x-openclaw-tool"]).toBe("enable_heartbeat");
    expect(capturedBody).toMatchObject({
      cadence_seconds: 300,
      instructions: "check the open positions",
      account_ids: ["acc-1", "acc-2"],
      workspace_id: "ws-001",
    });
  });

  // Still an account-INDEPENDENT heartbeat, but instructions are carried:
  // the previous version of this test sent cadence_seconds alone, modelling
  // exactly the call the server answers with a 500.
  it("can request an account-independent heartbeat with no accounts at all", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ policy_id: "pol-2", status: "enabled" }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await runEnableHeartbeat(
      { cadence_seconds: 900, instructions: "summarise the session" },
      { fetchImpl },
    );
    expect(capturedBody.account_ids).toBeUndefined();
    expect(capturedBody.cadence_seconds).toBe(900);
    expect(capturedBody.instructions).toBe("summarise the session");
  });
});
