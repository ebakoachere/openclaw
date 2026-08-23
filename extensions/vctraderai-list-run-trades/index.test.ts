import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { LIST_RUN_TRADES_TOOL_NAME, runListRunTrades } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-run-trades", () => {
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
    expect(LIST_RUN_TRADES_TOOL_NAME).toBe("list_run_trades");
  });

  it("refuses to run without a bound workspace, rather than calling a wrong one", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runListRunTrades({ run_id: "run-1" }, { bffFetch: async () => ({}) }),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
  });

  it("issues GET against the workspace-scoped path", async () => {
    const seen: { path?: string; method?: string } = {};
    await runListRunTrades(
      { run_id: "run-1" },
      {
        bffFetch: async (path, options) => {
          seen.path = path;
          seen.method = options?.method;
          return { ok: true };
        },
      },
    );
    expect(seen.method).toBe("GET");
    expect(seen.path).toContain(`/api/v1/workspaces/${WORKSPACE_ID}/`);
  });

  it("returns the BFF response VERBATIM rather than a projection", async () => {
    // A projection here is how a field the model needs -- idempotency_key,
    // lock_reason, curve lineage -- disappears between the route and the turn.
    const payload = { data: { anything: 1 }, execution_status: "downgraded", extra: [1, 2] };
    const out = await runListRunTrades({ run_id: "run-1" }, { bffFetch: async () => payload });
    expect(out).toEqual(payload);
  });

  it("REGISTERS the tool with the plugin api, under the contract name", () => {
    // Registration is the claim, not the object shape: a plugin whose
    // module loads but never registers is dark in exactly the way a
    // missing bake is, and looks identical from the outside.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-run-trades" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_RUN_TRADES_TOOL_NAME,
      label: "List Run Trades",
    });
  });
});
