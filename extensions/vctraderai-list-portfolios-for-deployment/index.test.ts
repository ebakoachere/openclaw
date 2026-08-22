import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  runListPortfoliosForDeployment,
  LIST_PORTFOLIOS_FOR_DEPLOYMENT_TOOL_NAME,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-portfolios-for-deployment", () => {
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

  it("registers the list_portfolios_for_deployment tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-portfolios-for-deployment",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_PORTFOLIOS_FOR_DEPLOYMENT_TOOL_NAME,
      label: "List Portfolios For Deployment",
    });
  });

  // Green suite, false prose: these tests checked the route and the error
  // envelope and never read `description`, so "List the portfolios you can
  // deploy" survived a whole wave despite there being no portfolio deploy.
  it("does not offer a portfolio as a deployable unit", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-portfolios-for-deployment",
    });
    plugin.register(captured.api);
    const description = (captured.tools[0] as { description: string }).description;
    // WAS FALSE: "List the portfolios you can deploy. ... this answers what you
    // CAN deploy, not what exists."
    // Binding a portfolio to a live account needs a live.trader_deployments
    // row and nothing creates one - ADR 0083 PR-8e-3 deleted build/assign/set,
    // and the only remaining non-test mutation is a heartbeat UPDATE that
    // no-ops when no row exists. Running core/openclaw/allowlist.py shows the
    // entire non-READ_ONLY deploy surface is one tool,
    // deploy_strategy_to_account, which takes one strategy VERSION and one
    // account. The model would promise the founder a portfolio-level deploy
    // and then find no action that performs it.
    expect(description).not.toMatch(/portfolios you can deploy/i);
    expect(description).not.toMatch(/what you CAN deploy/i);
    expect(description).toMatch(/NOTHING DEPLOYS A PORTFOLIO/);
    expect(description).toMatch(/deploy_strategy_to_account/);
    // The "when already deployed" columns read the same writer-less plane.
    expect(description).toMatch(/live\.trader_deployments/);
    expect(description).toMatch(/never reflect/i);
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
    await runListPortfoliosForDeployment({}, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE_ID}/openclaw/deployment/portfolios`,
    );
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runListPortfoliosForDeployment({}, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
