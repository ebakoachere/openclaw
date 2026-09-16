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

/**
 * The D-17 node vocabulary, sorted.
 *
 * DERIVED FROM ``core/openclaw/memory_graph.py`` -- ``OWNED_NODE_TYPES`` (6) |
 * ``REFERENCE_NODE_TYPES`` (11). Eleven of the seventeen were listed here until
 * 2026-09-16, and the comment above the array said "the full D-17 node
 * vocabulary" while it was six short. Nobody re-derived it BECAUSE it claimed to
 * be complete.
 *
 * There is no import across the two languages, so the real guard is the baked
 * surface lock (propfirm_manager #1958): the parity test reads this array's
 * resolved enum out of the pushed image and compares it to the Python constant.
 * The count assertion in index.test.ts is a local tripwire, not that guard.
 */
const NODE_TYPES = [
  "account",
  "asset_group",
  "dataset",
  "decision",
  "event",
  "failure",
  "finding",
  "instrument",
  "open_question",
  "preference",
  "regime",
  "report",
  "run",
  "session",
  "specialist",
  "strategy",
  "theme",
] as const;

export type AgentMemorySearchParams = {
  query?: string;
  node_type?: string[];
  limit?: number;
  hops?: number;
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
      // String()'d rather than truthiness-tested: `hops: 0` is the meaningful
      // "hits only" request and a falsy check would silently drop it back to
      // the server default of 1, which is the opposite of what was asked.
      hops: params.hops !== undefined ? String(params.hops) : undefined,
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
        "Recall what you and your specialists have learned in this workspace. Free-text search over the durable memory graph, optionally narrowed by node type. IT IS A GRAPH WALK BY DEFAULT: the ranked matches come back, and then one hop of their neighbours comes back with them, each marked via='neighbour'. Those neighbour rows are LEADS, not hits — they did not match your query, they are attached to something that did, so read them as context and do not report one as an answer. total_matched and the retrieval verdict count HITS ONLY, so a neighbour never inflates either. Set hops=0 for hits only, or hops=2 to reach one step further. READ_ONLY per ADR 0078 — no mutation. Your MEMORY.md already carries the durable index of stable beliefs; use this to reach the detail behind an index line, to check whether something was already learned before re-deriving it, or to find what went wrong last time on a given strategy, run or account.",
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
              "Narrow to these node types. Six are OWNED by the graph and carry a body of their own -- 'finding', 'failure', 'preference', 'open_question', 'theme' and 'regime'. The other eleven are REFERENCES to rows the platform already owns, carrying a label and a pointer rather than a restatement.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum nodes to return, 1-100. Defaults to 20.",
            minimum: 1,
            maximum: 100,
          }),
        ),
        hops: Type.Optional(
          Type.Integer({
            description:
              "How far to walk from each ranked match. DEFAULTS TO 1: one hop of neighbours comes back alongside the hits unless you say otherwise, marked via='neighbour' and capped at roughly 12 leads per hop. Use 0 when you want only what actually matched -- checking whether a belief exists, or counting matches -- and 2 when a first search returned something adjacent to the answer and you want its surroundings.",
            minimum: 0,
            maximum: 2,
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
