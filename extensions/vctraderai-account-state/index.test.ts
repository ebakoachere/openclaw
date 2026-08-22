import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin, { runAccountState, ACCOUNT_STATE_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function buildFetch(handlers: Record<string, unknown>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = Object.entries(handlers).find(([path]) => url.endsWith(path));
    if (!match) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(match[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("vctraderai-account-state", () => {
  it("registers the account_state tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-account-state" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: ACCOUNT_STATE_TOOL_NAME,
      label: "Account State",
    });
  });

  // This stub answers 200 to BOTH paths, so it proves only that the two reads
  // are issued and composed — it can NOT show the composed payload is
  // reachable. In the running app GET /workspaces/{ws}/accounts answers a
  // bearer-only call with 401 (see the next test), which this hand-built,
  // path-keyed stub hides. Kept for the request mechanics only.
  it("issues both reads and composes them (stubbed transport, not reachability)", async () => {
    const stats = { card_count: 5 };
    const accounts = { rows: [{ id: "a1" }, { id: "a2" }] };
    const fetchImpl = buildFetch({
      [`/api/v1/workspaces/${WORKSPACE_ID}/dashboard/home`]: stats,
      [`/api/v1/workspaces/${WORKSPACE_ID}/accounts?state=active`]: accounts,
    });
    const result = await runAccountState(WORKSPACE_ID, { fetchImpl });
    expect(result).toEqual({ stats, accounts });
  });

  // The real failure this tool walks into. GET /workspaces/{ws}/accounts is
  // guarded by require_session, which resolves claims from the session COOKIE
  // only; the plugin sends a Bearer token and no cookie, so the live route
  // returns 401 AUTH_REQUIRED (measured against the running app with the
  // plugin's exact header set). Promise.all rejects on the first rejection, so
  // the dashboard half is discarded too and the model gets a hard error from a
  // tool whose description used to promise a composed payload.
  it("loses BOTH halves when the accounts read 401s, as the live route does", async () => {
    const stats = { card_count: 5 };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/dashboard/home")) {
        return new Response(JSON.stringify(stats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          code: "AUTH_REQUIRED",
          message: "You must sign in first.",
          details: null,
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;
    await expect(runAccountState(WORKSPACE_ID, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "AUTH_REQUIRED", status: 401 },
    });
  });

  // The description said "Returns the workspace 5-stat dashboard block plus the
  // active accounts list." — a payload this tool cannot produce for an agent
  // caller, for the reason pinned above. Nothing asserted the description text,
  // so the green suite above sat on top of the false promise.
  it("warns in its description that the call fails for an agent, and names the alternatives", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-account-state" });
    plugin.register(captured.api);
    const { description = "" } = captured.tools[0] as { description?: string };
    // Non-vacuity: assert we are looking at a real description first.
    expect(description.length).toBeGreaterThan(80);
    expect(description).not.toMatch(/Returns the workspace 5-stat dashboard block/);
    expect(description).toMatch(/DOES NOT WORK/);
    expect(description).toMatch(/401/);
    expect(description).toMatch(/list_my_accounts/);
    expect(description).toMatch(/get_account_snapshot/);
  });

  it("surfaces a structured error on bff 4xx", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(runAccountState(WORKSPACE_ID, { fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  it("aborts when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      runAccountState(
        WORKSPACE_ID,
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
