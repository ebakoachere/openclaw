// VC Trader AI BFF HTTP client (agent memory-graph variant).
//
// Wraps `globalThis.fetch` with an in-plugin allowlist guard that complements
// the Docker sandbox egress policy. The regex enforces the WORKSPACE-SCOPED BFF
// surface declared by ADR 0078 (`/api/v1/workspaces/{ws}/...`). Any
// non-allowlisted path is rejected before a socket is opened, so a buggy or
// malicious tool body cannot reach admin/system surfaces by accident.
//
// AUTH IS CHOSEN BY PATH SHAPE (load-bearing). `/api/v1/workspaces/{ws}/*` is
// the per-workspace-owner cluster: those routes authenticate via
// `require_session_or_agent`, which resolves the agent's headless-user Bearer
// token (PFM_AGENT_TOKEN) to the workspace OWNER's RLS context. The OTHER
// cluster, `/api/v1/openclaw/*`, uses the shared server-to-server
// OPENCLAW_GATEWAY_TOKEN. Copying a sibling from the wrong cluster produces a
// 401 that reads like an outage. These tools MUST present PFM_AGENT_TOKEN.
//
// X-OpenClaw-Workspace IS REQUIRED HERE, unlike most PFM_AGENT_TOKEN siblings.
// `POST /agent-memory/entries` depends on `require_specialist_authority`, whose
// `_trusted_workspace_id` resolves the workspace from (in order) the bound
// OpenClaw runtime ContextVar, the SERVER's own PFM_AGENT_WORKSPACE_ID /
// PFM_WORKSPACE_ID env, then this header. The multi-tenant web_api container
// sets neither env var, so on a specialist turn — where the fork stamps
// X-OpenClaw-Specialist and the dependency therefore refuses to fall through to
// PM authority — a missing header means `workspace_id is None` and the write is
// denied 403 `openclaw_specialist_denied`. The read routes do not take that
// dependency, but both vendored copies stamp it so a future plugin cloned from
// either one cannot silently lose it (`vctraderai-workspace-header-sweep.test.ts`
// only guards the gateway-token cluster, so it would not catch the regression).
//
// We deliberately ship this helper per-plugin rather than via a shared package:
// the openclaw extensions boundary forbids cross-extension `src/` imports
// (`extensions/AGENTS.md`) and a single shared helper is also worth de-duping
// later, not pre-duping now.

const ALLOWLIST_PATH_PATTERN = /^\/api\/v1\/workspaces\/[0-9a-f-]+\/.+$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Query parameters. An ARRAY value is serialised as the same key repeated,
   * which is what FastAPI's `list[str] | None = Query(...)` binds — `search`
   * takes `node_type` that way. A comma-joined single value would arrive as one
   * bogus node type and silently match nothing.
   */
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string>;
  /**
   * Optional JSON request body. When present it is `JSON.stringify`-ed, a
   * `content-type: application/json` header is added, and the request method
   * defaults to POST (unless `method` is set explicitly). The read template
   * client is GET-only; this variant carries a body for the POST
   * agent-memory/entries surface.
   */
  body?: unknown;
  signal?: AbortSignal;
  /**
   * propfirm_manager BFF thread id for the CURRENT turn. When present it is
   * stamped as the `X-OpenClaw-Thread` request header so the BFF can identify
   * which sub-agent (specialist) is calling and enforce its granted authority.
   * Sourced from the plugin execute context (`context.threadId`), which the
   * SDK binds per turn from the session key.
   */
  threadId?: string;
};

export type BffError = {
  code: string;
  message: string;
  status: number;
  /**
   * The server's machine-readable "do this instead" hint, when it sent one.
   * Surfaced in the thrown Error's message so the MODEL can read it. A contract
   * mismatch the model cannot see is indistinguishable from a backend outage:
   * it retries the same wrong shape and finally reports the outage to the user.
   */
  retrySuggestion?: string;
};

/** Long bodies are truncated: this text ends up in a model prompt. */
const MAX_ERROR_BODY_CHARS = 2000;

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read the server's structured error envelope off a failed response.
 *
 * Previously this reported `response.statusText` and threw the BODY away, so a
 * 422 reached the model as the bare word "Unprocessable Entity" — the BFF's
 * `message` and `retry_suggestion`, which say exactly which key was wrong and
 * what to send instead, never arrived. That is the generator of an entire class
 * of silent contract drift.
 *
 * The BFF raises `{"detail": {"error": {code, message, retry_suggestion}}}`
 * (FastAPI wraps `HTTPException.detail`); FastAPI's own request-validation
 * failures use a list under `detail`. Every path here still yields a usable
 * detail — a body that cannot be read must never mask the HTTP failure itself.
 */
