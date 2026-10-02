// ── Familista API Client ──────────────────────────────────────────────────────
// Wraps fetch with the session, base URL and typed error handling.
//
// Cyber Defense R7: NOTHING is kept in localStorage. The server sets the
// session as HttpOnly cookies at sign-in (access_token, and refresh_token
// path-restricted to /api/v1/auth), which no script — including an injected
// one — can read. The access token from the sign-in response is held in memory
// only, as a bearer for this tab; when it expires the API answers 401, the
// client spends the refresh cookie once and retries once.

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;

/** The in-memory bearer for this tab, if one has been issued. */
export function getAccessToken(): string | null {
  return accessToken;
}

export function setToken(token: string): void {
  accessToken = token;
}

export function clearToken(): void {
  accessToken = null;
}

// Refresh tokens rotate on use: two refreshes racing with the same cookie would
// present it twice, and the second presentation is what the platform treats as
// a stolen-token signal. So there is one refresh in flight at a time, shared.
let refreshing: Promise<boolean> | null = null;

/** Spends the refresh cookie once; true when a new session was issued. */
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) { accessToken = null; return false; }
        const body = (await res.json()) as { data?: { accessToken?: string } };
        accessToken = body.data?.accessToken ?? null;
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

interface RequestOptions {
  signal?: AbortSignal;
  /** Do not navigate to the sign-in page on 401 — the caller decides (session restore). */
  quiet401?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refreshSession()) return request<T>(method, path, body, opts, true);
  }

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = res.statusText;
    try {
      const err = (await res.json()) as { error?: string; message?: string; code?: string };
      code = err.code ?? code;
      message = err.message ?? err.error ?? message;
    } catch { /* non-JSON body */ }

    if (res.status === 401 && !opts.quiet401) {
      clearToken();
      window.location.href = '/app/login';
    }
    throw new ApiError(res.status, code, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    request<T>('GET', path, undefined, { signal }),
  /** A GET that leaves a 401 to the caller instead of navigating away. */
  getQuiet: <T>(path: string) =>
    request<T>('GET', path, undefined, { quiet401: true }),
  post: <T>(path: string, body?: unknown) =>
    request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) =>
    request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) =>
    request<T>('PUT', path, body),
  del: <T>(path: string) =>
    request<T>('DELETE', path),
};

/** Build a query string from a params object, omitting undefined/null values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}
