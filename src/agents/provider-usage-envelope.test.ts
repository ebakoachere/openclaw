import { describe, expect, it } from "vitest";
import {
  aggregateProviderUsageEnvelopeV2,
  buildProviderUsageEnvelopeV2,
} from "./provider-usage-envelope.js";

describe("buildProviderUsageEnvelopeV2", () => {
  it("retains Anthropic's 5m and 1h cache creations separately", () => {
    expect(
      buildProviderUsageEnvelopeV2({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens_5m: 40,
          cache_creation_input_tokens_1h: 20,
          output_tokens: 30,
          request_id: "req_anthropic",
        },
      }),
    ).toMatchObject({
      version: 2,
      uncachedInputTokens: 200,
      cacheReadTokens: 100,
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 20,
      outputTokens: 30,
      providerRequestId: "req_anthropic",
    });
  });

  it("uses transport-retained provider raw usage rather than collapsed display totals", () => {
    expect(
      buildProviderUsageEnvelopeV2({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input: 200,
          output: 30,
          cacheRead: 100,
          cacheWrite: 60,
          providerRequestId: "msg_1",
          providerRaw: {
            input_tokens: 200,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens_5m: 40,
            cache_creation_input_tokens_1h: 20,
            output_tokens: 30,
          },
        },
      }),
    ).toMatchObject({
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 20,
      providerRequestId: "msg_1",
      raw: { cache_creation_input_tokens_5m: 40, cache_creation_input_tokens_1h: 20 },
    });
  });

  it.each([
    [
      "openai",
      "gpt-5.6-luna",
      {
        input_tokens: 120,
        output_tokens: 15,
        input_tokens_details: { cached_tokens: 80 },
        cache_write_tokens: 10,
      },
      { uncachedInputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 10 },
    ],
    [
      "google",
      "gemini-2.5-flash",
      {
        promptTokenCount: 150,
        cachedContentTokenCount: 60,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 7,
      },
      { uncachedInputTokens: 150, cacheReadTokens: 60, outputTokens: 20, reasoningTokens: 7 },
    ],
    [
      "deepseek",
      "deepseek-v4-flash",
      {
        prompt_cache_miss_tokens: 200,
        prompt_cache_hit_tokens: 140,
        output_tokens: 12,
        reasoning_tokens: 3,
      },
      { uncachedInputTokens: 200, cacheReadTokens: 140, outputTokens: 12, reasoningTokens: 3 },
    ],
  ])(
    "maps %s raw usage without collapsing cache components",
    (provider, model, usage, expected) => {
      expect(buildProviderUsageEnvelopeV2({ provider, model, usage })).toMatchObject(expected);
    },
  );

  it("fails closed when the provider did not report any billable components", () => {
    expect(
      buildProviderUsageEnvelopeV2({ provider: "openai", model: "gpt-5.6-luna", usage: {} }),
    ).toBeUndefined();
  });

  it("aggregates all same-route calls around tools into one browser parent", () => {
    expect(
      aggregateProviderUsageEnvelopeV2({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usages: [
          {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            usage: { prompt_cache_miss_tokens: 100, output_tokens: 10 },
          },
          {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            usage: {
              prompt_cache_miss_tokens: 200,
              prompt_cache_hit_tokens: 50,
              output_tokens: 20,
            },
          },
        ],
      }),
    ).toMatchObject({
      uncachedInputTokens: 300,
      cacheReadTokens: 50,
      outputTokens: 30,
      raw: { calls: [{ prompt_cache_miss_tokens: 100 }, { prompt_cache_miss_tokens: 200 }] },
    });
  });

  it("fails closed rather than price a mixed-provider turn with one card", () => {
    expect(
      aggregateProviderUsageEnvelopeV2({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usages: [
          {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            usage: { prompt_cache_miss_tokens: 100, output_tokens: 10 },
          },
          {
            provider: "google",
            model: "gemini-2.5-flash",
            usage: { promptTokenCount: 100, candidatesTokenCount: 10 },
          },
        ],
      }),
    ).toBeUndefined();
  });
});
