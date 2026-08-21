import { describe, expect, it } from "vitest";
import { isMemoryFlushAllowedToolName } from "./agent-tools.js";

// The memory-flush run is built by filtering the full tool array through this
// predicate, so a name it rejects is a tool the flush CANNOT call however
// firmly the prompt asks for it.
//
// Measured 2026-08-21: the flush system prompt says "call agent_memory_write
// once for each durable fact worth finding again later", and the predicate did
// not admit that name. The memory graph held 0 rows -- the write route had
// never been called once, against a control of 3,249 matching requests in the
// same window -- while the flush's memory FILE landed normally, because `write`
// was admitted and `agent_memory_write` was not.
describe("memory flush tool set", () => {
  it("admits the durable-memory write the flush prompt instructs the agent to call", () => {
    expect(isMemoryFlushAllowedToolName("agent_memory_write")).toBe(true);
  });

  it("still admits the two core tools the flush needs", () => {
    expect(isMemoryFlushAllowedToolName("read")).toBe(true);
    expect(isMemoryFlushAllowedToolName("write")).toBe(true);
  });

  // The negatives are the point of the set existing. A compaction-triggered run
  // is not a turn: it must not be able to trade, message a human, or reach the
  // filesystem outside the memory file. `agent_memory_search` is excluded not
  // because it is dangerous but because a flush WRITES -- widening to "anything
  // memory-shaped" is how a narrow allowlist stops being one.
  it.each([
    "agent_memory_search",
    "agent_place_order",
    "agent_close_position",
    "message",
    "bash",
    "edit",
    "apply_patch",
    "send_notification",
  ])("refuses %s", (toolName) => {
    expect(isMemoryFlushAllowedToolName(toolName)).toBe(false);
  });
});
