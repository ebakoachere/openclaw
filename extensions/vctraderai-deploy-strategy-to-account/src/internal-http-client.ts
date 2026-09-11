// VC Trader AI BFF HTTP client (propose / staging variant).
//
// Wraps `globalThis.fetch` with an in-plugin allowlist guard that complements
// the Docker sandbox egress policy. The regex enforces the BFF surfaces this
// plugin is allowed to call: workspace-scoped paths (ADR 0078) AND the
// workspace-agnostic `/api/v1/openclaw/<segment>[/<rest>]` tool endpoints. For
// the cluster-C "propose" tools this includes the single-segment staging
// endpoint `/api/v1/openclaw/stage`, which the second branch now permits by
// making the trailing `/<rest>` optional (the read-only templates required two
// segments such as `catalogue/instruments`). Any non-allowlisted path is
// rejected before a socket is opened, so a buggy or malicious tool body cannot
// reach admin/system surfaces by accident.
//
// PROPOSE tools STAGE, they never execute: this client POSTs the proposal to
// the staging endpoint and the human reviews + applies it in the chat. The
// staging endpoint is the only mutating surface this client can reach, and it
// only enqueues a reviewable descriptor - it does not touch live trading state.
//
// We deliberately ship this helper per-plugin rather than via a shared package:
// the openclaw extensions boundary forbids cross-extension `src/` imports
// (`extensions/AGENTS.md`) and a single shared helper is also worth de-duping
// later, not pre-duping now.

const ALLOWLIST_PATH_PATTERN =
  /^(\/api\/v1\/workspaces\/[0-9a-f-]+\/.+|\/api\/v1\/openclaw\/[a-z]+(\/[a-z0-9-/]+)?)(\?.*)?$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
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
  /**
   * The server's FULL problem list, one entry per failing rule.
   *
   * The BFF accumulates every contract violation and sends them as
   * `problems[]`, and its own `retry_suggestion` tells the model to read
   * `problems[].fix_hint`. This client relayed `code`, `message` and
   * `retry_suggestion` and dropped `problems` on the floor, so the model was
   * told to read a list it was never given: it learned ONE RULE PER ATTEMPT
   * and burned a round trip discovering the rule the previous response already
   * knew. A body that makes a promise the relay does not keep is worse than a
   * body that says nothing.
   */
  problems?: BffProblem[];
  /**
   * The machine-readable codes for the same failures, when the server sent
   * them. Kept distinct from `problems` because a caller may want to branch on
   * a code without parsing prose.
   */
  errorCodes?: string[];
};

/** One entry of the server's `problems[]` list: `{code, message, fix_hint}`. */
export type BffProblem = {
  code: string;
  message: string;
  fixHint?: string;
};

/** Long bodies are truncated: this text ends up in a model prompt. */
const MAX_ERROR_BODY_CHARS = 2000;

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read `problems[]` off the envelope, skipping entries with no message. */
function readProblems(value: unknown): BffProblem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const problems: BffProblem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const message = typeof record?.message === "string" ? record.message : "";
    if (!message) {
      continue;
    }
    const code =
      record && typeof record.code === "string" && record.code.length > 0 ? record.code : "problem";
    const hint =
      record && typeof record.fix_hint === "string" && record.fix_hint.length > 0
        ? record.fix_hint
        : undefined;
    problems.push({ code, message, fixHint: hint });
  }
  return problems.length > 0 ? problems : undefined;
}

/** Read `error_codes[]`, keeping only non-empty strings. */
function readErrorCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const codes = value.filter((code): code is string => typeof code === "string" && code.length > 0);
  return codes.length > 0 ? codes : undefined;
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
    // Same envelope record as `code` / `message` / `retry_suggestion`.
    problems: readProblems(envelope.problems),
    errorCodes: readErrorCodes(envelope.error_codes),
  };
}

export class BffEgressViolation extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`vctraderai bff egress violation: path ${path} is not in the allowlist`);
    this.name = "BffEgressViolation";
    this.path = path;
  }
}

/**
 * Render the problem list for the thrown message, BOUNDED, and say what was
 * dropped.
 *
 * The budget is the existing `MAX_ERROR_BODY_CHARS`, applied to this block
 * (the summary keeps rendering exactly as it does today, so a body with no
 * problems is byte-identical to before). A list too long for the budget ends
 * with `(+N more)` rather than stopping mid-sentence: silent truncation is how
 * a model comes to believe it has seen every rule when it has seen four of
 * seven, which is the same "one rule per attempt" failure one level up.
 */
function renderProblems(problems: BffProblem[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const problem of problems) {
    const line = `- ${problem.code}: ${problem.message}${
      problem.fixHint ? ` — ${problem.fixHint}` : ""
    }`;
    // Reserve room for the tail BEFORE committing the line, or the count that
    // explains the truncation would itself be truncated.
    const tail = `\n(+${problems.length - shown} more)`;
    if (used + line.length + 1 + tail.length > budget) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const omitted = problems.length - shown;
  if (omitted > 0) {
    lines.push(`(+${omitted} more)`);
  }
  return lines.join("\n");
}

export class BffRequestError extends Error {
  readonly detail: BffError;
  constructor(detail: BffError) {
    // The retry suggestion belongs in the MESSAGE, not just the detail object:
    // the message is what the tool runner shows the model.
    const summary = `vctraderai bff request failed: ${detail.code} (${detail.status}) ${detail.message}`;
    const head = detail.retrySuggestion
      ? `${summary} — retry_suggestion: ${detail.retrySuggestion}`
      : summary;
    // The suggestion says "read problems[].fix_hint". This makes it true.
    const rendered = detail.problems?.length
      ? renderProblems(detail.problems, MAX_ERROR_BODY_CHARS)
      : "";
    super(rendered ? `${head}\nproblems:\n${rendered}` : head);
    this.name = "BffRequestError";
    this.detail = detail;
  }
}

export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildQueryString(query: Record<string, string | undefined> | undefined): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
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
    const token = readEnv("OPENCLAW_GATEWAY_TOKEN");
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

export const VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;

// The env var carrying this cluster's bearer token. The `/api/v1/openclaw/*`
// routes authenticate with the SHARED server-to-server gateway token, NOT the
// per-workspace headless-user token (`PFM_AGENT_TOKEN`) that the
// `/api/v1/workspaces/{ws}/*` routes require. Exported so a test pins which of
// the two clusters this plugin belongs to - getting it wrong is a 401 that
// looks like a plumbing outage.
export const VCTRADERAI_BFF_TOKEN_ENV = "OPENCLAW_GATEWAY_TOKEN";
