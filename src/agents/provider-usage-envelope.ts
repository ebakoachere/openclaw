import { normalizeUsage, type UsageLike } from "./usage.js";

/**
 * Versioned terminal metering contract consumed by Agent Alpha's BFF.
 *
 * Keep provider responses under `raw` until after this mapping.  The generic
 * NormalizedUsage type is useful for displays, but it deliberately collapses
 * provider cache components and cannot be the billing source of truth.
 */
export type ProviderUsageEnvelopeV2 = {
  version: 2;
  provider: string;
  model: string;
  executionTier: "standard";
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  providerRequestId?: string;
  raw: Record<string, unknown>;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function tokens(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.trunc(parsed), Number.MAX_SAFE_INTEGER)
    : 0;
}

function firstToken(...values: unknown[]): number {
  for (const value of values) {
    const parsed = tokens(value);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Map the raw terminal provider response without dropping cache detail. */
export function buildProviderUsageEnvelopeV2(params: {
  provider?: string;
  model?: string;
  usage?: unknown;
}): ProviderUsageEnvelopeV2 | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  const usage = record(params.usage);
  if (!provider || !model || !usage) {
    return undefined;
  }

  // Direct transports retain their provider payload under providerRaw before
  // producing the generic Usage projection.  Older/third-party transports
  // still arrive as their own best available record and are marked as such in
  // `raw` rather than being invented from character counts.
  const raw = record(usage.providerRaw) ?? usage;

  const normalized = normalizeUsage(usage as UsageLike);
  const inputDetails = record(raw.input_tokens_details) ?? record(raw.inputTokensDetails);
  const promptDetails = record(raw.prompt_tokens_details) ?? record(raw.promptTokensDetails);
  const completionDetails =
    record(raw.completion_tokens_details) ?? record(raw.completionTokensDetails);
  const outputDetails = record(raw.output_tokens_details) ?? record(raw.outputTokensDetails);

  // Anthropic returns one aggregate creation count by default.  The fork tags
  // configured 5m and 1h breakpoints separately when available; unlabelled
  // Anthropic creation is deliberately classified as the configured 5m
  // default rather than silently lost.
  const cacheWrite5mTokens = firstToken(
    raw.cache_creation_input_tokens_5m,
    raw.cache_creation_5m_input_tokens,
    raw.cacheCreation5mInputTokens,
  );
  const cacheWrite1hTokens = firstToken(
    raw.cache_creation_input_tokens_1h,
    raw.cache_creation_1h_input_tokens,
    raw.cacheCreation1hInputTokens,
  );
  const genericCacheWrite = firstToken(
    raw.cache_write_tokens,
    raw.cacheWriteTokens,
    raw.cache_write,
    raw.cacheWrite,
  );
  const unlabelledAnthropicWrite =
    provider === "anthropic" && cacheWrite5mTokens === 0 && cacheWrite1hTokens === 0
      ? firstToken(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens)
      : 0;

  const cacheReadTokens = firstToken(
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
    raw.prompt_cache_hit_tokens,
    raw.promptCacheHitTokens,
    raw.cached_content_token_count,
    raw.cachedContentTokenCount,
    raw.cached_tokens,
    inputDetails?.cached_tokens,
    promptDetails?.cached_tokens,
    normalized?.cacheRead,
  );
  const uncachedInputTokens = firstToken(
    raw.prompt_cache_miss_tokens,
    raw.promptCacheMissTokens,
    normalized?.input,
    raw.prompt_token_count,
    raw.promptTokenCount,
  );
  const outputTokens = firstToken(
    normalized?.output,
    raw.candidates_token_count,
    raw.candidatesTokenCount,
  );
  const reasoningTokens = firstToken(
    normalized?.reasoningTokens,
    raw.thoughts_token_count,
    raw.thoughtsTokenCount,
    completionDetails?.reasoning_tokens,
    outputDetails?.reasoning_tokens,
  );

  if (
    uncachedInputTokens +
      cacheReadTokens +
      genericCacheWrite +
      unlabelledAnthropicWrite +
      cacheWrite5mTokens +
      cacheWrite1hTokens +
      outputTokens +
      reasoningTokens ===
    0
  ) {
    return undefined;
  }

  return {
    version: 2,
    provider,
    model,
    executionTier: "standard",
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens: genericCacheWrite,
    cacheWrite5mTokens: cacheWrite5mTokens + unlabelledAnthropicWrite,
    cacheWrite1hTokens,
    outputTokens,
    reasoningTokens,
    ...(stringValue(usage.providerRequestId, raw.request_id, raw.requestId, raw.id)
      ? {
          providerRequestId: stringValue(
            usage.providerRequestId,
            raw.request_id,
            raw.requestId,
            raw.id,
          ),
        }
      : {}),
    raw: { ...raw },
  };
}

/**
 * One browser turn may contain several model calls around tools.  A parent
 * ledger row must represent their complete cost, not merely the last assistant
 * message. Aggregate only identical provider/model calls; crossing providers
 * is deliberately rejected because one row cannot truthfully price a mixed
 * route with one pricing card.
 */
export function aggregateProviderUsageEnvelopeV2(params: {
  provider?: string;
  model?: string;
  usages: unknown[];
}): ProviderUsageEnvelopeV2 | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model || params.usages.length === 0) {
    return undefined;
  }
  const calls = params.usages.map((snapshot) => {
    const record =
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? (snapshot as UnknownRecord)
        : undefined;
    const callProvider = stringValue(record?.provider) ?? provider;
    const callModel = stringValue(record?.model) ?? model;
    if (callProvider !== provider || callModel !== model) {
      return undefined;
    }
    return buildProviderUsageEnvelopeV2({
      provider: callProvider,
      model: callModel,
      usage: record?.usage ?? snapshot,
    });
  });
  if (calls.some((call) => !call)) {
    return undefined;
  }
  const verifiedCalls = calls as ProviderUsageEnvelopeV2[];
  if (verifiedCalls.length === 1) {
    return verifiedCalls[0];
  }
  const sum = (
    key: keyof Pick<
      ProviderUsageEnvelopeV2,
      | "uncachedInputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "cacheWrite5mTokens"
      | "cacheWrite1hTokens"
      | "outputTokens"
      | "reasoningTokens"
    >,
  ) => verifiedCalls.reduce((total, call) => total + call[key], 0);
  return {
    version: 2,
    provider,
    model,
    executionTier: "standard",
    uncachedInputTokens: sum("uncachedInputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    cacheWrite5mTokens: sum("cacheWrite5mTokens"),
    cacheWrite1hTokens: sum("cacheWrite1hTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    raw: { calls: verifiedCalls.map((call) => call.raw) },
  };
}
