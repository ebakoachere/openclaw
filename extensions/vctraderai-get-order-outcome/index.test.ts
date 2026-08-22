import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runGetOrderOutcome, GET_ORDER_OUTCOME_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-order-outcome", () => {
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

  it("registers the get_order_outcome tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-order-outcome" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_ORDER_OUTCOME_TOOL_NAME,
      label: "Get Order Outcome",
    });
  });

  it("calls the workspace-scoped read with the owner bearer and the handle query", async () => {
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
    await runGetOrderOutcome({ idempotency_key: "idem-123" }, { fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/live/order-outcome`);
    expect(parsed.searchParams.get("idempotency_key")).toBe("idem-123");
    expect(capturedAuth).toBe("Bearer agent-token-001");
  });

  it("requires at least one handle", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof globalThis.fetch;
    await expect(runGetOrderOutcome({}, { fetchImpl })).rejects.toThrow(
      /at least one of idempotency_key/,
    );
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runGetOrderOutcome({ order_id: "ord-1" }, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  // ---------------------------------------------------------------------------
  // client_order_id is a DEAD handle and the description used to present it as one
  // of three equals.
  //
  // The reader branches two ways -- idempotency_key -> the idempotency_key column,
  // anything else -> payload->>'order_id' -- and client_order_id is aliased onto
  // the second. The place path never writes a client_order_id into a ledger
  // payload; _build_order_intent drops it before the broker. So the lookup always
  // returns unknown.
  //
  // Combined with this tool's own "treat unknown as keep-polling, re-call until you
  // see a terminal status", an agent that placed with a client_order_id and polls
  // with it either loops forever or concludes the order was lost and re-places it,
  // duplicating live risk.
  it("marks client_order_id as dead rather than offering it as an equal handle", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-get-order-outcome",
    });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const description = tool.description ?? "";
    expect(description.length).toBeGreaterThan(80);
    expect(description).toMatch(/client_order_id NEVER resolves/);
    expect(description).toMatch(/PREFER the idempotency_key/);
    const param = tool.parameters?.properties?.client_order_id;
    expect(param, "client_order_id is still accepted, and must be labelled").toBeDefined();
    expect(param?.description ?? "").toMatch(/DEAD HANDLE/);
  });
});
