import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ChatSendParamsSchema } from "./logs-chat.js";

const baseParams = {
  sessionKey: "agent:main:main",
  message: "place the order",
  idempotencyKey: "chat-send-thread-scope-test",
};

describe("ChatSendParamsSchema", () => {
  it("accepts an optional canonical lowercase application thread id", () => {
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...baseParams,
        threadId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toBe(true);
  });

  it("keeps threadId optional and rejects noncanonical values when supplied", () => {
    expect(Value.Check(ChatSendParamsSchema, baseParams)).toBe(true);
    expect(
      Value.Check(ChatSendParamsSchema, {
        ...baseParams,
        threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".toUpperCase(),
      }),
    ).toBe(false);
    expect(Value.Check(ChatSendParamsSchema, { ...baseParams, threadId: "main" })).toBe(false);
    expect(Value.Check(ChatSendParamsSchema, { ...baseParams, threadId: null })).toBe(false);
  });
});
