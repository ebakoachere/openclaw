import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runListLivePositions, LIST_LIVE_POSITIONS_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

type CapturedToolShape = {
  description: string;
  parameters: {
    properties: Record<string, { description?: string }>;
  };
};

function describedTool(): CapturedToolShape {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-positions" });
  plugin.register(captured.api);
  return captured.tools[0] as unknown as CapturedToolShape;
}

describe("vctraderai-list-live-positions", () => {
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

  it("registers the list_live_positions tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-positions" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_LIVE_POSITIONS_TOOL_NAME,
      label: "List Live Positions",
    });
  });

  // WAS FALSE: the schema offered include_closed as "Include recently closed
  // positions." The flag is inert end to end — the route forwards it to
  // build_positions_individual -> build_positions where it is declared and
  // never read, and none of the five list_open_positions /
  // list_broker_positions implementations takes it; DbLiveReadRepository also
  // drops flat / zero-quantity rows via _is_open regardless. Measured against
  // the real builder with three seeded positions: include_closed=true and
  // include_closed=false produced BYTE-IDENTICAL output and the repository
  // received only {workspace_id, account_id}. Asked "did that position close?",
  // a model would set the flag, get open positions only, and state a false
  // negative about a real closure. The old suite was green because it passed
  // include_closed: false and asserted nothing but the URL path and the bearer,
  // so an inert flag was indistinguishable from a working one.
  it("does not offer an include_closed flag the API ignores", () => {
    const { parameters } = describedTool();
    expect(Object.keys(parameters.properties)).not.toContain("include_closed");
  });

  it("states that only open positions are ever returned", () => {
    const { description } = describedTool();
    expect(description).toContain("Open positions ONLY");
    expect(description).toMatch(/neither confirm nor deny that a close happened/);
  });

  it("explains the broker-vs-ledger provenance of each row", () => {
    const { description } = describedTool();
    expect(description).toContain("source='broker'");
    expect(description).toContain("source='ledger'");
  });

  it("names where an account_id comes from", () => {
    const { parameters } = describedTool();
    expect(parameters.properties.account_id.description).toContain(
      "list_live_accounts_for_deployment",
    );
    expect(parameters.properties.account_id.description).toContain("rows[].live_account_id");
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
    await runListLivePositions({ account_id: "account_id-x" }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/positions`);
    const query = new URL(capturedUrl).searchParams;
    expect(query.get("account_id")).toBe("account_id-x");
    expect(query.get("include_closed")).toBeNull();
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListLivePositions({ account_id: "account_id-x" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
