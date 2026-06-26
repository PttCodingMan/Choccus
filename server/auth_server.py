"""OAuth HTTP endpoints (stdlib http.server) — Discord + Google login.

Two routes, both top-level browser navigations (no CORS, no fetch):

  GET /auth/login/<provider>      302 -> the provider's consent screen
  GET /auth/callback/<provider>   provider redirects here with ?code&state;
                                  we exchange it and 302 back to the app at
                                  <APP_ORIGIN>/?session=<signed token>

All identity/signing lives in relay/auth.py — this file is just the wiring.
Dev: ``python server/auth_server.py`` listens on :8770 (CHOCCUS_AUTH_PORT) and
``python server/main.py`` also starts it in a daemon thread for one-command dev.
Prod: run it on its own port and reverse-proxy ``/auth/*`` to it (same domain).

Env: see relay/auth.py (AUTH_BASE, APP_ORIGIN, <PROVIDER>_CLIENT_ID/SECRET,
CHOCCUS_AUTH_SECRET). Provider creds may be absent — that provider then renders
a "not configured" page instead of redirecting.
"""

import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from relay import auth

HOST = os.environ.get("CHOCCUS_AUTH_HOST", "localhost")
PORT = int(os.environ.get("CHOCCUS_AUTH_PORT", "8770"))


def _page(title: str, body: str) -> bytes:
    return (
        f"<!doctype html><meta charset=utf-8><title>{title}</title>"
        f"<body style='font:16px system-ui;max-width:34rem;margin:4rem auto;color:#5A3420'>"
        f"<h2>{title}</h2><p>{body}</p></body>"
    ).encode()


class AuthHandler(BaseHTTPRequestHandler):
    # Quiet logs (mirrors serve.py's _SilentHandler).
    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A002
        pass

    def _send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        parts = urlsplit(self.path)
        segs = [s for s in parts.path.split("/") if s]
        # /auth/<action>/<provider>
        if len(segs) != 3 or segs[0] != "auth":
            self._send(404, _page("Not found", "Unknown endpoint."))
            return
        action, provider = segs[1], segs[2]
        if provider not in auth.PROVIDERS:
            self._send(404, _page("Not found", f"Unknown provider {provider!r}."))
            return
        if action == "login":
            self._login(provider)
        elif action == "callback":
            self._callback(provider, parse_qs(parts.query))
        else:
            self._send(404, _page("Not found", "Unknown endpoint."))

    def _login(self, provider: str) -> None:
        if not auth.is_configured(provider):
            self._send(
                503,
                _page(
                    f"{provider.title()} login unavailable",
                    f"This server has no {provider.upper()}_CLIENT_ID / "
                    f"{provider.upper()}_CLIENT_SECRET configured.",
                ),
            )
            return
        self._redirect(auth.authorize_url(provider))

    def _callback(self, provider: str, query: dict) -> None:
        code = (query.get("code") or [""])[0]
        state = (query.get("state") or [""])[0]
        if not code or not auth.verify_state(provider, state):
            self._send(400, _page("Login failed", "Invalid or expired login request."))
            return
        try:
            ident = auth.exchange_code(provider, code)
            token = auth.make_session(ident["pid"], ident["name"])
        except Exception as exc:  # noqa: BLE001 — surface provider/network errors
            self._send(502, _page("Login failed", f"Could not complete login: {exc}"))
            return
        self._redirect(auth.session_redirect(token))


def make_server(host: str = HOST, port: int = PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), AuthHandler)


def serve_in_thread(host: str = HOST, port: int = PORT) -> ThreadingHTTPServer:
    """Start the auth server on a daemon thread (for main.py one-command dev)."""
    server = make_server(host, port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    server = make_server()
    configured = [p for p in auth.PROVIDERS if auth.is_configured(p)]
    print(
        f"[choccus] auth server on http://{HOST}:{PORT}"
        f" — providers: {', '.join(configured) or 'NONE configured'}"
        + ("  [INSECURE dev auth secret]" if auth.using_insecure_secret() else ""),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[choccus] auth server stopped")


if __name__ == "__main__":
    main()
