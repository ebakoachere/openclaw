// VC Trader AI BFF HTTP client (workspace-scoped read variant).
//
// The in-plugin allowlist complements Docker egress: a tool cannot reach an
// admin or system route even if its body is changed accidentally or maliciously.

const ALLOWLIST_PATH_PATTERN = /^\/api\/v1\/workspaces\/[0-9a-f-]+\/.+$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";
const MAX_ERROR_BODY_CHARS = 2000;

export type BffFetchOptions = {
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
  threadId?: string;
};

type BffError = { code: string; message: string; status: number; retrySuggestion?: string };
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readBffError(response: FetchResponse): Promise<BffError> {
  const fallback = {
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
  if (!raw) { return fallback; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) };
  }
  const root = asRecord(parsed);
  const detail = asRecord(root?.detail);
  const envelope = [asRecord(detail?.error), detail, asRecord(root?.error), root].find(
    (candidate) => typeof candidate?.message === "string" && candidate.message.length > 0,
  );
  if (!envelope) { return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) }; }
  const suggestion = envelope.retry_suggestion;
  return {
    code: typeof envelope.code === "string" ? envelope.code : fallback.code,
    message: String(envelope.message).slice(0, MAX_ERROR_BODY_CHARS),
    status: response.status,
    retrySuggestion:
      typeof suggestion === "string" ? suggestion.slice(0, MAX_ERROR_BODY_CHARS) : undefined,
  };
}

export class BffEgressViolation extends Error {
  constructor(readonly path: string) {
    super(`vctraderai bff egress violation: path ${path} is not in the workspace-scoped allowlist`);
    this.name = "BffEgressViolation";
  }
}

export class BffRequestError extends Error {
  constructor(readonly detail: BffError) {
    const summary = `vctraderai bff request failed: ${detail.code} (${detail.status}) ${detail.message}`;
    super(
      detail.retrySuggestion ? `${summary} — retry_suggestion: ${detail.retrySuggestion}` : summary,
    );
    this.name = "BffRequestError";
  }
}

export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

function assertAllowlistedPath(path: string): void {
  if (
    path.includes("\n") ||
    path.includes("\r") ||
    path.includes("\0") ||
    path.includes("/..") ||
    path.includes("../") ||
    path.includes("/./") ||
    !ALLOWLIST_PATH_PATTERN.test(path)
  ) {
    throw new BffEgressViolation(path);
  }
}

function buildQueryString(query: Record<string, string | undefined> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === "string" && value.length > 0) { params.set(key, value); }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function createBffFetch(
  deps: { fetchImpl?: typeof globalThis.fetch; threadId?: string } = {},
): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("vctraderai bff: global fetch is not available; Node >= 18 required");
  }
  return async (path, options = {}) => {
    assertAllowlistedPath(path);
    const baseUrl = process.env.PFM_BFF_BASE_URL || DEFAULT_BFF_BASE_URL;
    const agentToken = process.env.PFM_AGENT_TOKEN;
    const threadId = options.threadId ?? deps.threadId;
    const response = await fetchImpl(`${baseUrl}${path}${buildQueryString(options.query)}`, {
      headers: {
        accept: "application/json",
        ...(agentToken ? { authorization: `Bearer ${agentToken}` } : {}),
        ...(threadId ? { "x-openclaw-thread": threadId } : {}),
      },
      signal: options.signal,
    });
    if (!response.ok) { throw new BffRequestError(await readBffError(response)); }
    return response.json();
  };
}

export const VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;
export const VCTRADERAI_BFF_TOKEN_ENV = "PFM_AGENT_TOKEN";
