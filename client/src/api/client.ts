// ── Familista API Client ──────────────────────────────────────────────────────
// Wraps fetch with JWT injection (localStorage.familista_token), base URL,
// and typed error handling. Mirrors the auth convention from the vanilla SPA.

const BASE = '/api/v1';
const TOKEN_KEY = 'familista_token';

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

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = res.statusText;
    try {
      const err = (await res.json()) as { error?: string; message?: string; code?: string };
      code = err.code ?? code;
      message = err.message ?? err.error ?? message;
    } catch { /* non-JSON body */ }

    if (res.status === 401) {
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
    request<T>('GET', path, undefined, signal),
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
