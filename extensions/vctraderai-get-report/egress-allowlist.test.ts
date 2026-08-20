import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGetReport } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
  VCTRADERAI_BFF_TOKEN_ENV,
} from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-report egress allowlist", () => {
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

  it("accepts the plugin's own workspace-scoped reports path", () => {
    expect(`/api/v1/workspaces/${WORKSPACE_ID}/reports/rep-1`).toMatch(
      VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
    );
  });

  it("every captured url on the happy path matches the workspace-scoped allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runGetReport({ report_id: "rep-1" }, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects a non-allowlisted internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/admin", { method: "POST", body: {} })).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the openclaw gateway surface (wrong auth cluster)", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/notifications/send", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch(`https://evil.example.com/api/v1/workspaces/${WORKSPACE_ID}/reports`),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a traversal sequence smuggled through the path", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch(`/api/v1/workspaces/${WORKSPACE_ID}/reports/../../admin`),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