async function readBffErrorDetail(response: FetchResponse): Promise<BffError> {
  const fallback: BffError = {
    code: `bff_${response.status}`,
    message: response.statusText || `HTTP ${response.status}`,
    status: response.status,
  };

  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return fallback;
  }
  if (!raw) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  const root = asRecord(parsed);
  const detail = asRecord(root?.detail);
  // The envelope may sit under `detail.error`, under `detail`, or at the root.
  const envelope = [asRecord(detail?.error), detail, asRecord(root?.error), root].find(
    (candidate) => typeof candidate?.message === "string" && candidate.message.length > 0,
  );
  if (!envelope) {
    return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  const code = envelope.code;
  const suggestion = envelope.retry_suggestion;
  return {
    code: typeof code === "string" && code.length > 0 ? code : fallback.code,
    message: String(envelope.message).slice(0, MAX_ERROR_BODY_CHARS),
    status: response.status,
    retrySuggestion:
      typeof suggestion === "string" && suggestion.length > 0
        ? suggestion.slice(0, MAX_ERROR_BODY_CHARS)
        : undefined,
  };
}

export class BffEgressViolation extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`vctraderai bff egress violation: path ${path} is not in the workspace-scoped allowlist`);
    this.name = "BffEgressViolation";
    this.path = path;
  }
}

export class BffRequestError extends Error {
  readonly detail: BffError;
  constructor(detail: BffError) {
    // The retry suggestion belongs in the MESSAGE, not just the detail object:
    // the message is what the tool runner shows the model.
    const summary = `vctraderai bff request failed: ${detail.code} (${detail.status}) ${detail.message}`;
    super(
      detail.retrySuggestion ? `${summary} — retry_suggestion: ${detail.retrySuggestion}` : summary,
    );
    this.name = "BffRequestError";
    this.detail = detail;
  }
}

export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildQueryString(
  query: Record<string, string | string[] | undefined> | undefined,
): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      // Repeat the key, do not join: FastAPI binds `list[str]` from repeats.
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) {
          params.append(key, item);
        }
      }
    }
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

function assertAllowlistedPath(path: string): void {
  if (path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    throw new BffEgressViolation(path);
  }
  if (path.includes("/..") || path.includes("../") || path.includes("/./")) {
    throw new BffEgressViolation(path);
  }
  if (!ALLOWLIST_PATH_PATTERN.test(path)) {
    throw new BffEgressViolation(path);
  }
}

export type BffClientDeps = {
  // Injectable for tests; falls back to globalThis.fetch otherwise.
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Default per-turn BFF thread id bound at client-creation time. When set,
   * every request this client makes is stamped with `X-OpenClaw-Thread`
   * unless a per-call `options.threadId` overrides it. The plugin sources this
   * from its execute context (`context.threadId`).
   */
  threadId?: string;
};

export function createBffFetch(deps: BffClientDeps = {}): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const boundThreadId = deps.threadId;
  if (typeof fetchImpl !== "function") {
    throw new Error("vctraderai bff: global fetch is not available; Node >= 18 required");
  }
  return async function bffFetch(path: string, options: BffFetchOptions = {}): Promise<unknown> {
    assertAllowlistedPath(path);
    const baseUrl = readEnv("PFM_BFF_BASE_URL") ?? DEFAULT_BFF_BASE_URL;
    // Workspace-scoped routes authenticate the agent as the workspace owner via
    // its headless-user token (PFM_AGENT_TOKEN), NOT the shared gateway token.
    const token = readEnv("PFM_AGENT_TOKEN");
    // Matches the server's own resolution order in `_trusted_workspace_id`.
    const workspaceId = readEnv("PFM_AGENT_WORKSPACE_ID") ?? readEnv("PFM_WORKSPACE_ID");
    const queryString = buildQueryString(options.query);
    const url = `${baseUrl}${path}${queryString}`;
    const hasBody = options.body !== undefined;
    const effectiveThreadId = options.threadId ?? boundThreadId;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : undefined),
      ...(token ? { authorization: `Bearer ${token}` } : undefined),
      ...(workspaceId ? { "x-openclaw-workspace": workspaceId } : undefined),
      ...(effectiveThreadId ? { "x-openclaw-thread": effectiveThreadId } : undefined),
      ...options.headers,
    };
    const response = await fetchImpl(url, {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new BffRequestError(await readBffErrorDetail(response));
    }
    return response.json();
  };
}

// Exposed for tests that want to assert the regex shape directly.
export const VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;

// The env var carrying the agent's headless-user owner Bearer token. Exposed so
// tests can assert the workspace-scoped client reads it (not the gateway token).
export const VCTRADERAI_BFF_TOKEN_ENV = "PFM_AGENT_TOKEN";

// The workspace-identity header the write route's specialist dependency reads,
// and the env vars it is sourced from (server resolution order). Exposed so the
// egress tests can pin the stamp rather than trusting the comment above.
export const VCTRADERAI_BFF_WORKSPACE_HEADER = "x-openclaw-workspace";
export const VCTRADERAI_BFF_WORKSPACE_ENVS = [
  "PFM_AGENT_WORKSPACE_ID",
  "PFM_WORKSPACE_ID",
] as const;
