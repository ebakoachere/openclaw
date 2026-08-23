import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: move_artifact_to_project.
//
// Dispatches to ONE OF TWO routes that already exist and already accept an
// agent bearer -- both were built for this tool (Lane P Plan B) and say so in
// their own handler comments. No new route was needed.
//
//   experiment_run / walkforward_run
//     POST /api/v1/workspaces/{ws}/experiments/{id}/move
//   notebook
//     POST /api/v1/workspaces/{ws}/projects/{from}/notebooks/{id}/move
//
// The notebook route is NESTED under the current project, so a notebook move
// needs from_project_id. That is a property of the route, not a preference, and
// the tool refuses BEFORE any call rather than sending a request that cannot
// succeed.

export const MOVE_ARTIFACT_TO_PROJECT_TOOL_NAME = "move_artifact_to_project";

export type MoveArtifactToProjectDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

export type MoveArtifactToProjectParams = {
  artifact_type: "experiment_run" | "walkforward_run" | "notebook";
  artifact_id: string;
  to_project_id: string;
  from_project_id?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai move_artifact_to_project: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export function movePathFor(workspaceId: string, params: MoveArtifactToProjectParams): string {
  if (params.artifact_type === "notebook") {
    const from = (params.from_project_id ?? "").trim();
    if (from.length === 0) {
      throw new Error(
        "vctraderai move_artifact_to_project: a notebook move needs from_project_id " +
          "(the project it is in NOW) -- the move route is nested under it. List the " +
          "notebooks to find it.",
      );
    }
    return `/api/v1/workspaces/${workspaceId}/projects/${from}/notebooks/${params.artifact_id}/move`;
  }
  return `/api/v1/workspaces/${workspaceId}/experiments/${params.artifact_id}/move`;
}

export async function runMoveArtifactToProject(
  params: MoveArtifactToProjectParams,
  deps: MoveArtifactToProjectDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(movePathFor(workspaceId, params), {
    method: "POST",
    body: { to_project_id: params.to_project_id },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-move-artifact-to-project",
  name: "VC Trader AI Move Artifact To Project",
  description:
    "Move an experiment run, a walkforward run or a notebook into a different project in the same workspace. A notebook move needs its CURRENT project id as well, because the route is nested under it; list the notebooks first if you do not have it. The move is recorded as a durable audit event carrying both the source and the destination project.",
  tools: (tool) => [
    tool({
      name: MOVE_ARTIFACT_TO_PROJECT_TOOL_NAME,
      label: "Move Artifact To Project",
      description:
        "Move an experiment run, a walkforward run or a notebook into a different project in the same workspace. A notebook move needs its CURRENT project id as well, because the route is nested under it; list the notebooks first if you do not have it. The move is recorded as a durable audit event carrying both the source and the destination project.",
      parameters: Type.Object({
        artifact_type: Type.Union(
          [
            Type.Literal("experiment_run"),
            Type.Literal("walkforward_run"),
            Type.Literal("notebook"),
          ],
          { description: "What is being moved." },
        ),
        artifact_id: Type.String({
          description: "Id of the run or notebook to move.",
          minLength: 1,
        }),
        to_project_id: Type.String({
          description: "Destination project id, in the same workspace.",
          minLength: 1,
        }),
        from_project_id: Type.Optional(
          Type.String({
            description:
              "The project the artifact is in NOW. REQUIRED for a notebook, because the notebook move route is nested under its current project. Ignored for runs.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runMoveArtifactToProject(
          params as MoveArtifactToProjectParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
