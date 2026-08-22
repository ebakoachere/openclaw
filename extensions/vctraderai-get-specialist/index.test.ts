import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  GET_SPECIALIST_TOOL_NAME,
  RESERVED_SPECIALIST_KEYS,
  runGetSpecialist,
} from "./index.js";

// WHAT WAS FALSE, AND WHY A GREEN SUITE HID IT
//
// `specialist_key` was described as "Specialist key to read, e.g.
// gold_specialist." That read can never succeed. The get route deliberately
// skips the reserved-key guard (`_existing_specialist_key`) on the belief that
// a reserved built-in is still readable -- but no production path can ever
// WRITE such a row: research.alpha_specialists has exactly one production
// INSERT (specialist_store.py, PostgresSpecialistStore.create; a repo-wide grep
// returns it plus test files only), and it is gated by `_validate_all` ->
// `validate_specialist_key`, which refuses every reserved key. Executed through
// that same composed gate: 'gold_specialist' refused, 'my_gold_desk' accepted.
// So store.get returns None and the route raises 404
// `openclaw_specialist_not_found` for the exact key the description named.
//
// The old suite actively pinned the lie. "returns the specialist envelope
// verbatim on the happy path" stubbed a 200 carrying a
// { specialist_key: "gold_specialist" } row -- a state the platform cannot
// produce -- and every other fixture used the same key. The mock supplied the
// row the database never could, so green meant nothing about reachability.

const VALID_KEY = "my_gold_desk";

function schema(): any {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-get-specialist" });
  plugin.register(captured.api);
  return captured.tools[0].parameters as any;
}

describe("vctraderai-get-specialist", () => {
  it("registers the get_specialist tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-specialist" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_SPECIALIST_TOOL_NAME,
      label: "Get Specialist",
    });
  });

  it("never advertises an unreadable reserved key as the example", () => {
    const description = schema().properties.specialist_key.description as string;
    // The exact false sentence that shipped.
    expect(description).not.toContain("Specialist key to read, e.g. gold_specialist.");
    expect(description).not.toMatch(/e\.g\.\s*gold_specialist/);
    // The failure the model would otherwise walk into.
    expect(description).toContain("openclaw_specialist_not_found");
    for (const key of RESERVED_SPECIALIST_KEYS.split(", ")) {
      expect(description).toContain(key);
    }
    // Where a readable key actually comes from.
    expect(description).toContain("list_specialists");
    expect(description).toContain("specialists[].specialist_key");
  });

  it("lists exactly the seven keys that can never be registered", () => {
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

  it("GETs the specialists path including the URL-encoded specialist_key path param", async () => {
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
    await runGetSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/openclaw/specialists/${VALID_KEY}`);
    expect(capturedMethod).toBe("GET");
    expect(capturedToolHeader).toBe(GET_SPECIALIST_TOOL_NAME);
  });

  it("throws when specialist_key is missing", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runGetSpecialist({}, { fetchImpl })).rejects.toThrow(/specialist_key is required/);
  });

  it("returns the specialist envelope verbatim on the happy path", async () => {
    // Fixture uses a key the platform can actually hold a row for; the old one
    // (`gold_specialist`) can never exist, so this test used to describe a
    // "happy path" that does not exist in production.
    const envelope = {
      ok: true,
      specialist: { specialist_key: VALID_KEY, display_name: "Gold Desk" },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("stamps X-OpenClaw-Thread with the per-turn thread id when supplied", async () => {
    let capturedThreadHeader: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedThreadHeader = new Headers(init?.headers).get("x-openclaw-thread");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetSpecialist(
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
    await runGetSpecialist({ specialist_key: VALID_KEY }, { fetchImpl });
    expect(hasThreadHeader).toBe(false);
  });

  it("surfaces a structured error on bff 404 -- what a reserved key really returns", async () => {
    const fetchImpl = (async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      })) as typeof globalThis.fetch;
    await expect(
      runGetSpecialist({ specialist_key: "gold_specialist" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_404", status: 404 },
    });
  });
});
