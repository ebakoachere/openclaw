import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  isMidTurnPrecheckSignal,
  MID_TURN_PRECHECK_ERROR_MESSAGE,
  MidTurnPrecheckSignal,
  type MidTurnPrecheckRequest,
} from "./run/midturn-precheck.js";
import {
  createMessageCharEstimateCache,
  estimateContextChars,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";
import {
  installToolResultContextGuard,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
} from "./tool-result-context-guard.js";

/**
 * Replay of the live overflow that killed a turn on the founder's workspace,
 * 2026-08-30T11:36:10.187Z, log group /ecs/pfm-staging-openclaw-per-workspace,
 * stream prefix 6c9176ed-88b4-404f-8b51-70cd63cdeeff. The guard printed its own
 * inputs at the throw site:
 *
 *   contextTokenBudget=600000 safeThresholdTokens=540000
 *   safeThresholdChars=2160000 estimatedContextChars=2613679
 *   toolResultWeightedChars=2517838 toolResultMessages=121
 *   nonToolResultChars=95841 nonToolResultMessages=27 messages=148
 *
 * The estimator is a pure function of per-message character counts and block
 * kinds, so an array with the same counts is indistinguishable from the real
 * one to every code path under test. `reproduces the estimate the live guard
 * logged` below is the control for that claim: if this fixture did not match
 * the failing turn, it would not land on 2,613,679 exactly.
 */

const LIVE_CONTEXT_TOKEN_BUDGET = 600_000;
const LIVE_RESERVE_TOKENS = 20_000; // compaction.reserveTokensFloor, live config
const LIVE_TOOL_RESULT_MESSAGES = 121;
const LIVE_NON_TOOL_RESULT_MESSAGES = 27;
const LIVE_TOOL_RESULT_TEXT_CHARS = 1_258_919; // toolResultWeightedChars 2,517,838 / 2
const LIVE_NON_TOOL_RESULT_CHARS = 95_841;
const LIVE_ESTIMATED_CONTEXT_CHARS = 2_613_679;
const LIVE_SAFE_THRESHOLD_CHARS = 2_160_000;

/** The weighting the deployed image applied: 4 / 2 chars-per-token. */
const SHIPPED_TOOL_RESULT_WEIGHT = 2;

function splitChars(total: number, parts: number): number[] {
  const each = Math.floor(total / parts);
  const sizes = Array.from({ length: parts }, () => each);
  sizes[parts - 1] += total - each * parts;
  return sizes;
}

function buildFailingTurnMessages(): AgentMessage[] {
  const toolResultSizes = splitChars(LIVE_TOOL_RESULT_TEXT_CHARS, LIVE_TOOL_RESULT_MESSAGES);
  const userSizes = splitChars(LIVE_NON_TOOL_RESULT_CHARS, LIVE_NON_TOOL_RESULT_MESSAGES);
  const messages: AgentMessage[] = [];
  for (let i = 0; i < LIVE_TOOL_RESULT_MESSAGES; i++) {
    messages.push(
      castAgentMessage({
        role: "toolResult",
        toolCallId: `call-${i}`,
        toolName: "ohlcv_tail",
        content: [{ type: "text", text: "x".repeat(toolResultSizes[i]) }],
        isError: false,
        timestamp: 1_788_089_770_000 + i,
      }),
    );
    const userIndex = i % LIVE_NON_TOOL_RESULT_MESSAGES;
    if (i < LIVE_NON_TOOL_RESULT_MESSAGES) {
      messages.push(
        castAgentMessage({
          role: "user",
          content: "u".repeat(userSizes[userIndex]),
          timestamp: 1_788_089_770_000 + i,
        }),
      );
    }
  }
  return messages;
}

/** What `estimateMessageChars` computed in the deployed image. */
function estimateContextCharsAsShipped(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const record = message as unknown as { role?: string; content?: unknown };
    if (record.role === "toolResult") {
      const blocks = Array.isArray(record.content) ? record.content : [];
      const chars = blocks.reduce((sum: number, block) => {
        const typed = block as { type?: string; text?: string };
        return (
          sum + (typed?.type === "text" && typeof typed.text === "string" ? typed.text.length : 0)
        );
      }, 0);
      total += Math.max(chars, Math.ceil(chars * SHIPPED_TOOL_RESULT_WEIGHT));
      continue;
    }
    total += typeof record.content === "string" ? record.content.length : 0;
  }
  return total;
}

type GuardRun = {
  outcome: "passed" | "preemptive_overflow" | "midturn_precheck";
  error?: unknown;
  /**
   * Everything handed to `onMidTurnPrecheck`. This is the exact wire
   * `run/attempt.ts` uses to reach `handleMidTurnPrecheckRequest`, so an empty
   * array means the runtime would have been told nothing.
   */
  precheckRequests: MidTurnPrecheckRequest[];
};

async function runGuard(
  messages: AgentMessage[],
  midTurnPrecheck?: {
    enabled?: boolean;
    reserveTokens?: number;
    contextTokenBudget?: number;
    prePromptMessageCount?: number;
  },
): Promise<GuardRun> {
  const precheckRequests: MidTurnPrecheckRequest[] = [];
  const agent: { transformContext?: (m: AgentMessage[], s: AbortSignal) => unknown } = {};
  installToolResultContextGuard({
    agent,
    contextWindowTokens: LIVE_CONTEXT_TOKEN_BUDGET,
    ...(midTurnPrecheck
      ? {
          midTurnPrecheck: {
            enabled: midTurnPrecheck.enabled ?? true,
            contextTokenBudget: midTurnPrecheck.contextTokenBudget ?? LIVE_CONTEXT_TOKEN_BUDGET,
            reserveTokens: () => midTurnPrecheck.reserveTokens ?? LIVE_RESERVE_TOKENS,
            getPrePromptMessageCount: () => midTurnPrecheck.prePromptMessageCount ?? 0,
            onMidTurnPrecheck: (request) => {
              precheckRequests.push(request);
            },
          },
        }
      : {}),
  });
  try {
    await agent.transformContext?.(messages, new AbortController().signal);
    return { outcome: "passed", precheckRequests };
  } catch (err) {
    return {
      outcome: isMidTurnPrecheckSignal(err) ? "midturn_precheck" : "preemptive_overflow",
      error: err,
      precheckRequests,
    };
  }
}

