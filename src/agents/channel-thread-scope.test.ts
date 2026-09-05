import { describe, expect, it } from "vitest";
import { resolveChannelTurnThreadScope } from "./channel-thread-scope.js";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("resolveChannelTurnThreadScope", () => {
  it("mints a UUID-shaped scope for a user-originated channel turn", () => {
    // A Telegram turn on the shared main session: no chat.send.threadId, no
    // session-key marker. It used to reach the tool context unscoped and every
    // execute-class tool was refused 403.
    const scope = resolveChannelTurnThreadScope({
      messageProvider: "telegram",
      sessionKey: "agent:main:main",
    });
    expect(scope).toMatch(UUID_V5);
  });

  it("returns undefined for a turn that arrived on NO channel", () => {
    // The heartbeat wake-classifier. Fail-closed is the correct answer, and it
    // is the whole reason the BFF guard exists.
    expect(resolveChannelTurnThreadScope({ sessionKey: "agent:main:main" })).toBeUndefined();
    expect(
      resolveChannelTurnThreadScope({
        messageProvider: "",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a provider that is not a deliverable channel", () => {
    // A human cannot message an internal channel, so a turn on one is not
    // user-originated whatever else it looks like.
    expect(
      resolveChannelTurnThreadScope({
        messageProvider: "not-a-real-channel",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it("never second-guesses an authenticated per-turn scope", () => {
    const explicit = "f15b740e-3a90-5473-8d72-a9e8cd71ae53";
    expect(
      resolveChannelTurnThreadScope({
        threadId: explicit,
        messageProvider: "telegram",
        sessionKey: "agent:main:main",
      }),
    ).toBe(explicit);
    // Even with no channel at all -- the web path.
    expect(resolveChannelTurnThreadScope({ threadId: explicit })).toBe(explicit);
  });

  it("is stable per conversation and distinct across conversations", () => {
    const a = resolveChannelTurnThreadScope({
      messageProvider: "telegram",
      sessionKey: "agent:main:main",
    });
    const again = resolveChannelTurnThreadScope({
      messageProvider: "telegram",
      sessionKey: "agent:main:main",
    });
    const otherChannel = resolveChannelTurnThreadScope({
      messageProvider: "discord",
      sessionKey: "agent:main:main",
    });
    const otherSession = resolveChannelTurnThreadScope({
      messageProvider: "telegram",
      sessionKey: "agent:main:someone-else",
    });

    expect(again).toBe(a);
    expect(otherChannel).not.toBe(a);
    expect(otherSession).not.toBe(a);
  });

  it("refuses to mint without a session key", () => {
    // A channel turn with no session has no stable conversation to bind to.
    // Minting per turn would make every message its own thread.
    expect(resolveChannelTurnThreadScope({ messageProvider: "telegram" })).toBeUndefined();
    expect(
      resolveChannelTurnThreadScope({ messageProvider: "telegram", sessionKey: "  " }),
    ).toBeUndefined();
  });

  it("never emits a channel chat or topic id", () => {
    // THE THIRD TWO-VOCABULARIES TRAP. The channel plugins' own `threadId` is a
    // Telegram topic / Discord thread id; the BFF's is an application thread
    // UUID. A chat id must never end up in X-OpenClaw-Thread.
    const chatId = "123456789";
    const scope = resolveChannelTurnThreadScope({
      messageProvider: "telegram",
      sessionKey: `agent:main:telegram:${chatId}`,
    });
    expect(scope).toMatch(UUID_V5);
    expect(scope).not.toContain(chatId);
  });
});
