import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runAgentMemorySearch, AGENT_MEMORY_SEARCH_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

type Captured = {
  url: string;
  method: string;
  auth: string | null;
  workspace: string | null;
  thread: string | null;
};

function capturingFetch(captured: Captured): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    captured.auth = headers.get("authorization");
    captured.workspace = headers.get("x-openclaw-workspace");
    captured.thread = headers.get("x-openclaw-thread");
    return new Response(
      JSON.stringify({
        data: { query: null, nodes: [], edges: [], total_matched: 0, truncated: false },
        trace_id: "t",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

function emptyCaptured(): Captured {
  return { url: "", method: "GET", auth: null, workspace: null, thread: null };
}

describe("vctraderai-agent-memory-search", () => {
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

  it("registers the agent_memory_search tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-agent-memory-search" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: AGENT_MEMORY_SEARCH_TOOL_NAME,
      label: "Agent Memory Search",
    });
  });

  it("GETs the workspace-scoped agent-memory/search endpoint as the workspace owner", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch({ query: "slippage" }, { fetchImpl: capturingFetch(captured) });
    const parsed = new URL(captured.url);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/agent-memory/search`);
    expect(captured.method).toBe("GET");
    expect(captured.auth).toBe("Bearer agent-token-001");
    expect(parsed.searchParams.get("query")).toBe("slippage");
  });

  // FastAPI binds `node_type: list[str] | None = Query(...)` from a REPEATED
  // key. A comma-joined single value would arrive as one bogus node type and
  // match nothing at all — a silent empty result, not an error.
  it("repeats node_type rather than comma-joining it", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch(
      { query: "eurusd", node_type: ["finding", "failure"] },
      { fetchImpl: capturingFetch(captured) },
    );
    const parsed = new URL(captured.url);
    expect(parsed.searchParams.getAll("node_type")).toEqual(["finding", "failure"]);
    expect(captured.url).not.toContain("finding%2Cfailure");
  });

  it("passes limit through and omits absent parameters", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch({ limit: 50 }, { fetchImpl: capturingFetch(captured) });
    const parsed = new URL(captured.url);
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.has("query")).toBe(false);
    expect(parsed.searchParams.has("node_type")).toBe(false);
  });

  it("omits node_type when the array is empty", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch({ node_type: [] }, { fetchImpl: capturingFetch(captured) });
    expect(new URL(captured.url).searchParams.has("node_type")).toBe(false);
  });

  it("works with no arguments at all (recent entries)", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch(undefined, { fetchImpl: capturingFetch(captured) });
    const parsed = new URL(captured.url);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/agent-memory/search`);
    expect(parsed.search).toBe("");
  });

  it("forwards the per-turn thread id and the workspace stamp", async () => {
    const captured = emptyCaptured();
    await runAgentMemorySearch(
      { query: "x" },
      { fetchImpl: capturingFetch(captured), threadId: "thread-abc" },
    );
    expect(captured.thread).toBe("thread-abc");
    expect(captured.workspace).toBe(WORKSPACE_ID);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad request", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof globalThis.fetch;
    await expect(runAgentMemorySearch({ query: "x" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_400", status: 400 },
    });
  });

  it("fails fast when the workspace id is not configured", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = capturingFetch(emptyCaptured());
    await expect(runAgentMemorySearch({ query: "x" }, { fetchImpl })).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
