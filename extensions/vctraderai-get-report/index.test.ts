import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { runGetReport, GET_REPORT_TOOL_NAME } from "./index.js";
import { BffEgressViolation } from "./src/internal-http-client.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-report", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalAgentToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalAgentToken === undefined) {
      delete process.env.PFM_AGENT_TOKEN;
    } else {
      process.env.PFM_AGENT_TOKEN = originalAgentToken;
    }
  });

  it("registers the get_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-report" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_REPORT_TOOL_NAME,
      label: "Get Report",
    });
  });

  it("gets the workspace-scoped single-report path with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: { report: { id: "rep-9" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await runGetReport({ report_id: "rep-9" }, { fetchImpl });

    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports/rep-9`);
    expect(capturedMethod).toBe("GET");
    expect(capturedAuth).toBe("Bearer agent-token-001");
    expect(result).toEqual({ data: { report: { id: "rep-9" } } });
  });

  it("percent-encodes the report id rather than splicing it into the path raw", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    // A report id is model-supplied text. It must not be able to add path
    // segments or a query string of its own.
    await runGetReport({ report_id: "rep 9?x=1" }, { fetchImpl });
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/reports/rep%209%3Fx%3D1`);
    expect(url.search).toBe("");
  });

  it("a traversal attempt in the report id is refused before a socket opens", async () => {
    const fetchImpl = vi.fn();

    // Two independent defences, and this asserts the STRONGER one. Encoding
    // alone would already neutralise the traversal -- the id becomes the single
    // literal segment "..%2F..%2Fadmin", which cannot escape /reports/ -- but
    // the egress guard rejects the path outright rather than relying on that.
    // The weaker assertion (that the request goes out harmlessly encoded) would
    // still pass if someone later removed the guard, so it is not the one worth
    // pinning.
    await expect(
      runGetReport(
        { report_id: "../../admin" },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an honest 404 for a report that is not in this workspace", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            error: { code: "report_not_found", message: "no such report in this workspace" },
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    await expect(runGetReport({ report_id: "rep-nope" }, { fetchImpl })).rejects.toThrow(
      /report_not_found.*no such report/s,
    );
  });

  it("fails loudly when the workspace id is not injected", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(runGetReport({ report_id: "rep-9" }, {})).rejects.toThrow(
      /PFM_WORKSPACE_ID is not set/,
    );
  });
});
