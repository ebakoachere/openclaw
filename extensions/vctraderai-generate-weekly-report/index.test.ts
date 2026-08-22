import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGenerateWeeklyReport, GENERATE_WEEKLY_REPORT_TOOL_NAME } from "./index.js";

describe("vctraderai-generate-weekly-report", () => {
  it("registers the generate_weekly_report tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-weekly-report",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GENERATE_WEEKLY_REPORT_TOOL_NAME,
      label: "Generate Weekly Report",
    });
  });

  // NOTE: fetch is STUBBED here, so this proves only that whatever the
  // transport returns is passed through unchanged. It cannot see that the real
  // route is absent - which is exactly why the false "Compute and return the
  // weekly trading report envelope" description survived a green suite. See the
  // description test at the bottom of this file.
  it("passes a stubbed transport response through verbatim", async () => {
    const envelope = {
      workspace_id: "22222222-2222-2222-2222-222222222222",
      week_ending: "2026-05-30",
      pnl: { realized: 980.55, unrealized: 12.0 },
      sources: ["postgres://live.trade_fills"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222" },
      { fetchImpl },
    );
    expect(result).toEqual(envelope);
  });

  it("calls the BFF reports/weekly endpoint with POST and a JSON body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["content-type"] ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222", week_ending: "2026-05-30" },
      { fetchImpl },
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/reports/weekly");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "22222222-2222-2222-2222-222222222222",
      week_ending: "2026-05-30",
    });
  });

  it("omits the week_ending field from the body when not provided", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateWeeklyReport(
      { workspace_id: "22222222-2222-2222-2222-222222222222" },
      { fetchImpl },
    );
    expect(JSON.parse(capturedBody)).toEqual({
      workspace_id: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(
      runGenerateWeeklyReport(
        { workspace_id: "22222222-2222-2222-2222-222222222222" },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });

  // WHAT WAS FALSE: the tool description read "Compute and return the weekly
  // trading report envelope for a workspace. READ_ONLY per ADR 0078 - no
  // mutation." It computes and returns nothing. Measured against
  // propfirm_manager on 2026-08-22: 'generate_weekly_report' is in
  // core/openclaw/allowlist.py's RETIRED_ENGINE_TOOLS and absent from the
  // 133-entry ALLOWLIST, and POST /api/v1/openclaw/reports/weekly matches NO
  // route on the assembled app (Starlette Match.NONE), while the positive
  // controls POST /api/v1/openclaw/notifications/send and GET
  // /api/v1/reports/weekly both match FULL in the same probe. So a live call
  // 404s.
  //
  // WHY THE GREEN SUITE HID IT: no test in this file ever read the
  // description, and every transport test stubs fetch - a stub answers 200
  // whatever the path, so route absence is invisible here by construction.
  it("tells the model the tool is unavailable instead of promising an envelope", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-generate-weekly-report",
    });
    plugin.register(captured.api);
    const description = captured.tools[0].description ?? "";
    expect(description).toMatch(/UNAVAILABLE/);
    expect(description).toMatch(/404/);
    // Names a surface that actually resolves, so the model has somewhere to go.
    expect(description).toMatch(/list_reports/);
    expect(description).toMatch(/get_report/);
    // The retired claims must not come back.
    expect(description).not.toMatch(/Compute and return the weekly trading report envelope/i);
    expect(description).not.toMatch(/READ_ONLY per ADR 0078/i);
  });
});
