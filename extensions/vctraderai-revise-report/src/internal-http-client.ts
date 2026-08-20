// VC Trader AI reports BFF client.
//
// AUTH CLUSTER — PFM_AGENT_TOKEN, chosen by PATH SHAPE. The reports routes are
// workspace-scoped (`/api/v1/workspaces/{ws}/reports...`), and that cluster
// authenticates with the workspace-scoped PFM_AGENT_TOKEN. The BFF binds
// identity from the token itself, which is exactly why this cluster is exempt
// from the `X-OpenClaw-Workspace` stamp that the SHARED OPENCLAW_GATEWAY_TOKEN
// clients must send (see extensions/vctraderai-workspace-header-sweep.test.ts).
// The other cluster is `/api/v1/openclaw/*`; sending its token here would 403.
//
// `X-OpenClaw-Thread` IS stamped. The report write routes resolve the authoring
// specialist from that header via `require_specialist_authority`, and take
// authorship from THERE rather than from the request body — an agent cannot
// publish under another specialist's name.
//
// The helper is vendored per-plugin rather than shared: the openclaw extensions
// boundary forbids cross-extension `src/` imports.

const ALLOWLIST_PATH_PATTERN = /^\/api\/v1\/workspaces\/[0-9a-f-]+\/reports\/[0-9a-f-]+\/revise$/;

const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

export class BffEgressViolation extends Error {
  constructor(path: string) {
    super(`vctraderai reports egress violation: ${path}`);
    this.name = "BffEgressViolation";
  }
}

export class BffRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`vctraderai reports request failed (${status}): ${detail}`);
    this.name = "BffRequestError";
  }
}

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
    if (value) {
      params.set(key, value);
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function createBffFetch(
  deps: {
    fetchImpl?: typeof globalThis.fetch;
    threadId?: string;
  } = {},
): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("vctraderai reports: global fetch is not available");
  }
  return async (path, options = {}) => {
    assertAllowlistedPath(path);
    const token = process.env.PFM_AGENT_TOKEN;
    const response = await fetchImpl(
      `${process.env.PFM_BFF_BASE_URL ?? DEFAULT_BFF_BASE_URL}${path}${buildQueryString(options.query)}`,
      {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(deps.threadId ? { "x-openclaw-thread": deps.threadId } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal,
      },
    );
    if (!response.ok) {
      throw new BffRequestError(response.status, (await response.text()).slice(0, 2000));
    }
    return response.json();
  };
}

export const VCTRADERAI_REPORTS_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;
