import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(),
  forceClearEmbeddedAgentRun: vi.fn(),
  isEmbeddedAgentRunActive: vi.fn(),
  isEmbeddedAgentRunHandleActive: vi.fn(),
  getCommandLaneSnapshot: vi.fn(),
  resetCommandLane: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionId: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn((key: string) => `session:${key}`),
  waitForEmbeddedAgentRunEnd: vi.fn(),
  diag: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("../agents/embedded-agent-runner/runs.js", () => ({
  abortAndDrainEmbeddedAgentRun: async (params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
  }) => {
    const aborted = mocks.abortEmbeddedAgentRun(params.sessionId);
    const drained = aborted
      ? await mocks.waitForEmbeddedAgentRunEnd(params.sessionId, params.settleMs)
      : false;
    const forceCleared =
      params.forceClear === true && (!aborted || !drained)
        ? mocks.forceClearEmbeddedAgentRun(params.sessionId, params.sessionKey, params.reason)
        : false;
    return { aborted, drained, forceCleared };
  },
  abortEmbeddedAgentRun: mocks.abortEmbeddedAgentRun,
  forceClearEmbeddedAgentRun: mocks.forceClearEmbeddedAgentRun,
  isEmbeddedAgentRunActive: mocks.isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive: mocks.isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveActiveEmbeddedRunHandleSessionId: mocks.resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  waitForEmbeddedAgentRunEnd: mocks.waitForEmbeddedAgentRunEnd,
}));

vi.mock("../agents/embedded-agent-runner/lanes.js", () => ({
  resolveEmbeddedSessionLane: mocks.resolveEmbeddedSessionLane,
}));

vi.mock("../process/command-queue.js", () => ({
  getCommandLaneSnapshot: mocks.getCommandLaneSnapshot,
  resetCommandLane: mocks.resetCommandLane,
}));

vi.mock("./diagnostic-runtime.js", () => ({
  diagnosticLogger: mocks.diag,
}));

// NOT mocked: ./diagnostic-run-activity.js. The whole point of this file is
// that the real activity store is the wire between the compaction wrapper and
// the sweeper; mocking the snapshot would test the mock instead of the wire.
import {
  COMPACTION_PROGRESS_ENDED_REASON,
  COMPACTION_PROGRESS_RUNNING_REASON,
  COMPACTION_PROGRESS_STARTED_REASON,
  withCompactionRunProgress,
} from "../agents/embedded-agent-runner/compaction-liveness.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "./diagnostic-run-activity.js";
import {
  recoverStuckDiagnosticSession,
  testing,
} from "./diagnostic-stuck-session-recovery.runtime.js";

const SESSION_ID = "compaction-liveness-session";
const SESSION_KEY = "agent:main:main";
const STALE_ABORT_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetMocks(): void {
  testing.resetRecoveriesInFlight();
  resetDiagnosticRunActivityForTest();
  for (const fn of [
    mocks.abortEmbeddedAgentRun,
    mocks.forceClearEmbeddedAgentRun,
    mocks.isEmbeddedAgentRunActive,
    mocks.isEmbeddedAgentRunHandleActive,
    mocks.resetCommandLane,
    mocks.resolveActiveEmbeddedRunSessionId,
    mocks.resolveActiveEmbeddedRunSessionIdBySessionFile,
    mocks.resolveActiveEmbeddedRunHandleSessionId,
    mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
    mocks.waitForEmbeddedAgentRunEnd,
    mocks.diag.debug,
    mocks.diag.warn,
  ]) {
    fn.mockReset();
  }
  mocks.getCommandLaneSnapshot.mockReset();
  mocks.getCommandLaneSnapshot.mockReturnValue({
    lane: `session:${SESSION_KEY}`,
    queuedCount: 0,
    activeCount: 0,
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  });
  mocks.resolveEmbeddedSessionLane.mockClear();
  // The session has an active embedded run and queued work behind it: exactly
  // the state a session is in while it compacts mid-turn.
  mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(SESSION_ID);
  mocks.abortEmbeddedAgentRun.mockReturnValue(true);
  mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
}

async function sweep() {
  return await recoverStuckDiagnosticSession({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    ageMs: 180_000,
    queueDepth: 1,
    staleActiveProgressAbortMs: STALE_ABORT_MS,
  });
}

describe("compaction liveness reaches the stuck-session sweeper", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("POSITIVE CONTROL: a compaction that emits nothing is force-aborted", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
    // A compaction with no liveness of its own: time passes, nothing is marked.
    await sleep(STALE_ABORT_MS * 3);

    const outcome = await sweep();

    expect(outcome.status).toBe("aborted");
    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(SESSION_ID);
    expect(
      mocks.diag.warn.mock.calls.some(([m]) => String(m).includes("reclaiming stale active run")),
    ).toBe(true);
    markDiagnosticEmbeddedRunEnded({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  });

  it("a compaction wrapped in the liveness heartbeat survives the same sweep", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });

    let sweptOutcome: Awaited<ReturnType<typeof sweep>> | undefined;
    await withCompactionRunProgress(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
      async () => {
        // Run for well past the sweeper's stale threshold, then let the sweeper
        // judge the session while the compaction is still in flight.
        await sleep(STALE_ABORT_MS * 3);
        sweptOutcome = await sweep();
      },
      { intervalMs: Math.floor(STALE_ABORT_MS / 4) },
    );

    expect(sweptOutcome?.status).toBe("skipped");
    // `reason` only exists on the skipped/noop/failed arms of the outcome union,
    // so narrow rather than assert past it. An outcome without a `reason` makes
    // this `false` and fails, which is the point.
    expect(sweptOutcome && "reason" in sweptOutcome && sweptOutcome.reason).toBe(
      "active_embedded_run",
    );
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    markDiagnosticEmbeddedRunEnded({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  });

  it("marks start, heartbeat and end on the session the sweeper reads", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
    const seen: string[] = [];
    await withCompactionRunProgress(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
      async () => {
        seen.push(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).lastProgressReason ?? "",
        );
        await sleep(40);
        seen.push(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).lastProgressReason ?? "",
        );
      },
      { intervalMs: 10 },
    );
    seen.push(
      getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).lastProgressReason ?? "",
    );

    expect(seen[0]).toBe(COMPACTION_PROGRESS_STARTED_REASON);
    expect(seen[1]).toBe(COMPACTION_PROGRESS_RUNNING_REASON);
    expect(seen[2]).toBe(COMPACTION_PROGRESS_ENDED_REASON);
    markDiagnosticEmbeddedRunEnded({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  });

  it("stops the heartbeat when the compaction throws", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
    await expect(
      withCompactionRunProgress(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
        async () => {
          throw new Error("compaction blew up");
        },
        { intervalMs: 10 },
      ),
    ).rejects.toThrow("compaction blew up");

    const before = getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID });
    expect(before.lastProgressReason).toBe(COMPACTION_PROGRESS_ENDED_REASON);
    await sleep(40);
    const after = getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID });
    expect(after.lastProgressReason).toBe(COMPACTION_PROGRESS_ENDED_REASON);
    expect(after.lastProgressAgeMs ?? 0).toBeGreaterThanOrEqual(30);
    markDiagnosticEmbeddedRunEnded({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  });
});
