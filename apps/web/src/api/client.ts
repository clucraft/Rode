/*
 * Thin fetch wrapper. Cookies carry the session; the CSRF token from
 * /api/auth/me goes on every state-changing request. Errors are plain
 * objects the UI can show in its own voice.
 */

export interface ApiError {
  status: number;
  error: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(public readonly info: ApiError) {
    super(info.message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiRequestError({
      status: 0,
      error: 'network',
      message: 'No connection to the boat.',
    });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError({
      status: res.status,
      error: e.error ?? `http-${res.status}`,
      message: e.message ?? (res.statusText || 'Request failed.'),
    });
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.info.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
