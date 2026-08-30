import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";

/**
 * Compaction liveness.
 *
 * Every other kind of long-running work in a turn refreshes the session's
 * freshness clock: tool calls mark start/end, and streaming model calls mark
 * progress on each chunk (`attempt.model-diagnostic-events.ts`). Compaction did
 * neither. It runs its own model call outside that instrumentation, for up to
 * `compaction.timeoutSeconds` (600s on the live per-workspace config), while
 * the stuck-session sweeper treats a session whose last progress is older than
 * `stuckSessionAbortMs` as stalled and force-aborts the active run
 * (`diagnostic-stuck-session-recovery.runtime.ts` -> `isActiveRunProgressStale`,
 * and `diagnostic.ts` -> `isStalledModelCallRecoveryEligible`). A healthy
 * compaction and a hung one were therefore indistinguishable, and the healthy
 * one lost.
 */
export const COMPACTION_PROGRESS_STARTED_REASON = "compaction:started";
export const COMPACTION_PROGRESS_RUNNING_REASON = "compaction:running";
export const COMPACTION_PROGRESS_ENDED_REASON = "compaction:ended";

/**
 * How often the freshness clock is refreshed while a compaction is in flight.
 * Well under any sane `stuckSessionAbortMs` (the fork default for the stale
 * active-run reclaim is 5 minutes) so a compaction that is merely slow is never
 * mistaken for one that is stuck.
 */
export const COMPACTION_PROGRESS_INTERVAL_MS = 15_000;

export type CompactionLivenessTarget = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

function progressFields(target: CompactionLivenessTarget, reason: string) {
  return {
    ...(target.runId ? { runId: target.runId } : {}),
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    reason,
  };
}

/**
 * Refresh the session freshness clock, and mirror it to diagnostic observers.
 *
 * The in-memory mark is what the sweeper reads, so it is unconditional. The
 * emitted event is for observers only and is skipped when diagnostics are off,
 * matching `maybeEmitModelCallStreamProgress`.
 */
export function markCompactionProgress(target: CompactionLivenessTarget, reason: string): void {
  const fields = progressFields(target, reason);
  markDiagnosticRunProgress(fields);
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  emitTrustedDiagnosticEvent({ type: "run.progress", ...fields });
}

/**
 * Run `fn` while holding the session's freshness clock open.
 *
 * Progress is marked on entry, on a fixed interval for as long as the
 * compaction runs, and once more on exit (success or failure) so the session
 * does not inherit a stale clock from the compaction it just finished.
 */
export async function withCompactionRunProgress<T>(
  target: CompactionLivenessTarget,
  fn: () => Promise<T>,
  options?: { intervalMs?: number },
): Promise<T> {
  markCompactionProgress(target, COMPACTION_PROGRESS_STARTED_REASON);
  const intervalMs = Math.max(1, options?.intervalMs ?? COMPACTION_PROGRESS_INTERVAL_MS);
  const timer = setInterval(() => {
    markCompactionProgress(target, COMPACTION_PROGRESS_RUNNING_REASON);
  }, intervalMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    markCompactionProgress(target, COMPACTION_PROGRESS_ENDED_REASON);
  }
}
