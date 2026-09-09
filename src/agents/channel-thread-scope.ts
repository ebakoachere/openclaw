import { createHash } from "node:crypto";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

/**
 * The application thread scope for a turn, and where it comes from.
 *
 * ## THE DEFECT THIS ENDS
 *
 * `require_session_or_agent_thread_scoped` on the propfirm_manager BFF refuses
 * every EXECUTE-class tool from an agent bearer that carries no
 * `X-OpenClaw-Thread` header (403 `openclaw_execute_requires_thread_scope`).
 * The plugin stamps that header from `toolContext.threadId`, which today has
 * exactly two sources:
 *
 *  1. an explicit `chat.send.threadId` — the WEB path: the BFF puts the user's
 *     real thread UUID on the frame (`openclaw_native_chat.py:507`), and
 *  2. `extractThreadIdFromSessionKey`, which matches the markers `dashboard:`
 *     and `openai-user:` only.
 *
 * **A Telegram turn has neither.** It arrives through the channel pipeline, not
 * through `chat.send`, and its session key is the shared main key
 * (`agent:main:main` — the sharing is what makes web and Telegram ONE
 * conversation), which carries no marker. So the founder could ask for an order
 * in the web chat and get one, ask for the same order in Telegram and get a
 * 403. The BFF cannot fix this: the callback it receives is indistinguishable
 * from the heartbeat wake-classifier's.
 *
 * ## THE RULE
 *
 * Scope is a property of a **user-originated turn on any channel**, derived
 * server-side. A turn that arrived on a DELIVERABLE channel (telegram, discord,
 * whatsapp… — a channel a human can actually message) is user-originated and
 * gets a scope. The heartbeat wake-classifier — the `/v1/chat/completions` call
 * with no `user` field — arrives on no channel at all, gets nothing, and stays
 * refused FAIL-CLOSED. That is the one turn the guard was built for.
 *
 * ## WHY A MINTED UUID AND NOT THE CHANNEL'S OWN THREAD ID
 *
 * `threadId` means two different things in this codebase, and confusing them
 * would be the third two-vocabularies bug of the week. The channel plugins'
 * `threadId` is a **Telegram topic / Discord thread** id in the respective
 * channel conversation modules; the BFF's is an **application thread UUID**.
 * Stamping a Telegram chat id into
 * `X-OpenClaw-Thread` would put a chat id where the BFF expects a UUID.
 *
 * So this mints a UUIDv5 from the channel and the session key: stable across
 * turns (one Telegram conversation keeps one scope), UUID-shaped (the BFF
 * parses it), and unknown to the BFF's specialist index — which resolves an
 * unknown thread id with no specialist claim to `None` = full PM authority
 * (`web_api/openclaw_internal/specialist_context.py:85-108`). PM authority is
 * exactly right for a Telegram PM turn.
 *
 * The namespace below is distinct from the BFF's specialist namespace by
 * construction, so a minted channel scope can never collide with a registered
 * specialist thread and silently borrow its authority.
 */

/** UUIDv5 namespace for vctraderai channel-turn thread scopes. Never reuse. */
const CHANNEL_THREAD_SCOPE_NAMESPACE = "6f2a1c94-8b3d-5e77-9a41-2c6d0f5b7e13";

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespaceBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 (name-based, SHA-1) and the RFC 4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export type ResolveChannelTurnThreadScopeParams = {
  /** An explicit, authenticated per-turn scope (`chat.send.threadId`). Wins. */
  threadId?: string;
  /** The channel this turn arrived on, if any. */
  messageProvider?: string | null;
  /** The runtime session key for the turn. */
  sessionKey?: string | null;
};

/**
 * The thread scope to carry on this turn's tool callbacks, or `undefined`.
 *
 * `undefined` is a real answer and it is the SAFE one: the plugins omit
 * `X-OpenClaw-Thread` and every execute-class tool is refused fail-closed.
 */
export function resolveChannelTurnThreadScope(
  params: ResolveChannelTurnThreadScopeParams,
): string | undefined {
  const explicit = params.threadId?.trim();
  if (explicit) {
    // The web path. An authenticated per-turn scope is never second-guessed.
    return explicit;
  }
  const channel = params.messageProvider?.trim().toLowerCase();
  if (!channel || !isDeliverableMessageChannel(channel)) {
    // No channel means no human sent this turn — the wake-classifier included.
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    // A channel turn with no session has no stable conversation to bind to;
    // minting a per-turn id would make each message its own thread.
    return undefined;
  }
  return uuidV5(`${channel}:${sessionKey}`, CHANNEL_THREAD_SCOPE_NAMESPACE);
}

const testing = { uuidV5, CHANNEL_THREAD_SCOPE_NAMESPACE };
export { testing as __testing };
