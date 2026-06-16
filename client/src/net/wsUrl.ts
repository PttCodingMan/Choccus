/**
 * Resolve the WebSocket URL for the relay server.
 *
 * Precedence:
 *   1. ?ws=<full-url>   — explicit override (e.g. for split host/port setups)
 *   2. ?port=<n>        — same host as the page, explicit port
 *   3. default          — same host, port 8765
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

  return `${scheme}://${host}:8765`;
}
