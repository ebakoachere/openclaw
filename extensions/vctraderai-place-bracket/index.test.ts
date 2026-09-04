import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { PLACE_BRACKET_TOOL_NAME, runPlaceBracket } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-place-bracket", () => {
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
    expect(PLACE_BRACKET_TOOL_NAME).toBe("place_bracket");
  });

  it("refuses to run without a bound workspace, rather than calling a wrong one", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runPlaceBracket(
        {
          account_id: "acct-1",
          symbol: "EURUSD",
          side: "BUY",
          qty: "0.01",
          stop_loss: "1.0950",
          take_profit: "1.1100",
          intended_price: "1.1000",
        },
        { bffFetch: async () => ({}) },
      ),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
  });

  it("issues POST against the workspace-scoped path", async () => {
    const seen: { path?: string; method?: string } = {};
    await runPlaceBracket(
      {
        account_id: "acct-1",
        symbol: "EURUSD",
        side: "BUY",
        qty: "0.01",
        stop_loss: "1.0950",
        take_profit: "1.1100",
        intended_price: "1.1000",
      },
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
    await runPlaceBracket(
      {
        account_id: "acct-1",
        symbol: "EURUSD",
        side: "BUY",
        qty: "0.01",
        stop_loss: "1.0950",
        take_profit: "1.1100",
        intended_price: "1.1000",
      },
      {
        bffFetch: async (_path, options) => {
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    for (const key of [
      "account_id",
      "symbol",
      "side",
      "qty",
      "stop_loss",
      "take_profit",
      "intended_price",
    ]) {
      expect(Object.keys(body)).toContain(key);
      expect(body[key]).not.toBeUndefined();
    }
  });

  it("returns the BFF response VERBATIM rather than a projection", async () => {
    // A projection here is how a field the model needs -- idempotency_key,
    // lock_reason, curve lineage -- disappears between the route and the turn.
    const payload = { data: { anything: 1 }, execution_status: "downgraded", extra: [1, 2] };
    const out = await runPlaceBracket(
      {
        account_id: "acct-1",
        symbol: "EURUSD",
        side: "BUY",
        qty: "0.01",
        stop_loss: "1.0950",
        take_profit: "1.1100",
        intended_price: "1.1000",
      },
      { bffFetch: async () => payload },
    );
    expect(out).toEqual(payload);
  });

  it("REGISTERS the tool with the plugin api, under the contract name", () => {
    // Registration is the claim, not the object shape: a plugin whose
    // module loads but never registers is dark in exactly the way a
    // missing bake is, and looks identical from the outside.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-place-bracket" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: PLACE_BRACKET_TOOL_NAME,
      label: "Place Bracket",
    });
  });

  // W15 LANE QTY. Omitting qty is how the caller asks the platform to size the
  // bracket from the account's Risk Settings page. The boundary refuses a body
  // that carries both an explicit qty and a risk-budget request, so an absent
  // qty must leave the key OFF the body -- not send a null, and not invent a
  // `size` field alongside it.
  it("OMITS qty entirely when it is not supplied, so the platform sizes from the account's risk budget", async () => {
    let body: Record<string, unknown> = {};
    await runPlaceBracket(
      {
        account_id: "acct-1",
        symbol: "EURUSD",
        side: "BUY",
        stop_loss: "1.0950",
        take_profit: "1.1100",
        intended_price: "1.1000",
      },
      {
        bffFetch: async (_path, options) => {
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    expect(Object.keys(body)).not.toContain("qty");
    expect(Object.keys(body)).not.toContain("size");
    // Controls: every OTHER mandatory field is still on the wire, so a body
    // that silently lost its contents cannot pass this test.
    for (const key of [
      "account_id",
      "symbol",
      "side",
      "stop_loss",
      "take_profit",
      "intended_price",
    ]) {
      expect(Object.keys(body)).toContain(key);
      expect(body[key]).not.toBeUndefined();
    }
  });

  it("still forwards qty untouched when the caller supplies one", async () => {
    let body: Record<string, unknown> = {};
    await runPlaceBracket(
      {
        account_id: "acct-1",
        symbol: "EURUSD",
        side: "BUY",
        qty: "0.01",
        stop_loss: "1.0950",
        take_profit: "1.1100",
        intended_price: "1.1000",
      },
      {
        bffFetch: async (_path, options) => {
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    expect(body.qty).toBe("0.01");
  });

  it("declares qty OPTIONAL in the tool schema, with the mandatory fields still required", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-place-bracket" });
    plugin.register(captured.api);
    const schema: any = (captured.tools[0] as any).parameters;
    const required: string[] = schema?.required ?? [];
    expect(required).toContain("account_id");
    expect(required).toContain("stop_loss");
    expect(required).toContain("take_profit");
    expect(required).not.toContain("qty");
    expect(schema?.properties?.qty).toBeDefined();
  });
});
