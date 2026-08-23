import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: message_pm.
//
// The OPENCLAW cluster (OPENCLAW_GATEWAY_TOKEN + X-OpenClaw-Tool), same as
// emit_specialist_signal, because it is that route family sibling. It carries
// PROSE where the signal carries a typed trade opinion.
//
// It cannot wake the PM. The routing is pinned server-side to feed_no_wake and
// is not a request field, so there is deliberately no parameter here that could
// ask for one.

export const MESSAGE_PM_TOOL_NAME = "message_pm";

export type MessagePmDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  threadId?: string;
};

export type MessagePmParams = {
  subject: string;
  body: string;
  specialist_key?: string;
};

function readWorkspaceId(): string {
  const workspaceId = process.env.PFM_WORKSPACE_ID;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("vctraderai message_pm: PFM_WORKSPACE_ID is not set");
  }
  return workspaceId;
}

export async function runMessagePm(
  params: MessagePmParams,
  deps: MessagePmDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch("/api/v1/openclaw/messages/pm", {
    method: "POST",
    body: { ...params, workspace_id: readWorkspaceId() },
    headers: { "X-OpenClaw-Tool": MESSAGE_PM_TOOL_NAME },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-message-pm",
  name: "VC Trader AI Message PM",
  description:
    "Send the PM a written message with a subject and a body. It lands in the PM own thread and is read on its next natural turn: it does NOT wake the PM and cannot be made to. Use it for observations and status that are not a trade opinion; a trade opinion is emit_specialist_signal. A workspace with no PM heartbeat policy has nowhere to deliver, and that is an error rather than a silent success.",
  tools: (tool) => [
    tool({
      name: MESSAGE_PM_TOOL_NAME,
      label: "Message PM",
      description:
        "Send the PM a written message with a subject and a body. It lands in the PM own thread and is read on its next natural turn: it does NOT wake the PM and cannot be made to. Use it for observations and status that are not a trade opinion; a trade opinion is emit_specialist_signal. A workspace with no PM heartbeat policy has nowhere to deliver, and that is an error rather than a silent success.",
      parameters: Type.Object({
        subject: Type.String({
          description: "One line saying what this is about. Up to 200 characters.",
          minLength: 1,
        }),
        body: Type.String({
          description:
            "The message itself, in prose. Up to 4000 characters; an over-long body is refused rather than truncated, because a message cut in half reads as a complete one.",
          minLength: 1,
        }),
        specialist_key: Type.Optional(
          Type.String({
            description: "Which specialist is speaking. Carried in the message text.",
            minLength: 1,
          }),
        ),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runMessagePm(
          params as MessagePmParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
