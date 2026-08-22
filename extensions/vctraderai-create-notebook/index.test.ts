import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { CREATE_NOTEBOOK_TOOL_NAME, runCreateNotebook } from "./index.js";

describe("vctraderai-create-notebook", () => {
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

  it("registers the create_notebook tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-notebook" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_NOTEBOOK_TOOL_NAME,
      label: "Create Notebook",
    });
  });

  it("posts to the stage path with the create_notebook staging envelope", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    let capturedHeaders = new Headers();
    const notebook = {
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await runCreateNotebook(
      {
        project_id: "proj-123",
        title: "Compare EURUSD momentum",
        purpose: "Compare three momentum variants before a walk-forward run.",
        template_kind: "compare",
        notebook,
        default_params: { symbol: "EURUSD", timeframe: "H1" },
      },
      { fetchImpl, threadId: "thread-specialist-7" },
    );

    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders.get("x-openclaw-thread")).toBe("thread-specialist-7");
    expect(capturedBody.tool_name).toBe("create_notebook");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({
      project_id: "proj-123",
      title: "Compare EURUSD momentum",
      template_kind: "compare",
      default_params: { symbol: "EURUSD", timeframe: "H1" },
    });
    expect(capturedBody.params.notebook).toEqual(notebook);
    expect(capturedBody.summary).toBe(
      "Create notebook Compare EURUSD momentum for project proj-123",
    );
    expect(result).toMatchObject({
      message: "Staged a create notebook proposal. Review + Apply it in the chat.",
    });
  });

  it("requires PFM_WORKSPACE_ID before staging a proposal", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runCreateNotebook({
        project_id: "proj-123",
        title: "Compare EURUSD momentum",
      }),
    ).rejects.toThrow("vctraderai create_notebook: PFM_WORKSPACE_ID is not set");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;

    await expect(
      runCreateNotebook(
        {
          project_id: "proj-123",
          title: "Compare EURUSD momentum",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });

  it("folds notebook_json into a canonical notebook object and drops notebook_json", async () => {
    let capturedBody: any = undefined;
    const notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;

    await runCreateNotebook(
      {
        project_id: "proj-123",
        title: "From JSON",
        notebook_json: JSON.stringify(notebook),
      },
      { fetchImpl },
    );

    expect(capturedBody.params.notebook).toEqual(notebook);
    expect(capturedBody.params).not.toHaveProperty("notebook_json");
  });

  it("rejects a notebook_json that does not encode a JSON object", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(
      runCreateNotebook(
        { project_id: "proj-123", title: "Bad", notebook_json: "[1, 2, 3]" },
        { fetchImpl },
      ),
    ).rejects.toThrow("notebook_json must encode a JSON object");
    expect(called).toBe(false);
  });
  it("describes run_id as template-branch-only and names where the value comes from", () => {
    // WHAT THE OLD TEST PINNED, AND WHY GREEN HID IT.
    // The previous version of this test asserted only /no data|authoring time/i,
    // and narrated in a comment that an agent notebook's analysis cells "degrade
    // to 'No run snapshot is embedded in this notebook.'" -- the same sentence the
    // tool description quoted. That sentence has not been emitted by the platform
    // generator for a long time: measured against the platform repo,
    // generate_template_notebook(title='T', params={}) produces 13 cells in which
    // "No run snapshot is embedded" does not appear at all (it survives only in a
    // source comment and in a regression test asserting its ABSENCE). The loose
    // regex was satisfied by the false sentence, so the suite stayed green while
    // the model was being told to grep for a string no notebook can contain.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-notebook" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const runId = tool.parameters?.properties?.run_id;
    expect(runId, "run_id must be an accepted parameter").toBeDefined();
    const description = runId?.description ?? "";

    // The dead string must never come back: no code path emits it.
    expect(description).not.toContain("No run snapshot is embedded");

    // A parameter the model cannot source is a parameter it cannot use, so the
    // producing tool AND its response field must both be named.
    expect(description).toContain("list_experiment_runs");
    expect(description).toContain("rows[].run_id");

    // The honest omit-run_id outcome: the template still executes green and says
    // why it has nothing, rather than dead-ending on a fixed sentence.
    expect(description).toContain("no_run_reference");
  });

  it("warns that run_id is recorded nowhere for an AUTHORED notebook", () => {
    // MEASURED against the platform: create_agent_notebook(notebook=<authored cells>,
    // snapshot_refs={run_id: ...}) stores a document whose full JSON does not contain
    // the run id anywhere (keys cells/metadata/nbformat/nbformat_minor, metadata only a
    // kernelspec), leaves the notebook row's default_params None, never consults the
    // snapshot source, and dispatches papermill params {}. Nothing binds `run_id` in the
    // kernel, so the cell the OLD description told the model to author --
    // vctrader.list_run_trades(run_id) -- dies with NameError after the human has
    // already approved the T1 card. The description must state that trap.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-notebook" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const description = tool.parameters?.properties?.run_id?.description ?? "";

    expect(description).toContain("NameError");
    expect(description).toContain("literal string");
    // And it must NOT keep telling the model that passing run_id makes an authored
    // notebook record its run -- the platform's own stage validator says the opposite.
    expect(description).not.toMatch(/pass run_id so the notebook records which run/i);
  });

  it("teaches authored cells to pass a literal run id, not a bare run_id name", () => {
    // Same defect surface: the notebook-authoring guidance used to print the
    // run-scoped reads as list_run_trades(run_id), which is exactly the NameError
    // above, and models copy this field verbatim.
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-notebook" });
    plugin.register(captured.api);
    const tool = captured.tools[0] as {
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const notebookDescription = tool.parameters?.properties?.notebook?.description ?? "";
    expect(notebookDescription).toContain('vctrader.list_run_trades("<run id>")');
    expect(notebookDescription).not.toContain("vctrader.list_run_trades(run_id)");
  });
});
