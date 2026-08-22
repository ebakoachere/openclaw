import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  runGenerateSessionPlaybook,
  GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
} from "./index.js";

describe("vctraderai-generate-session-playbook", () => {
  it("registers the generate_session_playbook tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-session-playbook",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_SESSION_PLAYBOOK_TOOL_NAME,
      label: "Generate Session Playbook",
    });
  });

  // NOTE: fetch is STUBBED here, so this proves only that whatever the
  // transport returns is passed through unchanged. It cannot see that the real
  // route is absent, nor that the only real generator writes a row. See the
  // description tests at the bottom of this file.
  it("passes a stubbed transport response through verbatim", async () => {
    const envelope = {
      workspace_id: "33333333-3333-3333-3333-333333333333",
      session: "LONDON",
      playbook: { focus_pairs: ["EURUSD", "GBPUSD"], bias: "neutral" },
      sources: ["postgres://core.sessions"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGenerateSessionPlaybook(
      { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF playbooks/session endpoint with POST and a JSON body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["content-type"] ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateSessionPlaybook(
      { workspace_id: "33333333-3333-3333-3333-333333333333", session: "NEW_YORK" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/playbooks/session");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "33333333-3333-3333-3333-333333333333",
      session: "NEW_YORK",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateSessionPlaybook(
        { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  function toolDescription(): string {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-session-playbook",
    });
    plugin.register(captured.api);
    return captured.tools[0].description ?? "";
  }

  function sessionParamDescription(): string {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-session-playbook",
    });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    return String(parameters?.properties?.session?.description ?? "");
  }

  // WHAT WAS FALSE (1): "READ_ONLY per ADR 0078 - no mutation."
  // The only implementation of this generator anywhere,
  // engine/agent/specialists/session_playbook.py, ends generate() with an
  // unconditional save_playbook -> `insert into research.session_playbooks
  // (...) returning id` + conn.commit(), and the tool returns that row's
  // playbook_id; the row carries llm_provider / llm_model /
  // generation_time_ms, so the call also spends an LLM generation. ADR 0078
  // defines read_only as "no side effects beyond an audit row" and does not
  // list this tool, so the cited ADR refutes the label.
  //
  // WHAT WAS FALSE (2): the tool cannot run here at all.
  // 'generate_session_playbook' is in core/openclaw/allowlist.py's
  // RETIRED_ENGINE_TOOLS and absent from the 133-entry ALLOWLIST, and
  // POST /api/v1/openclaw/playbooks/session matches NO route on the assembled
  // app (Starlette Match.NONE; POST /api/v1/openclaw/notifications/send
  // matches FULL in the same probe).
  //
  // WHY THE GREEN SUITE HID BOTH: nothing here read the description, and the
  // transport tests stub fetch, which answers 200 for any path.
  it("does not claim to be read-only, and says the call 404s", () => {
    const description = toolDescription();
    expect(description).toMatch(/UNAVAILABLE/);
    expect(description).toMatch(/404/);
    expect(description).toMatch(/research\.session_playbooks/);
    expect(description).not.toMatch(/READ_ONLY per ADR 0078/i);
    expect(description).not.toMatch(/no mutation/i);
  });

  // WHAT WAS FALSE (3): the session parameter said "Trading session identifier
  // (e.g. LONDON, NEW_YORK, TOKYO). Must match a session enum returned by
  // list_sessions." list_sessions returns core.sessions.code, which
  // ck_core_sessions_code constrains to exactly ASIA, LDN, NY, TWENTYFOUR_HR.
  // The generator's vocabulary is the DISJOINT set
  // SessionName = Literal["london","new_york","tokyo","sydney"], and
  // _normalize_session falls back to DEFAULT_SESSION ("london") without
  // raising. Running the real normalizer: ASIA, LDN, NY and TWENTYFOUR_HR all
  // map to london, while LONDON -> london, NEW_YORK -> new_york, TOKYO ->
  // tokyo. So obeying the instruction guaranteed a London playbook labelled as
  // whatever was asked for, silently - and the sentence contradicted its own
  // three examples, none of which list_sessions can return.
  it("names the generator's own session vocabulary, not list_sessions'", () => {
    const description = sessionParamDescription();
    expect(description).toMatch(/london/);
    expect(description).toMatch(/new_york/);
    expect(description).toMatch(/tokyo/);
    expect(description).toMatch(/sydney/);
    // The silent coercion is the failure the model would otherwise walk into.
    expect(description).toMatch(/coerced to london/i);
    expect(description).not.toMatch(/Must match a session enum returned by list_sessions/i);
  });
});
