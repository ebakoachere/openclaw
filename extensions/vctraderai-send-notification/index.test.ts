import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runSendNotification, SEND_NOTIFICATION_TOOL_NAME } from "./index.js";

describe("vctraderai-send-notification", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  function captureFetch(): {
    fetchImpl: typeof globalThis.fetch;
    seen: { url: string; method: string; headers: Record<string, string>; body: any };
  } {
    const seen = { url: "", method: "", headers: {} as Record<string, string>, body: undefined };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.method = init?.method ?? "GET";
      seen.headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      seen.body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ notification_id: "ntf-1" }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetchImpl, seen };
  }

  it("registers the send_notification tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: SEND_NOTIFICATION_TOOL_NAME,
      label: "Send Notification",
    });
  });

  // The description is what the MODEL reads, so it is asserted like behaviour.
  // Regression guard for the PROPOSE_ONLY -> DIRECT_CONTROL drift (#1328): the
  // schema told the model this tool staged a proposal for a full day after it
  // stopped doing so, and TOOLS.md had to spend a paragraph contradicting it.
  it("describes itself as writing straight through, never as staging a proposal", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const description = captured.tools[0].description;
    expect(description).toMatch(/STRAIGHT THROUGH/);
    expect(description).not.toMatch(/PROPOSE_ONLY/i);
    expect(description).not.toMatch(/stages? a proposal/i);
    expect(description).not.toMatch(/review \+ Apply/i);
  });

  // Reads the closed vocabulary out of the published schema, whichever shape
  // typebox emits for a union of literals (enum, or anyOf of consts, or a lone
  // const).
  function attachmentKindValues(parameters: any): string[] {
    const attachments = parameters?.properties?.attachments;
    const item = attachments?.type === "array" ? attachments.items : attachments?.anyOf?.[0]?.items;
    const kind = item?.properties?.kind;
    if (!kind) return [];
    if (Array.isArray(kind.enum)) return kind.enum.map(String);
    if (Array.isArray(kind.anyOf)) {
      return kind.anyOf.map((s: any) => String(s.const ?? s.enum?.[0]));
    }
    return kind.const === undefined ? [] : [String(kind.const)];
  }

  it("exposes attachments in the schema so a published report can be delivered", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    const attachments = parameters?.properties?.attachments;
    expect(attachments).toBeDefined();
    // Optional: an account-independent notification must stay expressible.
    expect(parameters.required ?? []).not.toContain("attachments");
    const item = attachments.type === "array" ? attachments.items : attachments.anyOf?.[0]?.items;
    expect(item?.required).toEqual(expect.arrayContaining(["kind", "id"]));
    expect(attachmentKindValues(parameters)).toContain("report");
  });

  // WAS FALSE: this test asserted `item.properties.kind.const === "report"` and
  // the schema said "Attachment kind. Only 'report' is supported today." The
  // server has accepted three kinds since propfirm_manager #1425 --
  // web_api/notifications/inpage/schemas.py declares
  // `Literal["report","dataset","notebook"]` and service.py's
  // _VALID_ATTACHMENT_KINDS is ("report","dataset","notebook"), with a separate
  // resolution branch per kind. The green suite hid it because the test pinned
  // the PLUGIN's own narrowed literal, never the server vocabulary it named:
  // plugin and test agreed with each other while both disagreed with the
  // platform, so a specialist that had just written a dataset or a notebook was
  // told delivery-by-attachment was impossible.
  it("offers all three attachment kinds the server resolves", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    expect(attachmentKindValues(parameters).sort()).toEqual(["dataset", "notebook", "report"]);
  });

  it("does not claim report is the only attachment kind", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const schema = JSON.stringify(captured.tools[0].parameters);
    expect(schema).not.toMatch(/Only 'report' is supported/i);
    expect(schema).not.toMatch(/only\s+.?report.?\s+is supported/i);
  });

  // The id means something different per kind, and a model told only the
  // parameter name cannot complete the call. Each producer is named with the
  // FIELD its response carries: publish_report -> report_id, store_dataset ->
  // the name it was stored under (datasets are addressed by name, not uuid --
  // _default_dataset_resolver), list_notebooks -> notebook_id.
  it("says where each attachment id comes from", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    const attachments = parameters?.properties?.attachments;
    const item = attachments.type === "array" ? attachments.items : attachments.anyOf?.[0]?.items;
    const idDescription = String(item?.properties?.id?.description ?? "");
    expect(idDescription).toMatch(/publish_report/);
    expect(idDescription).toMatch(/store_dataset/);
    expect(idDescription).toMatch(/list_notebooks/);
  });

  it("posts straight through to the direct-control notifications route", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification({ title: "title-x" } as any, { fetchImpl });
    expect(new URL(seen.url).pathname).toBe("/api/v1/openclaw/notifications/send");
    expect(seen.method).toBe("POST");
    expect(seen.headers["x-openclaw-tool"]).toBe("send_notification");
    expect(seen.body).toMatchObject({ title: "title-x", workspace_id: "ws-001" });
    // No staging envelope: the params ARE the body, not nested under `params`.
    expect(seen.body.params).toBeUndefined();
    expect(seen.body.tool_name).toBeUndefined();
  });

  it("forwards attachments verbatim to the bff", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification(
      { title: "Daily wrap", attachments: [{ kind: "report", id: "rpt-42" }] } as any,
      { fetchImpl },
    );
    expect(seen.body.attachments).toEqual([{ kind: "report", id: "rpt-42" }]);
  });

  it("forwards dataset and notebook attachments too", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification(
      {
        title: "Research drop",
        attachments: [
          { kind: "dataset", id: "cot-positioning-2026-08" },
          { kind: "notebook", id: "6f1c2b0e-0000-4000-8000-000000000001" },
        ],
      } as any,
      { fetchImpl },
    );
    expect(seen.body.attachments).toEqual([
      { kind: "dataset", id: "cot-positioning-2026-08" },
      { kind: "notebook", id: "6f1c2b0e-0000-4000-8000-000000000001" },
    ]);
  });

  // --- declared, not merely forwarded -------------------------------------
  //
  // The top-level schema is additionalProperties: true, so this plugin has
  // always PASSED THROUGH anything the model sent. That is not the same as the
  // model being able to find it. recipient_user_id has been supported by the
  // BFF for months and advertised nowhere; email is new (propfirm_manager
  // #1419) and the description used to promise it unconditionally.

  it("declares every parameter it forwards, so the model can find them", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    const declared = Object.keys(parameters?.properties ?? {});

    // Everything the BFF reads off the body (_send_agent_notification).
    expect(declared).toEqual(
      expect.arrayContaining([
        "title",
        "body",
        "kind",
        "link_path",
        "recipient_user_id",
        "email",
        "attachments",
      ]),
    );
    // Only the title is ever required; a bare title stays the simple case, and
    // neither new parameter may become a thing the model must decide.
    expect(parameters.required ?? []).toContain("title");
    expect(parameters.required ?? []).not.toContain("recipient_user_id");
    expect(parameters.required ?? []).not.toContain("email");
  });

  it("declares email as a boolean, because the bff refuses anything else", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const parameters = captured.tools[0].parameters as any;
    const email = parameters?.properties?.email;
    const type = email?.type ?? email?.anyOf?.find((s: any) => s.type)?.type;
    expect(type).toBe("boolean");
  });

  it("does not promise an email it cannot guarantee", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-send-notification" });
    plugin.register(captured.api);
    const description = captured.tools[0].description;
    // The sentence that was false for as long as it existed: this tool did not
    // reach the email fan-out at all, and even now the trader's own opt-in
    // decides.
    expect(description).not.toMatch(/best-effort emails/i);
    expect(description).toMatch(/set email true/i);
    expect(description).toMatch(/only if/i);
  });

  it("forwards recipient_user_id and email to the bff", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification(
      { title: "Drawdown breach", recipient_user_id: "usr-7", email: true } as any,
      { fetchImpl },
    );
    expect(seen.body).toMatchObject({ recipient_user_id: "usr-7", email: true });
  });

  it("omits email entirely when the caller does not ask, rather than sending false", async () => {
    const { fetchImpl, seen } = captureFetch();
    await runSendNotification({ title: "Routine" } as any, { fetchImpl });
    expect("email" in seen.body).toBe(false);
  });

  it("surfaces a structured error on bff 403 (tool forbidden)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;
    await expect(
      runSendNotification({ title: "title-x" } as any, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
