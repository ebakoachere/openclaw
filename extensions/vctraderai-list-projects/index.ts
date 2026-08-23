import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: list_projects.
//
// Calls the workspace-scoped BFF as the workspace owner (PFM_AGENT_TOKEN) and
// returns the VERBATIM response. The description is written against the HANDLER
// BODY rather than the comment block above it -- the W11 audit found 54 tool
// descriptions that promised behaviour only the comments claimed.

export const LIST_PROJECTS_TOOL_NAME = "list_projects";

export type ListProjectsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id, forwarded as X-OpenClaw-Thread so the BFF can
   * identify which sub-agent is calling and enforce its granted authority.
   */
  threadId?: string;
};

export type ListProjectsParams = {
  stage?: string;
  owner_kind?: string;
  include_archived?: boolean;
  cursor?: string;
  limit?: number;
};

function requireWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai list_projects: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runListProjects(
  params: ListProjectsParams,
  deps: ListProjectsDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  const workspaceId = requireWorkspaceId();
  return bffFetch(`/api/v1/workspaces/${workspaceId}/projects`, {
    method: "GET",
    query: {
      stage: params.stage,
      owner_kind: params.owner_kind,
      include_archived:
        params.include_archived === undefined ? undefined : String(params.include_archived),
      cursor: params.cursor,
      limit: params.limit === undefined ? undefined : String(params.limit),
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-list-projects",
  name: "VC Trader AI List Projects",
  description:
    "List the workspace projects, cursor-paginated at 20 per page and 100 maximum. Archived projects are excluded unless include_archived is set.",
  tools: (tool) => [
    tool({
      name: LIST_PROJECTS_TOOL_NAME,
      label: "List Projects",
      description:
        "List the workspace projects, cursor-paginated at 20 per page and 100 maximum. Archived projects are excluded unless include_archived is set.",
      parameters: Type.Object({
        stage: Type.Optional(Type.String({ description: "Optional stage filter.", minLength: 1 })),
        owner_kind: Type.Optional(
          Type.String({ description: "Optional owner-kind filter.", minLength: 1 }),
        ),
        include_archived: Type.Optional(
          Type.Boolean({ description: "Include archived projects. Defaults to false." }),
        ),
        cursor: Type.Optional(
          Type.String({
            description: "Opaque pagination cursor from a previous page.",
            minLength: 1,
          }),
        ),
        limit: Type.Optional(Type.Integer({ description: "Page size, 1 to 100. Defaults to 20." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runListProjects(
          params as ListProjectsParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
