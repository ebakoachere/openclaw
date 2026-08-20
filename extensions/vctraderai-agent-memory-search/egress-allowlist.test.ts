import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentMemorySearch } from "./index.js";
import {
  BffEgressViolation,
  buildQueryString,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
  VCTRADERAI_BFF_WORKSPACE_ENVS,
  VCTRADERAI_BFF_WORKSPACE_HEADER,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-agent-memory-search egress allowlist", () => {
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
  // shared-gateway cluster. Copying a sibling from the wrong one is a 401 that
  // reads like an outage.
  it("reads the headless-user owner token env, not the gateway token", () => {
    expect(VCTRADERAI_BFF_TOKEN_ENV).toBe("PFM_AGENT_TOKEN");
  });

  it("pins the workspace header name and its server-order env sources", () => {
    expect(VCTRADERAI_BFF_WORKSPACE_HEADER).toBe("x-openclaw-workspace");
    expect(VCTRADERAI_BFF_WORKSPACE_ENVS).toEqual(["PFM_AGENT_WORKSPACE_ID", "PFM_WORKSPACE_ID"]);
  });

  it("serialises an array query value as a repeated key, never comma-joined", () => {
    expect(buildQueryString({ node_type: ["finding", "failure"] })).toBe(
      "?node_type=finding&node_type=failure",
    );
    expect(buildQueryString({ node_type: [] })).toBe("");
    expect(buildQueryString({ node_type: ["finding", ""] })).toBe("?node_type=finding");
    expect(buildQueryString({ query: "a b" })).toBe("?query=a+b");
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runAgentMemorySearch({ query: "slippage", node_type: ["finding"] }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
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
