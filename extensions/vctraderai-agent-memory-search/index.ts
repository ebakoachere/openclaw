import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_memory_search (Track C / C4).
//
// READ_ONLY per propfirm_manager ADR 0078 (core/openclaw/allowlist.py). Reads
// the workspace-scoped memory-graph BFF as the workspace owner
// (PFM_AGENT_TOKEN) and returns the verbatim envelope.
//
// THERE IS NO THIRD TOOL FOR THE DURABLE INDEX, deliberately. The stable
// projection is not fetched: the flush writes it into MEMORY.md and the fork
// injects it every turn (D-13). This tool is for recalling the things the index
// does not carry — search the graph, do not re-read what you were already given.

export const AGENT_MEMORY_SEARCH_TOOL_NAME = "agent_memory_search";

/** The full D-17 node vocabulary, sorted (core/openclaw/memory_graph.py). */
const NODE_TYPES = [
  "account",
  "dataset",
  "decision",
  "failure",
  "finding",
  "instrument",
  "report",
  "run",
  "session",
  "specialist",
  "strategy",
] as const;

export type AgentMemorySearchParams = {
  query?: string;
  node_type?: string[];
  limit?: number;
};

export type AgentMemorySearchDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_memory_search: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runAgentMemorySearch(
  params: AgentMemorySearchParams = {},
  deps: AgentMemorySearchDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  // `node_type` is a repeated query key, not a comma-joined one: the BFF binds
  // it with FastAPI's `list[str] | None = Query(...)`. See buildQueryString.
  const nodeTypes = Array.isArray(params.node_type)
    ? params.node_type.filter((value): value is string => nonEmpty(value) !== undefined)
    : undefined;
  return bffFetch(`/api/v1/workspaces/${workspaceId}/agent-memory/search`, {
    query: {
      query: nonEmpty(params.query),
      node_type: nodeTypes !== undefined && nodeTypes.length > 0 ? nodeTypes : undefined,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-agent-memory-search",
  name: "VC Trader AI Agent Memory Search",
  description:
    "Read-only workspace-scoped tool: recall what this workspace's agents have learned, from the durable memory graph. Calls the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). READ_ONLY per ADR 0078.",
  tools: (tool) => [
    tool({
      name: AGENT_MEMORY_SEARCH_TOOL_NAME,
      label: "Agent Memory Search",
      description:
        "Recall what you and your specialists have learned in this workspace. Free-text search over the durable memory graph, optionally narrowed by node type. Returns the matching nodes plus the edges AMONG THOSE NODES ONLY — it is not a graph walk, so a node's wider neighbourhood is not returned. READ_ONLY per ADR 0078 — no mutation. Your MEMORY.md already carries the durable index of stable beliefs; use this to reach the detail behind an index line, to check whether something was already learned before re-deriving it, or to find what went wrong last time on a given strategy, run or account.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description:
              "Free text to match against labels and bodies. Omit to list the most recent entries instead.",
          }),
        ),
        node_type: Type.Optional(
          Type.Array(Type.Union(NODE_TYPES.map((value) => Type.Literal(value))), {
            description:
              "Narrow to these node types. 'finding' and 'failure' are what the graph owns; the rest are references to platform rows.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum nodes to return, 1-100. Defaults to 20.",
            minimum: 1,
            maximum: 100,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentMemorySearch(
          params as AgentMemorySearchParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
