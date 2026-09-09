import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRenderCard } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-render-card egress allowlist", () => {
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

  it("reads the headless-user owner token env, not the gateway token", () => {
    expect(VCTRADERAI_BFF_TOKEN_ENV).toBe("PFM_AGENT_TOKEN");
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(
        JSON.stringify({ data: { ok: true, kind: "chart", confirmation: "ok" } }),
        {
          status: 200,
        },
      );
    }) as typeof globalThis.fetch;
    await runRenderCard({ kind: "chart", params: { symbol: "EUR_USD" } }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("sends the params as a JSON body, not as a query string", async () => {
    // render_card is the first vctraderai tool that POSTs: its params are a
    // nested object (indicators, annotations) that cannot ride in a query.
    // A silent fallback to a query string would truncate the intent and the
    // card would be composed from less than the agent asked for.
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(
        JSON.stringify({ data: { ok: true, kind: "chart", confirmation: "ok" } }),
        {
          status: 200,
        },
      );
    }) as typeof globalThis.fetch;
    await runRenderCard(
      {
        kind: "chart",
        params: { symbol: "EUR_USD", annotations: [{ kind: "session", session: "london" }] },
      },
      { fetchImpl },
    );
    expect(seen?.method).toBe("POST");
    expect(typeof seen?.body).toBe("string");
    const body = JSON.parse(String(seen?.body));
    expect(body.kind).toBe("chart");
    expect(body.params.annotations[0].session).toBe("london");
    const headers = seen?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/internal/admin/secrets")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the openclaw data/catalogue surfaces (wrong auth cluster)", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/data/ohlcv/tail")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to run without a workspace id rather than calling an unscoped path", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    const fetchImpl = vi.fn();
    await expect(
      runRenderCard(
        { kind: "chart" },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow("PFM_WORKSPACE_ID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
