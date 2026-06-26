/**
 * Resolve the WebSocket URL for the relay server.
 *
 * Precedence:
 *   1. ?ws=<full-url>   — explicit override (e.g. for split host/port setups)
 *   2. ?port=<n>        — same host as the page, explicit port
 *   3. VITE_WS_URL      — build-time default: a full ws(s):// URL, or a same-
 *                         origin path like '/ws'. This is the production /
 *                         Cloudflare setup: Cloudflare only proxies a fixed set
 *                         of ports (8765 is NOT one), so the relay is served
 *                         over 443 at a path and reverse-proxied to :8765.
 *   4. default          — same host, port 8765 (dev / `npm run serve`)
 *
 * Uses wss:// when the page is served over HTTPS so the browser does not
 * block a mixed-content upgrade.  In dev (Vite on localhost) this falls
 * through to ws://, matching the previous hard-coded behaviour.
 */
export function resolveWsUrl(params?: URLSearchParams): string {
  const p = params ?? new URLSearchParams(window.location.search);
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname;

  const explicit = p.get('ws');
  if (explicit) return explicit;

  const port = p.get('port');
  if (port) return `${scheme}://${host}:${port}`;

  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envUrl !== undefined && envUrl !== '') {
    if (envUrl.startsWith('ws://') || envUrl.startsWith('wss://')) return envUrl;
    // A same-origin path ('/ws'): use the page's host (incl. port if any), so a
    // 443 origin yields wss://<domain>/ws with no explicit port.
    if (envUrl.startsWith('/')) return `${scheme}://${window.location.host}${envUrl}`;
  }

  return `${scheme}://${host}:8765`;
}
