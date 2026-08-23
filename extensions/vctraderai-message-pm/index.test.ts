import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { MESSAGE_PM_TOOL_NAME, runMessagePm } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-message-pm", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("REGISTERS the tool with the plugin api, under the contract name", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-message-pm" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: MESSAGE_PM_TOOL_NAME,
      label: "Message PM",
    });
  });

  it("posts to the openclaw messages route with the tool header", async () => {
    let path = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    await runMessagePm(
      { subject: "Vault read empty", body: "Three wakes running." },
      {
        bffFetch: async (p, options) => {
          path = p;
          headers = (options?.headers ?? {}) as Record<string, string>;
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    expect(path).toBe("/api/v1/openclaw/messages/pm");
    expect(headers["X-OpenClaw-Tool"]).toBe("message_pm");
    expect(body).toMatchObject({
      subject: "Vault read empty",
      body: "Three wakes running.",
      workspace_id: WORKSPACE_ID,
    });
  });

  it("carries NO parameter that could ask for a wake", () => {
    // The server pins routing to feed_no_wake and does not read it from the
    // request. A parameter here would be a promise the route cannot keep --
    // the model would set it, see success, and believe the PM was interrupted.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-message-pm" });
    plugin.register(captured.api);
    const schema = JSON.stringify(captured.tools[0]?.parameters ?? {});
    for (const forbidden of ["routing", "wake", "urgency", "feed_and_wake"]) {
      expect(schema).not.toContain(forbidden);
    }
    // Positive control: the schema really is being read, and does carry the
    // fields it is supposed to.
    expect(schema).toContain("subject");
    expect(schema).toContain("body");
  });

  it("allows its own messages path and still rejects a sibling family it must not reach", async () => {
    expect("/api/v1/openclaw/messages/pm").toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/stage", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    await expect(
      bffFetch(`/api/v1/workspaces/${WORKSPACE_ID}/live/orders/agent-place`, {
        method: "POST",
        body: {},
      }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the BFF response VERBATIM rather than a projection", async () => {
    // delivered / woke_pm / thread_id are what tell the model what actually
    // happened. A projection here is how "it did not wake the PM" gets lost.
    const payload = {
      delivered: true,
      routing: "feed_no_wake",
      woke_pm: false,
      thread_id: "t-1",
    };
    const out = await runMessagePm({ subject: "s", body: "b" }, { bffFetch: async () => payload });
    expect(out).toEqual(payload);
  });

  it("refuses to run without a bound workspace, rather than messaging a wrong one", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runMessagePm({ subject: "s", body: "b" }, { bffFetch: async () => ({}) }),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
  });
});
