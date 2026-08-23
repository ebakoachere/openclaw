import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { CLOSE_POSITION_PARTIAL_TOOL_NAME, runClosePositionPartial } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-close-position-partial", () => {
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

  it("declares the tool name the allowlist and the persona use", () => {
    expect(CLOSE_POSITION_PARTIAL_TOOL_NAME).toBe("close_position_partial");
  });

  it("refuses to run without a bound workspace, rather than calling a wrong one", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runClosePositionPartial(
        { account_id: "acct-1", position_id: "pos-9", volume: "0.05" },
        { bffFetch: async () => ({}) },
      ),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
  });

  it("issues POST against the workspace-scoped path", async () => {
    const seen: { path?: string; method?: string } = {};
    await runClosePositionPartial(
      { account_id: "acct-1", position_id: "pos-9", volume: "0.05" },
      {
        bffFetch: async (path, options) => {
          seen.path = path;
          seen.method = options?.method;
          return { ok: true };
        },
      },
    );
    expect(seen.method).toBe("POST");
    expect(seen.path).toContain(`/api/v1/workspaces/${WORKSPACE_ID}/`);
  });

  it("puts EVERY required field on the wire body", async () => {
    // A field dropped between the schema and the body is invisible to a
    // shape test: the call still succeeds locally and the BFF rejects it
    // with a 422 the model cannot act on. Measured: dropping take_profit
    // from the bracket body SURVIVED until this assertion existed.
    let body: Record<string, unknown> = {};
    await runClosePositionPartial(
      { account_id: "acct-1", position_id: "pos-9", volume: "0.05" },
      {
        bffFetch: async (_path, options) => {
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    for (const key of ["account_id", "volume"]) {
      expect(Object.keys(body)).toContain(key);
      expect(body[key]).not.toBeUndefined();
    }
  });

  it("returns the BFF response VERBATIM rather than a projection", async () => {
    // A projection here is how a field the model needs -- idempotency_key,
    // lock_reason, curve lineage -- disappears between the route and the turn.
    const payload = { data: { anything: 1 }, execution_status: "downgraded", extra: [1, 2] };
    const out = await runClosePositionPartial(
      { account_id: "acct-1", position_id: "pos-9", volume: "0.05" },
      { bffFetch: async () => payload },
    );
    expect(out).toEqual(payload);
  });

  it("REGISTERS the tool with the plugin api, under the contract name", () => {
    // Registration is the claim, not the object shape: a plugin whose
    // module loads but never registers is dark in exactly the way a
    // missing bake is, and looks identical from the outside.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-close-position-partial" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CLOSE_POSITION_PARTIAL_TOOL_NAME,
      label: "Close Position Partial",
    });
  });
});
