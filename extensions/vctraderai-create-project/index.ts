import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: create_project.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const CREATE_PROJECT_TOOL_NAME = "create_project";

export type CreateProjectDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type CreateProjectParams = {
  name: string;
  description?: string;
  stage?: string;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai create_project: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runCreateProject(
  params: CreateProjectParams,
  deps: CreateProjectDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/projects`, {
    method: "POST",
    body: {
      name: params.name,
      ...(params.description === undefined ? {} : { description: params.description }),
      ...(params.stage === undefined ? {} : { stage: params.stage }),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-create-project",
  name: "VC Trader AI Create Project",
  description:
    "Create a workspace project. Ownership provenance is derived by the server from the caller credential and is never read from the request, so a project created here is always recorded as agent-authored.",
  tools: (tool) => [
    tool({
      name: CREATE_PROJECT_TOOL_NAME,
      label: "Create Project",
      description:
        "Create a workspace project. Ownership provenance is derived by the server from the caller credential and is never read from the request, so a project created here is always recorded as agent-authored.",
      parameters: Type.Object({
        name: Type.String({ description: "Project name.", minLength: 1 }),
        description: Type.Optional(
          Type.String({ description: "Optional project description.", minLength: 1 }),
        ),
        stage: Type.Optional(
          Type.String({ description: "Optional lifecycle stage.", minLength: 1 }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runCreateProject(
          params as CreateProjectParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