describe("live overflow replay 2026-08-30", () => {
  it("reproduces the estimate the live guard logged", () => {
    const messages = buildFailingTurnMessages();
    expect(messages).toHaveLength(LIVE_TOOL_RESULT_MESSAGES + LIVE_NON_TOOL_RESULT_MESSAGES);
    expect(estimateContextCharsAsShipped(messages)).toBe(LIVE_ESTIMATED_CONTEXT_CHARS);
    expect(LIVE_ESTIMATED_CONTEXT_CHARS).toBeGreaterThan(LIVE_SAFE_THRESHOLD_CHARS);
  });

  it("counts the same turn lower than the deployed image did", () => {
    const messages = buildFailingTurnMessages();
    const shipped = estimateContextCharsAsShipped(messages);
    const measured = estimateContextChars(messages, createMessageCharEstimateCache());
    expect(measured).toBeLessThan(shipped);
    const shippedTokens = Math.ceil(shipped / CHARS_PER_TOKEN_ESTIMATE);
    const measuredTokens = Math.ceil(measured / CHARS_PER_TOKEN_ESTIMATE);
    expect(shippedTokens).toBe(653_420);
    // Reported in the PR body; asserted here so a constant change has to move
    // this number deliberately rather than quietly. Provider-tokenised, the
    // same tool results are ~443,900 tokens on deepseek-v4-flash (the model
    // that actually served this turn) and ~515,900 on claude-sonnet-4-6.
    expect(measuredTokens).toBe(571_319);
  });
});

/**
 * Whether the precheck FIRES on this turn is a separate question from whether
 * the suite is green, and three independent gates stand between the two
 * (`tool-result-context-guard.ts`): `midTurnPrecheck.enabled` (:499), a tool
 * result after the prompt fence (:511), and a route other than "fits" (:538).
 * Any one of them falling through lands on the overflow throw at :549 instead.
 * The precheck does NOT convert that error -- it pre-empts it.
 *
 * So each gate gets its own negative control. A test that only asserted "no
 * overflow error" would pass on a guard that raised nothing at all.
 */
describe("mid-turn precheck fires on the replayed turn, and only when all three gates hold", () => {
  it("POSITIVE: raises MidTurnPrecheckSignal, and hands the request to the runtime", async () => {
    const result = await runGuard(buildFailingTurnMessages(), {});

    // The exact predicate run/attempt.ts routes on before calling
    // handleMidTurnPrecheckRequest.
    expect(isMidTurnPrecheckSignal(result.error)).toBe(true);
    expect(result.error).toBeInstanceOf(MidTurnPrecheckSignal);
    const signal = result.error as MidTurnPrecheckSignal;
    expect(signal.name).toBe("MidTurnPrecheckSignal");
    expect(signal.message).toBe(MID_TURN_PRECHECK_ERROR_MESSAGE);
    // It is NOT the overflow error wearing a different hat.
    expect(signal.message).not.toBe(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);

    // A request that routes "fits" is never signalled, so a signal carrying one
    // would mean the guard threw for a turn it had judged to fit.
    expect(signal.request.route).not.toBe("fits");
    expect(signal.request.overflowTokens).toBeGreaterThan(0);

    // handleMidTurnPrecheckRequest is reached through this callback. Without
    // it the signal would unwind with the runtime never told to compact.
    expect(result.precheckRequests).toHaveLength(1);
    expect(result.precheckRequests[0]).toBe(signal.request);
  });

  it("NEGATIVE (gate 1, enabled): the same replay still dies on the overflow throw", async () => {
    const result = await runGuard(buildFailingTurnMessages());

    expect(result.outcome).toBe("preemptive_overflow");
    expect(isMidTurnPrecheckSignal(result.error)).toBe(false);
    expect((result.error as Error).message).toBe(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    expect(result.precheckRequests).toHaveLength(0);
  });

  it("NEGATIVE (gate 2, fence): no tool result after the fence means no precheck", async () => {
    const messages = buildFailingTurnMessages();
    const result = await runGuard(messages, { prePromptMessageCount: messages.length });

    expect(result.outcome).toBe("preemptive_overflow");
    expect((result.error as Error).message).toBe(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    expect(result.precheckRequests).toHaveLength(0);
  });

  it("NEGATIVE (gate 3, route): a prompt the precheck judges to fit raises nothing", async () => {
    // Same messages, same char guard, but a budget large enough that the
    // precheck routes "fits" -- exactly the divergence between the two
    // mechanisms, and the reason the overflow throw is still reachable.
    const result = await runGuard(buildFailingTurnMessages(), {
      contextTokenBudget: 2_000_000,
    });

    expect(result.outcome).toBe("preemptive_overflow");
    expect(isMidTurnPrecheckSignal(result.error)).toBe(false);
    expect((result.error as Error).message).toBe(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    expect(result.precheckRequests).toHaveLength(0);
  });
});
