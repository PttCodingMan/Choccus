/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Default game mode when ?mode= is absent (see main.ts). Set at build time
   * for static, relay-less deploys (e.g. VITE_DEFAULT_MODE=solo for a
   * practice-only GitHub Pages build). Unset in dev/serve → online lobby.
   */
  readonly VITE_DEFAULT_MODE?: string;
  /**
   * Relay WebSocket URL override (see net/wsUrl.ts). A full ws(s):// URL or a
   * same-origin path like '/ws'. Set in production behind Cloudflare (which
   * can't proxy the dev :8765); unset in dev → ws://<host>:8765.
   */
  readonly VITE_WS_URL?: string;
  /**
   * Base URL of the OAuth /auth endpoints (see net/auth.ts). Unset in dev →
   * http://localhost:8770; set to '' for same-origin in production.
   */
  readonly VITE_AUTH_BASE?: string;
  /**
   * Show the OAuth login UI. Off unless '1'/'true' — set only once the
   * Discord/Google apps are registered and the relay has their creds.
   */
  readonly VITE_OAUTH_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
