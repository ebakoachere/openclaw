import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: send_notification (DIRECT_CONTROL).
//
// DIRECT_CONTROL per propfirm_manager core/openclaw/allowlist.py. This tool
// WRITES STRAIGHT THROUGH: it POSTs to the dedicated internal BFF route
// `POST /api/v1/openclaw/notifications/send` with the shared
// OPENCLAW_GATEWAY_TOKEN plus X-OpenClaw-Tool, so the server-side allowlist
// gates the exact tool before running it. There is no staged descriptor and no
// human Apply click.
//
// History: this tool was PROPOSE_ONLY and posted to the generic
// `/api/v1/openclaw/stage` chokepoint. It flipped PROPOSE_ONLY ->
// DIRECT_CONTROL in propfirm_manager #1328 (2026-08-18) and this plugin never
// got the companion update every OTHER propose -> direct_control migration
// shipped with, so the BFF carried a hard-coded compatibility bridge
// (`_stage_direct_control_send_notification`) scoped to this one tool name to
// stop every live call 403ing. This is that companion update; the bridge is
// removed on the propfirm_manager side once the image carrying this plugin is
// baked and rolled.
//
// The schema also declares recipient_user_id and email. Both were already
// FORWARDED -- the top-level object is additionalProperties: true, so anything
// the model sent went to the BFF -- and neither was DECLARED, so the model had
// no way to discover either. A capability a model cannot see is a capability
// that does not exist. email is new server-side too (propfirm_manager #1419):
// until it landed, the description above promised an email this tool never
// sent.

export const SEND_NOTIFICATION_TOOL_NAME = "send_notification";
const SEND_PATH = "/api/v1/openclaw/notifications/send";

export type SendNotificationDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

/**
 * One structured attachment riding ON the message. `kind` is a closed
 * vocabulary server-side (`web_api/notifications/inpage/schemas.py`:
 * `Literal["report", "dataset", "notebook"]`, mirrored by
 * `_VALID_ATTACHMENT_KINDS` in that package's service.py). The service has a
 * distinct resolution branch per kind and refuses the whole send if the id
 * does not resolve in this workspace.
 */
export type SendNotificationAttachment = {
  kind: "report" | "dataset" | "notebook";
  id: string;
};

export type SendNotificationParams = {
  title: string;
  body?: string;
  kind?: string;
  link_path?: string;
  recipient_user_id?: string;
  email?: boolean;
  attachments?: SendNotificationAttachment[];
  [key: string]: unknown;
};

function readWorkspaceId(): string {
  const value = process.env.PFM_WORKSPACE_ID;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`vctraderai send_notification: PFM_WORKSPACE_ID is not set`);
  }
  return value;
}

export async function runSendNotification(
  params: SendNotificationParams,
  deps: SendNotificationDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(SEND_PATH, {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": SEND_NOTIFICATION_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-send-notification",
  name: "VC Trader AI Send Notification",
  description:
    "Posts an in-page notification to the trader immediately through the guarded internal BFF route.",
  tools: (tool) => [
    tool({
      name: SEND_NOTIFICATION_TOOL_NAME,
      label: "Send Notification",
      description:
        "Surface an in-page notification to the trader. This writes STRAIGHT THROUGH - there is " +
        "no staged card and no Apply. It lands in the inbox; set email true to also send it as " +
        "an email, which reaches the trader only if they have email notifications switched on. " +
        "Deliver a report, dataset or notebook by attaching its id, not by pasting the content " +
        "into the body: your message is the cover note, the attachment is the document.",
      parameters: Type.Object(
        {
          title: Type.String({ description: "Notification title. Required.", minLength: 1 }),
          body: Type.Optional(Type.String({ description: "Notification body text." })),
          kind: Type.Optional(
            Type.String({ description: "Severity: info, success, warning, or error." }),
          ),
          link_path: Type.Optional(
            Type.String({
              description: "In-app path the notification deep-links to.",
            }),
          ),
          recipient_user_id: Type.Optional(
            Type.String({
              description:
                "Who to notify. Defaults to the workspace owner, which is almost always right - " +
                "pass this only when you mean someone else.",
            }),
          ),
          email: Type.Optional(
            Type.Boolean({
              description:
                "Also send this as an email. Default false. It reaches the trader ONLY if they " +
                "have email notifications switched on, so it is a request and not a guarantee. " +
                "Use it for something worth interrupting someone who is away from the app; " +
                "leave it off for anything the inbox can hold until they look.",
            }),
          ),
          attachments: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  kind: Type.Union(
                    [Type.Literal("report"), Type.Literal("dataset"), Type.Literal("notebook")],
                    { description: "What is attached: 'report', 'dataset' or 'notebook'." },
                  ),
                  id: Type.String({
                    description:
                      "report: the report_id publish_report returns. dataset: the name you " +
                      "stored it under with store_dataset. notebook: the notebook_id from " +
                      "list_notebooks.",
                    minLength: 1,
                  }),
                },
                { additionalProperties: false },
              ),
              {
                description:
                  'Deliverables to ride ON this message, e.g. [{"kind":"report","id":"<report_id>"}]. ' +
                  "Create it first and attach its id. Every attachment is resolved BEFORE the " +
                  "message is written, so an id that is not in this workspace (or an archived " +
                  "notebook) refuses the whole send with a 404 and nothing is delivered.",
              },
            ),
          ),
        },
        { additionalProperties: true },
      ),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runSendNotification(
          params as SendNotificationParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
