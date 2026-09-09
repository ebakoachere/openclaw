import { describe, expect, it, vi } from "vitest";
import {
  RENDER_CARD_KINDS,
  RENDER_CARD_TOOL_NAME,
  runRenderCard,
  summariseCardResult,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function withWorkspace<T>(fn: () => T): T {
  const original = process.env.PFM_WORKSPACE_ID;
  process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = original;
  }
}

describe("render_card returns ONE LINE, never the card", () => {
  // THE CONTRACT THIS FILE EXISTS FOR. A tool result is replayed into the
  // model's context on every later turn of the thread, exactly like the model's
  // own text. Returning the composed card here would put the whole payload back
  // into the conversation and undo the only reason this tool exists. A future
  // editor "helpfully" returning the envelope must fail here, loudly.

  it("collapses a successful compose to a single short line", async () => {
    const bffFetch = vi.fn().mockResolvedValue({
      data: { ok: true, kind: "chart", confirmation: "chart rendered: EUR_USD 1h, 180 bars" },
    });
    const result = await withWorkspace(() =>
      runRenderCard({ kind: "chart", params: { symbol: "EUR_USD" } }, { bffFetch }),
    );
    expect(typeof result).toBe("string");
    expect(result).toBe("chart rendered: EUR_USD 1h, 180 bars");
    expect(result).not.toContain("\n");
    expect(result.length).toBeLessThan(200);
  });

  it("never leaks the artifact even if the BFF sends one", async () => {
    // Defence in depth: the route is specified to return only
    // {ok, kind, confirmation}. If a later change starts including the card,
    // this tool still must not hand it to the model.
    const bffFetch = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        kind: "chart",
        confirmation: "chart rendered: EUR_USD 1h, 180 bars",
        artifact: { type: "chart", spec: { series: [{ t: "x", o: 1, h: 2, l: 0, c: 1 }] } },
      },
    });
    const result = await withWorkspace(() => runRenderCard({ kind: "chart" }, { bffFetch }));
    expect(result).toBe("chart rendered: EUR_USD 1h, 180 bars");
    expect(result).not.toContain("series");
    expect(result).not.toContain("spec");
  });

  it("turns a refusal into the reason, so the model can say why there is no card", async () => {
    const bffFetch = vi.fn().mockResolvedValue({
      data: { ok: false, reason: "no price data for XAU_USD 1d: window_outside_coverage" },
    });
    const result = await withWorkspace(() => runRenderCard({ kind: "chart" }, { bffFetch }));
    expect(result).toBe("No card: no price data for XAU_USD 1d: window_outside_coverage");
    expect(result).not.toContain("\n");
  });

  it("does not claim a card when the platform answered with nothing", async () => {
    for (const payload of [null, undefined, "", 42]) {
      const bffFetch = vi.fn().mockResolvedValue(payload);
      const result = await withWorkspace(() => runRenderCard({ kind: "chart" }, { bffFetch }));
      expect(result).toContain("no answer");
      expect(result).not.toContain("rendered");
    }
  });

  it("does not claim a card when a refusal carried no reason", async () => {
    const bffFetch = vi.fn().mockResolvedValue({ data: { ok: false } });
    const result = await withWorkspace(() => runRenderCard({ kind: "chart" }, { bffFetch }));
    expect(result).toContain("no reason");
    expect(result).not.toContain("rendered");
  });

  it("summariseCardResult is total: every shape yields one line", () => {
    const shapes: unknown[] = [
      null,
      undefined,
      {},
      { data: {} },
      { ok: true },
      { data: { ok: true, kind: "alerts" } },
      { data: { ok: false, reason: "r" } },
      [1, 2, 3],
    ];
    for (const shape of shapes) {
      const line = summariseCardResult(shape);
      expect(typeof line).toBe("string");
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain("\n");
    }
  });
});

describe("the kind vocabulary", () => {
  it("POSTs to the compose route with the kind and params", async () => {
    const bffFetch = vi
      .fn()
      .mockResolvedValue({ data: { ok: true, kind: "chart", confirmation: "ok" } });
    await withWorkspace(() =>
      runRenderCard(
        { kind: "chart", params: { symbol: "EUR_USD", timeframe: "1h" } },
        { bffFetch },
      ),
    );
    expect(bffFetch).toHaveBeenCalledTimes(1);
    const [path, options] = bffFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/agent/cards/compose`);
    expect(options.method).toBe("POST");
    expect(options.body).toEqual({ kind: "chart", params: { symbol: "EUR_USD", timeframe: "1h" } });
  });

  it("pins the kinds by NAME against propfirm_manager's artifact_schema._TYPES", () => {
    // The source of truth is web_api/agent_alpha/artifact_schema.py::_TYPES in
    // the OTHER repository, so this list cannot be imported. Pinning it here is
    // what makes a drift loud on THIS side; the propfirm_manager side pins its
    // own half. If the two ever disagree, the model is offered a kind the
    // platform cannot compose (or denied one it can) and the only symptom is a
    // refusal the user never understands.
    expect([...RENDER_CARD_KINDS]).toEqual([
      "account",
      "alerts",
      "backtest",
      "change_summary",
      "chart",
      "comparison",
      "data",
      "decision",
      "digest",
      "econ",
      "news",
      "notebook_output",
      "order_ticket",
      "positions",
      "post_trade",
      "risk",
      "signal",
      "subagent",
      "watchlist",
    ]);
  });

  it("excludes `approval` deliberately, because the agent must never emit one", () => {
    // The platform renders the governed approval card from the staged action
    // itself. Offering the kind here would invite a call that can only be
    // refused, and a second unauthoritative copy of a governed object is
    // exactly what the persona forbids.
    expect(RENDER_CARD_KINDS).not.toContain("approval");
    // …and the list is otherwise the full twenty.
    expect(RENDER_CARD_KINDS.length).toBe(19);
  });

  it("is named render_card", () => {
    expect(RENDER_CARD_TOOL_NAME).toBe("render_card");
  });
});
