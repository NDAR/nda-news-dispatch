/**
 * Hand-rolled Cognito Hosted UI PKCE auth-code flow.
 *
 * Why not a library: this is ~100 lines of standard OAuth — predictable,
 * fewer deps, easier to audit. All tokens are kept in sessionStorage (cleared
 * when the tab closes) so a shared machine doesn't leak admin credentials.
 */
import { config } from '../config';

const STORAGE_KEY = 'nda-dispatch-auth';
const PKCE_KEY = 'nda-dispatch-pkce';

export interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface UserClaims {
  sub: string;
  email: string;
  name?: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getTokens(): Tokens | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

export function getClaims(): UserClaims | null {
  const t = getTokens();
  if (!t) return null;
  try {
    const payload = decodeJwt(t.idToken);
    return { sub: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  const t = getTokens();
  if (!t) return false;
  return t.expiresAt > Date.now() + 10_000; // 10s safety margin
}

export async function login(): Promise<void> {
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const state = randomBase64Url(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    response_type: 'code',
    scope: config.cognito.scopes.join(' '),
    redirect_uri: config.cognito.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  window.location.assign(`https://${config.cognito.domain}/oauth2/authorize?${params}`);
}

export function logout(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: new URL('/', window.location.origin).toString(),
  });
  window.location.assign(`https://${config.cognito.domain}/logout?${params}`);
}

export async function handleCallback(): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Cognito returned error: ${error}`);
  if (!code) throw new Error('Missing "code" in callback URL');

  const pkce = sessionStorage.getItem(PKCE_KEY);
  if (!pkce) throw new Error('Missing PKCE verifier — did login() run?');
  const { verifier, state: expectedState } = JSON.parse(pkce);
  if (state !== expectedState) throw new Error('State mismatch — possible CSRF');
  sessionStorage.removeItem(PKCE_KEY);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.cognito.clientId,
    code,
    redirect_uri: config.cognito.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`https://${config.cognito.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  saveTokens({
    idToken: payload.id_token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  });
}

export async function refresh(): Promise<boolean> {
  const t = getTokens();
  if (!t?.refreshToken) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.cognito.clientId,
    refresh_token: t.refreshToken,
  });
  const res = await fetch(`https://${config.cognito.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return false;
  const payload = (await res.json()) as {
    id_token: string;
    access_token: string;
    expires_in: number;
  };
  saveTokens({
    idToken: payload.id_token,
    accessToken: payload.access_token,
    refreshToken: t.refreshToken, // Cognito doesn't rotate refresh tokens by default
    expiresAt: Date.now() + payload.expires_in * 1000,
  });
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function saveTokens(t: Tokens): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

function randomBase64Url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function sha256Base64Url(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwt(token: string): { sub: string; email: string; name?: string } {
  const [, payload] = token.split('.');
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}
