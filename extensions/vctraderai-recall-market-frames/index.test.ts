import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { RECALL_MARKET_FRAMES_TOOL_NAME, runRecallMarketFrames } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

/** Capture the query the plugin actually sent, with a canned 200 body. */
function captureFetch(body: unknown = {}) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(new URL(href));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

/**
 * The single tool this plugin registers, as the plugin API actually receives it.
 *
 * Registration is driven through the SDK's own capture runtime rather than by
 * calling the `tools` factory directly: the factory is an authoring shape, and
 * reading it would assert what the author WROTE instead of what the gateway is
 * GIVEN. Those are the two things this whole lane exists to keep apart.
 */
function theTool() {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-recall-market-frames" });
  plugin.register(captured.api);
  expect(captured.tools).toHaveLength(1);
  return captured.tools[0] as unknown as {
    name: string;
    label: string;
    description: string;
    parameters: { properties?: Record<string, unknown>; required?: string[] };
  };
}

describe("vctraderai-recall-market-frames", () => {
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

  // The closed-world gate matches an admitted tool by LOWERCASED STRING against
  // the allowlist snapshot; it does not derive a name from the directory id. A
  // rename here is silently un-admitted, so the exact string is pinned.
  it("registers the tool under the exact allowlisted name", () => {
    expect(RECALL_MARKET_FRAMES_TOOL_NAME).toBe("recall_market_frames");
    expect(theTool().name).toBe("recall_market_frames");
  });

  it("asks for symbol and anchor_tf and nothing else required", () => {
    const params = theTool().parameters;
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(["anchor_tf", "limit", "symbol"]);
    expect((params.required ?? []).sort()).toEqual(["anchor_tf", "symbol"]);
  });

  // Both omissions are deliberate and both are load-bearing. `turn_ref` keys the
  // shadow row that every gate in the pass/fail bar is a ratio over, and
  // `as_of` is the lookahead boundary. A model that supplies either can corrupt
  // a measurement without ever producing an error.
  it("does not offer turn_ref or as_of to the model", () => {
    const properties = theTool().parameters.properties ?? {};
    expect(properties).not.toHaveProperty("turn_ref");
    expect(properties).not.toHaveProperty("as_of");
  });

  // Mirrors SUPPORTED_TIMEFRAMES in core/openclaw/market_frames.py. anchor_tf is
  // part of frame identity and cohorts never mix anchors, so a value outside
  // this set is a refused read, not a wider search.
  it("pins the anchor timeframe vocabulary to the encoder's own", () => {
    const anchor = theTool().parameters.properties?.anchor_tf as {
      anyOf?: { const?: string }[];
    };
    const values = (anchor.anyOf ?? []).map((entry) => entry.const);
    expect(values).toEqual(["m1", "m5", "m15", "h1", "h4", "d1", "w1"]);
  });

  it("sends the runtime turn identity as turn_ref, not anything model-supplied", async () => {
    const { calls, fetchImpl } = captureFetch();
    await runRecallMarketFrames(
      { symbol: "EURUSD", anchor_tf: "h1" },
      { fetchImpl, turnRef: "toolcall-abc" },
    );
    expect(calls[0].searchParams.get("turn_ref")).toBe("toolcall-abc");
    expect(calls[0].searchParams.get("symbol")).toBe("EURUSD");
    expect(calls[0].searchParams.get("anchor_tf")).toBe("h1");
  });

  // Sending an empty required param would 422 at the BFF, and a 422 reads to the
  // model like a broken backend rather than a missing runtime identity. Refusing
  // here also means no shadow row is written against an unknown turn.
  it("refuses rather than recording a recall against an unknown turn", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(
      runRecallMarketFrames({ symbol: "EURUSD", anchor_tf: "h1" }, { fetchImpl, turnRef: "  " }),
    ).rejects.toThrow(/turn identity/);
    expect(calls).toHaveLength(0);
  });

  it("requires symbol and anchor_tf before opening a socket", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(
      runRecallMarketFrames({ anchor_tf: "h1" }, { fetchImpl, turnRef: "c1" }),
    ).rejects.toThrow(/symbol is required/);
    await expect(
      runRecallMarketFrames({ symbol: "EURUSD" }, { fetchImpl, turnRef: "c1" }),
    ).rejects.toThrow(/anchor_tf is required/);
    expect(calls).toHaveLength(0);
  });

  it("omits limit when unset so the server's own default applies", async () => {
    const { calls, fetchImpl } = captureFetch();
    await runRecallMarketFrames({ symbol: "EURUSD", anchor_tf: "h1" }, { fetchImpl, turnRef: "c" });
    expect(calls[0].searchParams.has("limit")).toBe(false);
    await runRecallMarketFrames(
      { symbol: "EURUSD", anchor_tf: "h1", limit: 5 },
      { fetchImpl, turnRef: "c" },
    );
    expect(calls[1].searchParams.get("limit")).toBe("5");
  });

  // THE POINT OF THE WHOLE ENVELOPE. `ran`, `withheld`, `disposition` and
  // `reason` exist so a refusal cannot be misread as an empty corpus. Any
  // flattening here would re-create exactly the failure the schema prevents, so
  // the response must arrive at the model byte-for-byte as the server sent it.
  it("returns a withheld shadow envelope verbatim, without flattening it", async () => {
    const envelope = {
      data: {
        symbol: "EURUSD",
        anchor_tf: "h1",
        mode: "shadow",
        disposition: "found",
        ran: true,
        withheld: true,
        reason: "shadow mode: frames are recorded but not returned to the model",
        claim: "Frames say how WIDE, never which way.",
        returned: 0,
        considered: 128,
        cohort_distinct_days: 31,
        sufficient: false,
        neighbours: [],
      },
      trace_id: "trace-1",
    };
    const { fetchImpl } = captureFetch(envelope);
    const result = await runRecallMarketFrames(
      { symbol: "EURUSD", anchor_tf: "h1" },
      { fetchImpl, turnRef: "c" },
    );
    expect(result).toEqual(envelope);
  });

  it("refuses when the workspace identity is absent", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const { calls, fetchImpl } = captureFetch();
    await expect(
      runRecallMarketFrames({ symbol: "EURUSD", anchor_tf: "h1" }, { fetchImpl, turnRef: "c" }),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
    expect(calls).toHaveLength(0);
  });
});
