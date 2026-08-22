import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: enqueue_walkforward_worker_job (RETIRED).
//
// This tool is NO LONGER on the ADR 0078 allowlist. W10 B2 / R12 withdrew the
// trader-definition dispatch path from the agent surface as a capability
// RETIREMENT (core/openclaw/allowlist.py: absent from ALLOWLIST, present in
// RETIRED_ENGINE_TOOLS). It still POSTs `POST /api/v1/openclaw/stage`, but that
// endpoint calls gate_tool_call FIRST, which raises ToolForbiddenError for an
// un-allowlisted name and is returned as 403 openclaw_tool_forbidden. Nothing is
// persisted, so this plugin cannot propose -- it can only error.

export const ENQUEUE_WALKFORWARD_WORKER_JOB_TOOL_NAME = "enqueue_walkforward_worker_job";
const STAGE_PATH = "/api/v1/openclaw/stage";

export type EnqueueWalkforwardWorkerJobDeps = {
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

export type EnqueueWalkforwardWorkerJobParams = {
  trader_def_id?: string;
  strategy_id?: string;
  instrument?: string;
  timeframe?: string;
  start?: string;
  end?: string;
  // NO fold-count field: `n_splits` occurs zero times in the platform, and no
  // fold-count input exists under any other name. The engine's walkforward_spec
  // takes train/test/step/gap/warmup/seed and the fold count falls out of that
  // window geometry.
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai enqueue_walkforward_worker_job: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

function buildSummary(params: EnqueueWalkforwardWorkerJobParams): string {
  return `Walkforward ${params.trader_def_id ?? params.strategy_id ?? "job"}`;
}

export async function runEnqueueWalkforwardWorkerJob(
  params: EnqueueWalkforwardWorkerJobParams,
  deps: EnqueueWalkforwardWorkerJobDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const staged = await bffFetch(STAGE_PATH, {
    method: "POST",
    body: {
      tool_name: ENQUEUE_WALKFORWARD_WORKER_JOB_TOOL_NAME,
      workspace_id: readWorkspaceId(),
      params,
      summary: buildSummary(params),
    },
    signal,
  });
  return {
    staged,
    message: "Staged a enqueue walkforward worker job proposal. Review + Apply it in the chat.",
  };
}

export default defineToolPlugin({
  id: "vctraderai-enqueue-walkforward-worker-job",
  name: "VC Trader AI Enqueue Walkforward Worker Job (Propose)",
  description:
    "RETIRED: enqueue_walkforward_worker_job is off the ADR 0078 allowlist; /stage refuses it 403 openclaw_tool_forbidden, so it stages nothing.",
  tools: (tool) => [
    tool({
      name: ENQUEUE_WALKFORWARD_WORKER_JOB_TOOL_NAME,
      label: "Enqueue Walkforward Worker Job",
      description:
        "RETIRED - do not call. enqueue_walkforward_worker_job was removed from the ADR 0078 allowlist (W10 B2), so this tool stages nothing: its only action, POST /api/v1/openclaw/stage, is refused with 403 openclaw_tool_forbidden before any proposal is persisted. The trader-definition dispatch path left the agent surface entirely. dispatch_strategy_experiment is NOT an equivalent - it is strategy-version-first and takes no trader definition and no prop-challenge sizing.",
      parameters: Type.Object(
        {
          trader_def_id: Type.Optional(
            Type.String({ description: "Trader definition id to walk forward." }),
          ),
          strategy_id: Type.Optional(Type.String({ description: "Strategy id to walk forward." })),
          instrument: Type.Optional(
            Type.String({ description: "Instrument symbol (e.g. EUR_USD)." }),
          ),
          timeframe: Type.Optional(Type.String({ description: "Timeframe code (e.g. H1)." })),
          start: Type.Optional(
            Type.String({ description: "Walkforward window start (ISO-8601 date)." }),
          ),
          end: Type.Optional(
            Type.String({ description: "Walkforward window end (ISO-8601 date)." }),
          ),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Strategy parameter overrides keyed by name.",
            }),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runEnqueueWalkforwardWorkerJob(
          params as EnqueueWalkforwardWorkerJobParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
