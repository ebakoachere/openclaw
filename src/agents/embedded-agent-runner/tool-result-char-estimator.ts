import type { AgentMessage } from "../runtime/index.js";

export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Characters per token for ONE tool result, considered alone.
 *
 * MEASURED, 2026-08-30, not guessed. 300 tool results sampled from live agent
 * session transcripts (1,479 available across 68 session files; 1,812,345
 * characters) were tokenised with the serving providers' own tokenisers --
 * Anthropic `/v1/messages/count_tokens` for claude-sonnet-4-6 and the DeepSeek
 * completions endpoint's `usage.prompt_tokens` for deepseek-v4-flash, with the
 * per-request framing overhead measured and subtracted. Observed
 * chars-per-token, claude-sonnet-4-6 / deepseek-v4-flash:
 *
 *   p0    1.77 / 2.00      p25   2.30 / 2.64      p90   3.63 / 4.60
 *   p5    1.99 / 2.24      p50   2.68 / 3.04      p100  4.22 / 4.93
 *   p10   2.16 / 2.47      p75   3.23 / 3.59      mean  2.77 / 3.21
 *
 * Agent tool results are JSON and numeric payloads, not prose: identifiers,
 * punctuation and digit runs tokenise far worse than English text, which is
 * why this is nowhere near {@link CHARS_PER_TOKEN_ESTIMATE}. The 5th
 * percentile of the densest model is 1.99, so 2 is kept -- it is the
 * conservative percentile a measurement chooses, and it covers a single
 * unusually dense result rather than an average one.
 */
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;

/**
 * Characters per token for a WHOLE CONTEXT worth of tool results.
 *
 * A per-result 5th percentile is the right conservatism for a decision about
 * one result. It is the wrong number for a SUM: the failing turn this constant
 * was derived from carried 121 tool results, and the ratio of a sum converges
 * on the character-weighted mean with vanishing spread, never on the tail of
 * the per-result distribution. Bootstrapping 121-result windows from the same
 * 300-result sample (20,000 draws) gives an aggregate chars-per-token of:
 *
 *   claude-sonnet-4-6   p0 2.26   p1 2.30   p5 2.34   p50 2.44   p100 2.82
 *   deepseek-v4-flash   p0 2.63   p1 2.70   p5 2.73   p50 2.83   p100 3.26
 *
 * Even the WORST 121-result window on the densest model is 2.26, so counting a
 * summed context at 2.0 overstates it by at least 13% and typically by 22%
 * (Anthropic) to 42% (DeepSeek). This is the 5th percentile of the densest
 * model's window aggregate, rounded down.
 */
export const TOOL_RESULT_AGGREGATE_CHARS_PER_TOKEN_ESTIMATE = 2.3;

/**
 * Factor that converts tool-result characters into the char budget used for
 * whole-context accounting, which downstream divides by
 * {@link CHARS_PER_TOKEN_ESTIMATE} to reach tokens.
 */
export const TOOL_RESULT_CONTEXT_CHAR_WEIGHT =
  CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_AGGREGATE_CHARS_PER_TOKEN_ESTIMATE;

const IMAGE_CHAR_ESTIMATE = 8_000;

export type MessageCharEstimateCache = WeakMap<AgentMessage, number>;

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    } else {
      chars += estimateUnknownChars(block);
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    // `details` is stripped before provider conversion; estimate only visible content.
    const content = getToolResultContent(msg);
    const chars = estimateContentBlockChars(content);
    // Whole-context accounting: weight by the measured AGGREGATE ratio, not by
    // the per-result 5th percentile. See the constants above.
    const weightedChars = Math.ceil(chars * TOOL_RESULT_CONTEXT_CHAR_WEIGHT);
    return Math.max(chars, weightedChars);
  }

  return 256;
}

export function createMessageCharEstimateCache(): MessageCharEstimateCache {
  return new WeakMap<AgentMessage, number>();
}

export function estimateMessageCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageChars(msg);
  cache.set(msg, estimated);
  return estimated;
}

export function estimateContextChars(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}

export function invalidateMessageCharsCacheEntry(
  cache: MessageCharEstimateCache,
  msg: AgentMessage,
): void {
  cache.delete(msg);
}
