import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListCurrentDeployments, LIST_CURRENT_DEPLOYMENTS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-current-deployments", () => {
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

  it("registers the list_current_deployments tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-current-deployments",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_CURRENT_DEPLOYMENTS_TOOL_NAME,
      label: "List Current Deployments",
    });
  });

  // The suite below was green while the tool described itself as "List current
  // deployments." - it only ever checked the route and the error envelope, and
  // never read `description`. The transport was right; the sentence was not.
  it("does not present itself as the answer to 'what is deployed right now'", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-current-deployments",
    });
    plugin.register(captured.api);
    const description = (captured.tools[0] as { description: string }).description;
    // WAS FALSE: "List current deployments."
    // The read is live.trader_deployments INNER-joined to live.trader_packages
    // and research.trader_definitions. ADR 0083 PR-8e-3 deleted every writer of
    // that table; the only non-test mutation left is an UPDATE inside
    // record_runtime_heartbeat that short-circuits with reason
    // "no_current_deployment" when no row exists, so it can never create one.
    // What actually runs is strategy_registry.strategy_deployments, which this
    // tool never reads and has no fallback to. Asked what is deployed, the
    // model got [] and told the founder nothing was live while governed
    // deployments were armed and trading.
    expect(description).toMatch(/LEGACY/);
    expect(description).toMatch(/live\.trader_deployments/);
    expect(description).toMatch(/strategy_registry\.strategy_deployments/);
    expect(description).toMatch(/NOT evidence that nothing is deployed/i);
    // And it must not re-offer itself as the duplicate pre-check that
    // deploy_strategy_to_account used to point at.
    expect(description).toMatch(/cannot tell you whether a strategy version is already attached/i);
  });

  it("calls the workspace-scoped read with the owner bearer", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runListCurrentDeployments({}, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/openclaw/deployment/current`,
    );
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runListCurrentDeployments({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
