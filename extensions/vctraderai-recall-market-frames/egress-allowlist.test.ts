import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecallMarketFrames } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
  VCTRADERAI_BFF_WORKSPACE_ENVS,
  VCTRADERAI_BFF_WORKSPACE_HEADER,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-recall-market-frames egress allowlist", () => {
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

  // The auth cluster is chosen by PATH SHAPE. `/api/v1/workspaces/{ws}/*` is the
  // per-workspace-owner cluster (PFM_AGENT_TOKEN); `/api/v1/openclaw/*` is the
  // shared-gateway cluster. web_api/market_frames/router.py says this outright,
  // and copying a sibling from the wrong cluster is a 401 that reads like an
  // outage.
  it("reads the headless-user owner token env, not the gateway token", () => {
    expect(VCTRADERAI_BFF_TOKEN_ENV).toBe("PFM_AGENT_TOKEN");
  });

  it("pins the workspace header name and its server-order env sources", () => {
    expect(VCTRADERAI_BFF_WORKSPACE_HEADER).toBe("x-openclaw-workspace");
    expect(VCTRADERAI_BFF_WORKSPACE_ENVS).toEqual(["PFM_AGENT_WORKSPACE_ID", "PFM_WORKSPACE_ID"]);
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runRecallMarketFrames(
      { symbol: "EURUSD", anchor_tf: "h1" },
      { fetchImpl, turnRef: "call-1" },
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("hits the market-frames recall route on the owning workspace", async () => {
    let seen = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runRecallMarketFrames(
      { symbol: "EURUSD", anchor_tf: "h1" },
      { fetchImpl, turnRef: "call-1" },
    );
    expect(new URL(seen).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/market-frames/recall`);
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

  it("rejects traversal out of the workspace prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch(`/api/v1/workspaces/${WORKSPACE_ID}/../../openclaw/data/ohlcv/tail`),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
