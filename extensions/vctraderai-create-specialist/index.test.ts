import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  CREATE_SPECIALIST_TOOL_NAME,
  MAX_CADENCE_SECONDS,
  MIN_CADENCE_SECONDS,
  RESERVED_SPECIALIST_KEYS,
  runCreateSpecialist,
} from "./index.js";

// WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT
//
// Three separate lies shipped in this tool's input schema:
//
// 1. `specialist_key`: "Unique specialist key to claim, e.g. gold_specialist."
//    `gold_specialist` is reserved and can never be claimed. The route calls
//    `_require_specialist_key` (422 `openclaw_specialist_reserved_key`) and,
//    independently, PostgresSpecialistStore.create -> _validate_all ->
//    `validate_specialist_key` raises ReservedSpecialistKeyError. Executed:
//    'gold_specialist' refused at BOTH layers, 'my_gold_desk' accepted at both.
//
// 2. `cadence_seconds`: advertised `minimum: 1`. The server band is 180..86400
//    (`_validate_cadence`), and _validate_all runs BEFORE any DB work, so every
//    schema-legal value in 1..179 -- including the natural picks 30 and 60 --
//    422s as `openclaw_specialist_invalid` with no row created. Executed: 1,
//    30, 59, 60, 120, 179 all refused; 180, 300, 86400, None accepted.
//
// 3. `requested_model`: "Requested model id / route." A route is never legal
//    here. `_validate_requested_model` -> `model_routes.validate_model` accepts
//    only `selectable_models()`; executed, ALL SEVEN ROUTE_KEYS (chat,
//    heartbeat, gold_specialist, pre_session, day_ahead, session_summary,
//    memory_flush) raise `model_not_allowed`, and the intersection of
//    ROUTE_KEYS with selectable_models() is EMPTY.
//
// The old suite hid all three: it never read the schema at all, and every
// fixture used `gold_specialist` against a stubbed 200, so the tests asserted
// the same fiction the description did. Assertions below now read the shipped
// schema and pin the values the server actually enforces.

const VALID_KEY = "my_gold_desk";

function schema(): any {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-create-specialist" });
  plugin.register(captured.api);
  return captured.tools[0].parameters as any;
}

function unwrap(prop: any): any {
  return prop?.anyOf?.[0] ?? prop;
}

describe("vctraderai-create-specialist", () => {
  it("registers the create_specialist tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-specialist" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_SPECIALIST_TOOL_NAME,
      label: "Create Specialist",
    });
  });

  it("never advertises a reserved key as the example, and names the refusal", () => {
    const description = schema().properties.specialist_key.description as string;
    // The exact false sentence that shipped.
    expect(description).not.toContain("Unique specialist key to claim, e.g. gold_specialist.");
    expect(description).not.toMatch(/e\.g\.\s*gold_specialist/);
    expect(description).toContain("openclaw_specialist_reserved_key");
    for (const key of RESERVED_SPECIALIST_KEYS.split(", ")) {
      expect(description).toContain(key);
    }
  });

  it("lists exactly the seven keys the BFF reserves", () => {
    expect(RESERVED_SPECIALIST_KEYS.split(", ").toSorted()).toEqual([
      "chat",
      "day_ahead",
      "gold_specialist",
      "heartbeat",
      "oversight",
      "pre_session",
      "session_summary",
    ]);
  });

  it("advertises the server's real cadence band, not the old minimum of 1", () => {
    const cadence = unwrap(schema().properties.cadence_seconds);
    expect(cadence).toBeDefined();
    expect(cadence.type).toBe("integer");
    // `minimum: 1` was wrong by 179 seconds; 60 was schema-legal and always 422'd.
    expect(cadence.minimum).toBe(180);
    expect(cadence.maximum).toBe(86400);
    expect(MIN_CADENCE_SECONDS).toBe(180);
    expect(MAX_CADENCE_SECONDS).toBe(86400);
    expect(cadence.description).toContain("180..86400");
    expect(cadence.description).toContain("openclaw_specialist_invalid");
  });

  it("does not offer a route as a legal requested_model, and names the id source", () => {
    const requestedModel = unwrap(schema().properties.requested_model);
    expect(requestedModel).toBeDefined();
    const description = requestedModel.description as string;
    // The exact false sentence that shipped.
    expect(description).not.toContain("Requested model id / route.");
    expect(description).toContain("model_not_allowed");
    // Where a legal value actually lives.
    expect(description).toContain("get_model_routes");
    expect(description).toContain("routes.<route_key>.requested_model");
  });

  it("POSTs the create path with the X-OpenClaw-Tool header", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedToolHeader: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "";
      capturedToolHeader = new Headers(init?.headers).get("x-openclaw-tool");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/specialists/create");
    expect(capturedMethod).toBe("POST");
    expect(capturedToolHeader).toBe(CREATE_SPECIALIST_TOOL_NAME);
  });

  it("does not send a body-supplied workspace_id (server derives it)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateSpecialist({ specialist_key: VALID_KEY, display_name: "Gold" }, { fetchImpl });
    expect(capturedBody).toMatchObject({ specialist_key: VALID_KEY, display_name: "Gold" });
    expect("workspace_id" in capturedBody).toBe(false);
  });

  it("forwards a reserved key unchanged -- the 422 is SERVER-side, not local", async () => {
    // Pins the division of labour the description now states: nothing here
    // rejects a reserved key, so the model only learns of it from the BFF's 422.
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(capturedBody.specialist_key).toBe("gold_specialist");
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateSpecialist(
      { specialist_key: VALID_KEY },
      { fetchImpl, threadId: "thread-specialist-7" },
    );
    expect(capturedThreadHeader).toBe("thread-specialist-7");
  });

  it("omits X-OpenClaw-Thread when no thread id is supplied", async () => {
    let hasThreadHeader = true;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasThreadHeader = new Headers(init?.headers).has("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runCreateSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("unprocessable", {
        status: 422,
        statusText: "Unprocessable Entity",
      })) as typeof globalThis.fetch;
    await expect(
      runCreateSpecialist({ specialist_key: VALID_KEY }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_422", status: 422 },
    });
  });
});
