import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: agent_memory_write (Track C / C4).
//
// DIRECT_CONTROL per propfirm_manager ADR 0078 (core/openclaw/allowlist.py):
// it writes immediately, has no staged card and no Apply, and touches no money.
// POSTs to the workspace-scoped memory-graph BFF as the workspace owner
// (PFM_AGENT_TOKEN), and stamps X-OpenClaw-Workspace because this route — alone
// among the three — depends on `require_specialist_authority`. See the header of
// ./src/internal-http-client.ts for why a missing stamp is a 403.
//
// ATTRIBUTION IS NOT A PARAMETER. `written_by_kind` / `written_by_key` are
// resolved server-side from the fork's stamped X-OpenClaw-Thread /
// X-OpenClaw-Specialist headers (D-20), and the request model is
// `extra="forbid"` — a model that tries to supply them gets a 422, not a
// silently ignored field. That is deliberate: the governance surface must not
// be able to show a confident lie about who learned something.

export const AGENT_MEMORY_WRITE_TOOL_NAME = "agent_memory_write";

/** Reference node types: rows the PLATFORM owns. The graph never mints these. */
const REFERENCE_NODE_TYPES = [
  "account",
  "dataset",
  "decision",
  "instrument",
  "report",
  "run",
  "session",
  "specialist",
  "strategy",
] as const;

export type MemoryReferenceIn = {
  node_type: string;
  entity_ref: string;
  label: string;
};

export type MemoryEntryIn = {
  kind: "finding" | "failure";
  label: string;
  body: string;
  confidence?: number;
  learned_at?: string;
  about?: MemoryReferenceIn[];
  supersedes?: string[];
  contradicts?: string[];
  derived_from?: string[];
};

export type AgentMemoryWriteParams = {
  entries: MemoryEntryIn[];
  source_ref?: string;
  narrative?: string;
};

export type AgentMemoryWriteDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and attribute the write to it. Sourced from the plugin execute
   * context (`context.threadId`).
   */
  threadId?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai agent_memory_write: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runAgentMemoryWrite(
  params: AgentMemoryWriteParams,
  deps: AgentMemoryWriteDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  const entries = Array.isArray(params?.entries) ? params.entries : undefined;
  // The BFF answers 422 on an empty batch. Guard here so a malformed call fails
  // fast with a sentence the model can act on instead of a validation dump.
  if (entries === undefined || entries.length === 0) {
    throw new Error(
      "vctraderai agent_memory_write: entries is required and must hold at least one entry",
    );
  }
  // Only send `source_ref` / `narrative` when actually set: the request model is
  // `extra="forbid"`, and an explicit null is not the same as an absent key.
  const body: { entries: MemoryEntryIn[]; source_ref?: string; narrative?: string } = {
    entries,
  };
  if (typeof params.source_ref === "string" && params.source_ref.length > 0) {
    body.source_ref = params.source_ref;
  }
  if (typeof params.narrative === "string" && params.narrative.trim().length > 0) {
    body.narrative = params.narrative;
  }
  return bffFetch(`/api/v1/workspaces/${workspaceId}/agent-memory/entries`, {
    method: "POST",
    body,
    signal,
  });
}

const MemoryReferenceSchema = Type.Object(
  {
    node_type: Type.Union(
      REFERENCE_NODE_TYPES.map((value) => Type.Literal(value)),
      {
        description:
          "Which platform object this points at. The graph does not own these rows — it only references them.",
      },
    ),
    entity_ref: Type.String({
      description:
        "The platform row's identifier — a uuid, or a natural key such as an instrument code.",
      minLength: 1,
      maxLength: 256,
    }),
    label: Type.String({
      description:
        "How to name it in a rendered index. A record of what you called it when you learned this, NOT a copy to keep in sync — if the row is renamed this label is expected to go stale and entity_ref is what resolves.",
      minLength: 1,
      maxLength: 200,
    }),
  },
  { additionalProperties: false },
);

const MemoryEntrySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("finding"), Type.Literal("failure")], {
      description:
        "'finding' for something learned, 'failure' for something that went wrong and should not be repeated.",
    }),
    label: Type.String({
      description: "A one-line handle. This is what the rendered index shows.",
      minLength: 1,
      maxLength: 200,
    }),
    body: Type.String({
      description:
        "The fact itself, in full. Write it so it is still usable in three weeks by an agent with none of today's context.",
      minLength: 1,
      maxLength: 4000,
    }),
    confidence: Type.Optional(
      Type.Number({
        description: "How sure you are, 0-1. Drives ranking in the durable index.",
        minimum: 0,
        maximum: 1,
      }),
    ),
    learned_at: Type.Optional(
      Type.String({
        description:
          "ISO-8601 UTC. Defaults to now. Set it only when recording something learned earlier than this turn.",
      }),
    ),
    about: Type.Optional(
      Type.Array(MemoryReferenceSchema, {
        description:
          "Platform objects this is about. Each becomes an 'about' edge, and is how the finding is found again from the strategy/run/account it concerns.",
        maxItems: 16,
      }),
    ),
    supersedes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "node_ids this replaces. Each target is marked superseded — it survives, it just stops being current.",
        maxItems: 16,
      }),
    ),
    contradicts: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "node_ids this conflicts with. BOTH survive; the conflict is surfaced rather than resolved for you.",
        maxItems: 16,
      }),
    ),
    derived_from: Type.Optional(
      Type.Array(Type.String(), {
        description: "node_ids this was reasoned from.",
        maxItems: 16,
      }),
    ),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "vctraderai-agent-memory-write",
  name: "VC Trader AI Agent Memory Write",
  description:
    "Workspace-scoped tool: record what the agent learned into its durable memory graph, attributed server-side. Calls the propfirm_manager BFF as the workspace owner (PFM_AGENT_TOKEN). DIRECT_CONTROL per ADR 0078.",
  tools: (tool) => [
    tool({
      name: AGENT_MEMORY_WRITE_TOOL_NAME,
      label: "Agent Memory Write",
      description:
        "Record what you learned into your durable memory graph. Write a 'finding' for something learned and a 'failure' for something that went wrong and must not be repeated, linking each to the strategies, runs, accounts or instruments it is about. Partial success is normal: every rejected entry comes back in `skipped` with a reason, never a bare count. Attribution is resolved by the server from your thread identity — do NOT try to supply it. Returns the refreshed durable index in `stable_projection`; write that verbatim into MEMORY.md, replacing the existing delimited block. Use this when a fact is worth keeping past this session, not for scratch notes.",
      parameters: Type.Object({
        entries: Type.Array(MemoryEntrySchema, {
          description: "The batch of things learned. At least one, at most 32.",
          minItems: 1,
          maxItems: 32,
        }),
        source_ref: Type.Optional(
          Type.String({
            description:
              "Workspace-relative path of the raw capture this came from, e.g. 'memory/2026-08-20.md'; omit it when there is no capture file. Persisted as provenance, but it is also a gate: a path under memory/dreaming/** or memory/.dreams/**, or any dreams.md, makes the server refuse the WHOLE batch — zero nodes, zero edges, and every entry returned in `skipped` (D-21). Matching ignores case, and backslashes and a leading './' are normalised first, so respelling the path does not evade it.",
            maxLength: 512,
          }),
        ),
        narrative: Type.Optional(
          Type.String({
            description:
              "The markdown note this flush just wrote, sent verbatim. Lines that begin FINDING, LEARNED, FAILURE, WENT WRONG, PREFERENCE, PREFERS, OPEN QUESTION or UNRESOLVED become typed nodes, and any decision id (D-17, DEC-66, ADR 0078), account number, currency pair or [[type:ref]] marker inside them becomes an 'about' edge. Nothing else in the prose is mined, and anything you put in 'entries' wins over an extracted duplicate — so send what matters explicitly and use this to catch the rest.",
            maxLength: 200_000,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runAgentMemoryWrite(
          params as AgentMemoryWriteParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
