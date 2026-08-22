import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentMemoryWrite, AGENT_MEMORY_WRITE_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

type Captured = {
  url: string;
  method: string;
  auth: string | null;
  contentType: string | null;
  workspace: string | null;
  thread: string | null;
  body: Record<string, unknown> | undefined;
};

function capturingFetch(captured: Captured, status = 200): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    captured.auth = headers.get("authorization");
    captured.contentType = headers.get("content-type");
    captured.workspace = headers.get("x-openclaw-workspace");
    captured.thread = headers.get("x-openclaw-thread");
    captured.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Response(
      JSON.stringify({
        data: {
          written_node_ids: ["n1"],
          written_edge_count: 0,
          superseded_node_ids: [],
          skipped: [],
          written_by_kind: "pm",
          written_by_key: "pm",
          stable_projection: "<!-- memory -->",
        },
        trace_id: "t",
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

function emptyCaptured(): Captured {
  return {
    url: "",
    method: "GET",
    auth: null,
    contentType: null,
    workspace: null,
    thread: null,
    body: undefined,
  };
}

const ENTRY = {
  kind: "finding" as const,
  label: "EURUSD London open slippage",
  body: "Fills after 08:00 London ran 0.4 pips worse than backtest on EURUSD.",
};

describe("vctraderai-agent-memory-write", () => {
  const original = {
    workspace: process.env.PFM_WORKSPACE_ID,
    agentWorkspace: process.env.PFM_AGENT_WORKSPACE_ID,
    token: process.env.PFM_AGENT_TOKEN,
  };
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    delete process.env.PFM_AGENT_WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    for (const [name, value] of [
      ["PFM_WORKSPACE_ID", original.workspace],
      ["PFM_AGENT_WORKSPACE_ID", original.agentWorkspace],
      ["PFM_AGENT_TOKEN", original.token],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("registers the agent_memory_write tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-memory-write" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_MEMORY_WRITE_TOOL_NAME,
      label: "Agent Memory Write",
    });
  });

  it("POSTs a JSON body to the workspace-scoped agent-memory/entries endpoint", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl: capturingFetch(captured) });
    expect(new URL(captured.url).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/agent-memory/entries`,
    );
    expect(captured.method).toBe("POST");
    expect(captured.contentType).toBe("application/json");
    expect(captured.auth).toBe("Bearer agent-token-001");
    expect(captured.body).toEqual({ entries: [ENTRY] });
  });

  // THE 403 GUARD. `POST /agent-memory/entries` is the only one of the three
  // memory routes that depends on `require_specialist_authority`. Its
  // `_trusted_workspace_id` reads the SERVER's env (unset on the multi-tenant
  // web_api container) and then this header; with neither, a specialist turn —
  // where the fork stamps X-OpenClaw-Specialist, so the dependency refuses to
  // fall through to PM — is denied 403 openclaw_specialist_denied. The
  // repo-level vctraderai-workspace-header-sweep only guards the
  // OPENCLAW_GATEWAY_TOKEN cluster, so this plugin must pin it itself.
  it("stamps x-openclaw-workspace, or a specialist write is denied 403", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl: capturingFetch(captured) });
    expect(captured.workspace).toBe(WORKSPACE_ID);
  });

  it("prefers PFM_AGENT_WORKSPACE_ID over PFM_WORKSPACE_ID, as the server does", async () => {
    const agentWorkspace = "99999999-8888-7777-6666-555555555555";
    process.env.PFM_AGENT_WORKSPACE_ID = agentWorkspace;
    const captured = emptyCaptured();
    await runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl: capturingFetch(captured) });
    expect(captured.workspace).toBe(agentWorkspace);
  });

  it("forwards the per-turn thread id so the server can attribute the write", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite(
      { entries: [ENTRY] },
      { fetchImpl: capturingFetch(captured), threadId: "thread-abc" },
    );
    expect(captured.thread).toBe("thread-abc");
  });

  it("omits source_ref entirely when it is not supplied (the model forbids extras)", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl: capturingFetch(captured) });
    expect(captured.body).not.toHaveProperty("source_ref");
  });

  it("sends source_ref when supplied", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite(
      { entries: [ENTRY], source_ref: "memory/2026-08-20.md" },
      { fetchImpl: capturingFetch(captured) },
    );
    expect(captured.body).toMatchObject({ source_ref: "memory/2026-08-20.md" });
  });

  it("warns that source_ref is a batch-refusal gate, not just provenance", () => {
    // WHAT WAS FALSE: source_ref was described as "Provenance only — the graph is
    // the record", which tells the model the field cannot affect the write. It
    // can. `MemoryWriter.write` normalises source_ref and calls
    // `is_excluded_ingestion_path` BEFORE any insert (web_api/agent_memory/
    // service.py:117,125); on a match it returns early with written_node_ids=[],
    // written_edge_count=0 and EVERY entry in `skipped` (D-21) — an
    // all-or-nothing refusal of the whole batch. Verified by running
    // core/openclaw/memory_graph.py: 'memory/dreaming/deep/x.md',
    // 'memory/.dreams/x.json', 'notes/dreams.md', 'MEMORY/DREAMING/deep/x.md' and
    // 'memory\dreaming\rem\b.md' all return excluded=true, while
    // 'memory/2026-08-20.md' and 'MEMORY.md' return false.
    //
    // WHY THE GREEN SUITE HID IT: the two tests above assert only that the
    // string reaches the request body. That stays true whether the server then
    // writes the batch or refuses all of it, so transport coverage could never
    // fail on a description that misstates the server's behaviour. Only an
    // assertion on the DESCRIPTION can.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-agent-memory-write",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const sourceRef = tool.parameters?.properties?.source_ref?.description ?? "";
    expect(sourceRef, "source_ref must be an advertised parameter").not.toBe("");
    // The retired lie must not come back.
    expect(sourceRef).not.toContain("Provenance only");
    // The model must be able to predict the refusal BEFORE it loses a flush:
    // both excluded prefixes, the excluded filename, and the fact that the whole
    // batch — not the offending entry — is refused.
    expect(sourceRef).toContain("memory/dreaming");
    expect(sourceRef).toContain("memory/.dreams");
    expect(sourceRef).toContain("dreams.md");
    expect(sourceRef).toMatch(/WHOLE batch/);
    // And where the refusal is legible in the response.
    expect(sourceRef).toContain("skipped");
  });

  it("omits narrative entirely when it is not supplied, or is blank", async () => {
    const captured = emptyCaptured();
    await runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl: capturingFetch(captured) });
    expect(captured.body).not.toHaveProperty("narrative");
    // Whitespace is not a narrative. `MemoryWriter.write` only runs extraction on
    // a non-blank string, so sending "   " would cost a round trip's payload to
    // reach the same no-op — and `extra="forbid"` means an explicit null 422s.
    const blank = emptyCaptured();
    await runAgentMemoryWrite(
      { entries: [ENTRY], narrative: "   \n  " },
      { fetchImpl: capturingFetch(blank) },
    );
    expect(blank.body).not.toHaveProperty("narrative");
  });

  it("sends narrative VERBATIM under that exact key, or typed capture is inert", async () => {
    // This is the seam the whole typed-capture feature hangs on, and it is the
    // shape that has already burned this codebase once: a producer writing one
    // key while the consumer reads another ships a fully unit-tested no-op. The
    // BFF reads `MemoryWriteRequest.narrative` and the request model is
    // `extra="forbid"`, so any other spelling is a 422 rather than a silent drop
    // — but only a test that asserts on the BODY catches it before the bake.
    const captured = emptyCaptured();
    const narrative = [
      "# flush 2026-08-22",
      "",
      "- FINDING — the pool host races the agent for the same file drop (see D-17)",
      "- OPEN QUESTION: does EURUSD stay on feed through the London close?",
    ].join("\n");
    await runAgentMemoryWrite(
      { entries: [ENTRY], narrative },
      { fetchImpl: capturingFetch(captured) },
    );
    expect(captured.body).toMatchObject({ narrative });
    // Verbatim: extraction is line- and marker-anchored, so any reflow here
    // (trimming, joining, list-bullet normalisation) would change what the
    // server can see.
    expect((captured.body as { narrative: string }).narrative).toBe(narrative);
  });

  it("declares narrative as an accepted parameter, so the model can send it", async () => {
    // The plugin forwarding a field the tool schema never advertises is the same
    // as not having it: the model cannot pass what it is not told exists.
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-agent-memory-write",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const narrative = tool.parameters?.properties?.narrative;
    expect(narrative, "narrative must be an advertised parameter").toBeDefined();
    // And it must teach the markers, because extraction only reads marked lines —
    // a model that sends unmarked prose gets `extraction_considered: 0` back and
    // no way to know why.
    expect(narrative?.description ?? "").toContain("FINDING");
    expect(narrative?.description ?? "").toContain("OPEN QUESTION");
  });

  it("requires at least one entry", async () => {
    const fetchImpl = capturingFetch(emptyCaptured());
    await expect(runAgentMemoryWrite({ entries: [] }, { fetchImpl })).rejects.toThrow(
      /entries is required/,
    );
    await expect(runAgentMemoryWrite({} as { entries: [] }, { fetchImpl })).rejects.toThrow(
      /entries is required/,
    );
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: {
              code: "openclaw_specialist_denied",
              message: "Specialist thread could not resolve authority.",
            },
          },
        }),
        { status: 403, statusText: "Forbidden" },
      )) as typeof globalThis.fetch;
    await expect(runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "openclaw_specialist_denied", status: 403 },
    });
  });

  it("fails fast when the workspace id is not configured", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = capturingFetch(emptyCaptured());
    await expect(runAgentMemoryWrite({ entries: [ENTRY] }, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
