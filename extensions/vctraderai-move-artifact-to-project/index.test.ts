import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  MOVE_ARTIFACT_TO_PROJECT_TOOL_NAME,
  movePathFor,
  runMoveArtifactToProject,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-move-artifact-to-project", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("REGISTERS the tool with the plugin api, under the contract name", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-move-artifact-to-project",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: MOVE_ARTIFACT_TO_PROJECT_TOOL_NAME,
      label: "Move Artifact To Project",
    });
  });

  it("sends a RUN to the experiments move route", () => {
    for (const artifact_type of ["experiment_run", "walkforward_run"] as const) {
      expect(
        movePathFor(WORKSPACE_ID, {
          artifact_type,
          artifact_id: "run-7",
          to_project_id: "proj-b",
        }),
      ).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/experiments/run-7/move`);
    }
  });

  it("sends a NOTEBOOK to the route nested under its CURRENT project", () => {
    expect(
      movePathFor(WORKSPACE_ID, {
        artifact_type: "notebook",
        artifact_id: "nb-3",
        to_project_id: "proj-b",
        from_project_id: "proj-a",
      }),
    ).toBe(`/api/v1/workspaces/${WORKSPACE_ID}/projects/proj-a/notebooks/nb-3/move`);
  });

  it("refuses a notebook move with no from_project_id BEFORE any request", async () => {
    // The notebook route is nested under the current project, so without it
    // there is no URL to build. Failing here, with a message naming what to go
    // and get, beats sending a request that cannot succeed and relaying a 404.
    let called = false;
    await expect(
      runMoveArtifactToProject(
        { artifact_type: "notebook", artifact_id: "nb-3", to_project_id: "proj-b" },
        {
          bffFetch: async () => {
            called = true;
            return {};
          },
        },
      ),
    ).rejects.toThrow(/from_project_id/);
    expect(called).toBe(false);
  });

  it("puts to_project_id on the wire body, and nothing else", async () => {
    let body: Record<string, unknown> = {};
    await runMoveArtifactToProject(
      { artifact_type: "experiment_run", artifact_id: "run-7", to_project_id: "proj-b" },
      {
        bffFetch: async (_path, options) => {
          body = (options?.body ?? {}) as Record<string, unknown>;
          return {};
        },
      },
    );
    expect(body).toEqual({ to_project_id: "proj-b" });
  });

  it("returns the BFF response VERBATIM rather than a projection", async () => {
    const payload = { project_id: "proj-b", path: "/projects/proj-b/notebooks/nb-3", extra: [1] };
    const out = await runMoveArtifactToProject(
      {
        artifact_type: "notebook",
        artifact_id: "nb-3",
        to_project_id: "proj-b",
        from_project_id: "proj-a",
      },
      { bffFetch: async () => payload },
    );
    expect(out).toEqual(payload);
  });

  it("refuses to run without a bound workspace, rather than calling a wrong one", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runMoveArtifactToProject(
        { artifact_type: "experiment_run", artifact_id: "run-7", to_project_id: "proj-b" },
        { bffFetch: async () => ({}) },
      ),
    ).rejects.toThrow(/PFM_WORKSPACE_ID/);
  });
});
