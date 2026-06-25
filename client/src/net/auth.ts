/**
 * OAuth session (Discord / Google) — the rating identity on the client side.
 *
 * The signed session token is minted server-side (server/relay/auth.py); the
 * client only stores it and sends it back as the JoinRoom `playerId`, where the
 * relay verifies its HMAC and trusts the embedded provider id as the rating
 * key. The client CANNOT verify the signature (no secret) — it only decodes the
 * payload for display and to drop a locally-expired token. Logged out, the
 * anonymous localStorage id (identity.ts) is used, exactly as before.
 *
 * Login flow: navigate to `<authBase>/auth/login/<provider>`; the server round-
 * trips through the provider and 302s back to `<app>/?session=<token>`, which
 * captureSessionFromUrl() picks up on the next load.
 */
import { getPlayerId } from './identity';

const SESSION_KEY = 'choccus.session';

export type Provider = 'discord' | 'google';

export interface Auth {
  /** The signed token to send to the relay as playerId. */
  token: string;
  /** Display name from the provider. */
  name: string;
  /** Stable rating id, e.g. "discord:123" (display/debug only). */
  pid: string;
}

/**
 * Base URL of the /auth endpoints. Dev: the sibling Python auth server on its
 * own port. Prod: same origin (reverse-proxied under /auth), so a relative
 * path. Override with VITE_AUTH_BASE at build time.
 */
function authBase(): string {
  const env = import.meta.env.VITE_AUTH_BASE as string | undefined;
  if (env !== undefined && env !== '') return env.replace(/\/$/, '');
  return import.meta.env.DEV ? 'http://localhost:8770' : '';
}

/**
 * Whether to surface the OAuth login UI. OFF by default — only a build with
 * VITE_OAUTH_ENABLED=1 (i.e. once the Discord/Google apps are registered and
 * the relay has their creds) shows the login buttons. Keeps users from hitting
 * a "provider not configured" page before launch.
 */
export function oauthEnabled(): boolean {
  const v = import.meta.env.VITE_OAUTH_ENABLED as string | undefined;
  return v === '1' || v === 'true';
}

/** Decode the token's middle segment (base64url JSON). No signature check. */
function decodePayload(token: string): { pid: string; name: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b + '='.repeat((4 - (b.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { pid?: unknown; name?: unknown; exp?: unknown };
    if (typeof json.pid !== 'string') return null;
    return {
      pid: json.pid,
      name: typeof json.name === 'string' ? json.name : '',
      exp: typeof json.exp === 'number' ? json.exp : 0,
    };
  } catch {
    return null;
  }
}

/** On load: capture `?session=<token>` from the URL into localStorage, then
 *  strip it from the address bar. No-op when the param is absent. */
export function captureSessionFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('session');
  if (token === null) return;
  if (decodePayload(token) !== null) {
    try {
      localStorage.setItem(SESSION_KEY, token);
    } catch {
      /* private mode — stays logged out */
    }
  }
  url.searchParams.delete('session');
  window.history.replaceState(null, '', url.toString());
}

/** The current logged-in identity, or null. A locally-expired token counts as
 *  logged out (and is cleared) so we never send a stale token to the relay. */
export function getAuth(): Auth | null {
  let token: string | null = null;
  try {
    token = localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (token === null || token === '') return null;
  const p = decodePayload(token);
  if (p === null || (p.exp > 0 && p.exp * 1000 < Date.now())) {
    logout();
    return null;
  }
  return { token, name: p.name, pid: p.pid };
}

/** The id sent to the relay as playerId: the signed token when logged in, else
 *  the anonymous localStorage id (unchanged behaviour when logged out). */
export function ratingKey(): string {
  return getAuth()?.token ?? getPlayerId();
}

export function login(provider: Provider): void {
  window.location.href = `${authBase()}/auth/login/${provider}`;
}

export function logout(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
