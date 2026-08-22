import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  runSpawnSpecialist,
  RESERVED_SPECIALIST_KEYS,
  SPAWN_SPECIALIST_TOOL_NAME,
} from "./index.js";

// WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT
//
// `specialist_key` was described as "Specialist key to spawn, e.g.
// gold_specialist." The single example given was the one value the route can
// NEVER accept: web_api/openclaw_internal/router.py's `specialist_spawn` calls
// `_require_specialist_key(payload)` as its third statement -- before the store
// lookup and before the spawn service -- and that helper 422s
// (`openclaw_specialist_reserved_key`) on every member of
// `_RESERVED_SPECIALIST_KEYS`. Executed against the platform: 'gold_specialist'
// -> HTTPException 422, 'eur_specialist' -> returned normally (positive
// control).
//
// The old suite could not catch this because every fixture below ALSO used
// `gold_specialist` against a stubbed 200. Green only ever proved that the
// plugin forwards a string, never that the string was usable -- the tests and
// the description agreed with each other and both were wrong. Fixtures now use
// a key proven acceptable, and one test deliberately keeps a reserved key to
// pin that this plugin is a pass-through and the refusal is SERVER-side.

const VALID_KEY = "eur_specialist";

function schema(): any {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-spawn-specialist" });
  plugin.register(captured.api);
  return captured.tools[0].parameters as any;
}

describe("vctraderai-spawn-specialist", () => {
  it("registers the spawn_specialist tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-spawn-specialist" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: SPAWN_SPECIALIST_TOOL_NAME,
      label: "Spawn Specialist",
    });
  });

  it("never advertises a reserved key as the example, and names the refusal", () => {
    const description = schema().properties.specialist_key.description as string;
    // The exact false sentence that shipped.
    expect(description).not.toContain("Specialist key to spawn, e.g. gold_specialist.");
    expect(description).not.toMatch(/e\.g\.\s*gold_specialist/);
    // The refusal the model would otherwise walk into.
    expect(description).toContain("openclaw_specialist_reserved_key");
    for (const key of RESERVED_SPECIALIST_KEYS.split(", ")) {
      expect(description).toContain(key);
    }
    // Where a usable value actually comes from.
    expect(description).toContain("list_specialists");
    expect(description).toContain("specialists[].specialist_key");
    expect(description).toContain("create_specialist");
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

  it("POSTs the spawn path with the X-OpenClaw-Tool header", async () => {
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
    await runSpawnSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/specialists/spawn");
    expect(capturedMethod).toBe("POST");
    expect(capturedToolHeader).toBe(SPAWN_SPECIALIST_TOOL_NAME);
  });

  it("does not send a body-supplied workspace_id (server derives it)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSpawnSpecialist({ specialist_key: VALID_KEY, instrument: "XAUUSD" }, { fetchImpl });
    expect(capturedBody).toMatchObject({ specialist_key: VALID_KEY, instrument: "XAUUSD" });
    expect("workspace_id" in capturedBody).toBe(false);
  });

  it("forwards a reserved key unchanged -- the 422 is SERVER-side, not local", async () => {
    // Pins the division of labour the description now states: this plugin does
    // not validate the key, so a model that copies a reserved key gets a 422
    // from the BFF rather than a local error it could learn from.
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSpawnSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl });
    expect(capturedBody.specialist_key).toBe("gold_specialist");
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSpawnSpecialist(
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
    await runSpawnSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("unprocessable", {
        status: 422,
        statusText: "Unprocessable Entity",
      })) as typeof globalThis.fetch;
    await expect(
      runSpawnSpecialist({ specialist_key: VALID_KEY }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_422", status: 422 },
    });
  });
});
