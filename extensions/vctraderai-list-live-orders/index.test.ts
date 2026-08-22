import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { LIST_LIVE_ORDERS_TOOL_NAME, runListLiveOrders } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

type CapturedToolShape = {
  description: string;
  parameters: {
    properties: Record<string, { minimum?: number; maximum?: number; description?: string }>;
  };
};

function describedTool(): CapturedToolShape {
  const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-orders" });
  plugin.register(captured.api);
  return captured.tools[0] as unknown as CapturedToolShape;
}

describe("vctraderai-list-live-orders", () => {
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

  it("registers list_live_orders with the plugin API", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-list-live-orders" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: LIST_LIVE_ORDERS_TOOL_NAME,
      label: "List Live Orders",
    });
  });

  // WAS FALSE: the description read "List broker-authoritative live orders. Use
  // this to verify the governed order's symbol, quantity, stop, and target at
  // the venue." For every non-Alpaca (i.e. every MT5 / prop-firm) account the
  // read never touches a broker: ProviderAwareLiveReadRepository delegates to
  // DbLiveReadRepository, whose list_broker_orders is a plain SELECT over the
  // platform's OWN execution_router.orders. Those four fields are copied from
  // the agent's OrderIntent at insert (stop_price=intent.stop_price) and the
  // only UPDATE on that table sets state/executed_price/updated_at — so the
  // "verification" compared the agent's request against a stored copy of the
  // same request and could never fail. A broker that rejected or clamped the
  // SL/TP was invisible, and the agent would narrate a protected position that
  // was actually naked. The old suite was green because nothing asserted on the
  // description at all — only the URL, the bearer and a 403 shape were pinned,
  // and the happy-path test was even NAMED "broker-authoritative orders read",
  // which restated the lie instead of testing it.
  it("does not claim a broker-authoritative read or venue verification", () => {
    const { description } = describedTool();
    expect(description).not.toMatch(/broker-authoritative/i);
    expect(description).not.toMatch(/verify the governed order/i);
  });

  it("states that the read is the platform's order ledger, not the venue", () => {
    const { description } = describedTool();
    expect(description).toContain("platform's own order ledger");
    expect(description).toContain("never refreshed from the broker");
  });

  it("warns that terminal orders are absent so an empty list proves nothing", () => {
    const { description } = describedTool();
    expect(description).toContain("NEW/PLACING/PLACED");
    expect(description).toMatch(/Filled, rejected and cancelled orders are absent/);
  });

  // WAS FALSE: the schema advertised `maximum: 500`. GET /live/orders binds
  // limit as Query(ge=1, le=svc.MAX_FILLS_LIMIT) with MAX_FILLS_LIMIT = 200, so
  // every value in 201..500 is rejected by FastAPI with HTTP 422
  // ("Input should be less than or equal to 200") before the handler runs.
  // Measured against the real router: 1/50/200 -> 200, 201/250/500 -> 422.
  it("caps limit at the route's real ceiling of 200", () => {
    const { parameters } = describedTool();
    expect(parameters.properties.limit.maximum).toBe(200);
    expect(parameters.properties.limit.minimum).toBe(1);
    expect(parameters.properties.limit.description).toContain("HTTP 422");
  });

  it("names where an account_id comes from", () => {
    const { parameters } = describedTool();
    expect(parameters.properties.account_id.description).toContain(
      "list_live_accounts_for_deployment",
    );
    expect(parameters.properties.account_id.description).toContain("rows[].live_account_id");
  });

  it("calls the workspace-scoped orders read", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: { orders: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await runListLiveOrders({ account_id: "account-x", limit: 1 }, { fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/orders`);
    const query = new URL(capturedUrl).searchParams;
    expect(query.get("account_id")).toBe("account-x");
    expect(query.get("limit")).toBe("1");
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("surfaces a structured BFF error", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runListLiveOrders({ account_id: "account-x" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
