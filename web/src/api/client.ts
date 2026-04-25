import { config } from '../config';
import { getTokens, refresh, login } from '../auth/cognito';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Wraps fetch with automatic ID-token attach + one-shot refresh on 401. If
 * refresh fails (or there's no refresh token) we redirect to login so the
 * user gets a fresh session, preserving the current route in `state` for
 * post-login return.
 */
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${config.apiBase}${path}`;
  const res = await send(url, init);
  if (res.status === 401) {
    const refreshed = await refresh();
    if (refreshed) {
      const retry = await send(url, init);
      return parse<T>(retry);
    }
    await login();
    throw new ApiError(401, 'unauthenticated', 'Redirecting to login');
  }
  return parse<T>(res);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const tokens = getTokens();
  const headers = new Headers(init.headers);
  if (tokens) headers.set('authorization', tokens.idToken);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  console.log(`[api] ${method} ${url}`, { hasAuth: !!tokens });
  const res = await fetch(url, { ...init, headers });
  console.log(`[api] ${method} ${url} → ${res.status}`);
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  console.log(
    `[api] response status=${res.status} ct=${ct || '(none)'} len=${text.length}`,
    text.length < 400 ? `body=${text}` : `head=${text.slice(0, 200)}…`,
  );

  if (!res.ok) {
    let code = `http-${res.status}`;
    let message = res.statusText;
    try {
      const body = JSON.parse(text);
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // non-JSON error body — use defaults
    }
    throw new ApiError(res.status, code, message);
  }

  // 200-range. Always try JSON first regardless of content-type — API Gateway
  // sometimes drops content-type on certain integration paths, but the body is
  // still valid JSON. Fall back to text only if JSON parse fails.
  if (text === '') return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    console.error('[api] body is not JSON', { length: text.length, contentType: ct }, e);
    return text as unknown as T;
  }
}
