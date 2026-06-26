"""Stateless OAuth (Discord + Google) + HMAC-signed session tokens.

The signed token IS the identity — no accounts table, no session store, no
cookies, no extra dependencies (stdlib only). A session token carries
``{pid, name, exp}``; the relay verifies its HMAC with the shared
``CHOCCUS_AUTH_SECRET`` and trusts the embedded ``pid`` (e.g. ``discord:123``)
as the rating-ladder key. An unsigned/invalid token falls back to the legacy
anonymous localStorage id, so logged-out play is unchanged.

Topology (env-driven, identical code dev vs prod):
  * ``CHOCCUS_AUTH_BASE``  — where provider callbacks land (this server's public
    base url). Provider redirect_uri = ``<base>/auth/callback/<provider>``.
    Dev default ``http://localhost:8770``.
  * ``CHOCCUS_APP_ORIGIN`` — where to send the browser back after login, with
    ``?session=<token>``. Dev default ``http://localhost:5173`` (Vite).
  * ``<PROVIDER>_CLIENT_ID`` / ``<PROVIDER>_CLIENT_SECRET`` — per provider; a
    provider with either missing is reported "not configured" (button disabled).

Only the code->token exchange (``exchange_code``) touches the network; every
other function is pure and unit-testable offline.
"""

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request

#: Dev-only signing secret — INSECURE and intentionally loud. Both the auth HTTP
#: server and the relay must share the SAME secret (they verify each other's
#: tokens), so the dev default is a fixed string, not random. Set
#: CHOCCUS_AUTH_SECRET in any real deployment.
_DEV_SECRET = "choccus-dev-insecure-auth-secret-change-me"

#: Session tokens live a month (re-login refreshes); state lives minutes.
SESSION_TTL = 30 * 24 * 3600
STATE_TTL = 600

#: Provider OAuth endpoints + the minimal scope needed to read a stable user id
#: and a display name.
PROVIDERS = {
    "discord": {
        "authorize": "https://discord.com/oauth2/authorize",
        "token": "https://discord.com/api/oauth2/token",
        "userinfo": "https://discord.com/api/users/@me",
        "scope": "identify",
    },
    "google": {
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "userinfo": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid profile",
    },
}


# -- signing -----------------------------------------------------------------


def _secret() -> bytes:
    return (os.environ.get("CHOCCUS_AUTH_SECRET") or _DEV_SECRET).encode()


def using_insecure_secret() -> bool:
    """True when no CHOCCUS_AUTH_SECRET is set (dev default in use)."""
    return not os.environ.get("CHOCCUS_AUTH_SECRET")


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(prefix: str, payload: dict) -> str:
    """``<prefix>.<b64url(json)>.<b64url(hmac)>`` — compact, url-safe, stateless."""
    body = prefix + "." + _b64e(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    )
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).digest()
    return body + "." + _b64e(sig)


def _verify(prefix: str, token: str) -> dict | None:
    """Validate signature + expiry; return the payload dict or None."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != prefix:
        return None
    body = parts[0] + "." + parts[1]
    expect = hmac.new(_secret(), body.encode(), hashlib.sha256).digest()
    try:
        got = _b64d(parts[2])  # binascii.Error subclasses ValueError
    except ValueError:
        return None
    if not hmac.compare_digest(expect, got):
        return None
    try:
        payload = json.loads(_b64d(parts[1]))
    except ValueError:  # bad base64 or bad JSON (JSONDecodeError ⊂ ValueError)
        return None
    if not isinstance(payload, dict) or float(payload.get("exp", 0)) < time.time():
        return None
    return payload


def make_session(pid: str, name: str) -> str:
    """Mint a signed identity token for ``pid`` (the trusted rating key)."""
    return _sign("s1", {"pid": pid, "name": name, "exp": int(time.time()) + SESSION_TTL})


def verify_session(token: str) -> dict | None:
    """Return ``{pid, name, exp}`` for a valid signed session, else None.

    The relay calls this on JoinRoom: a hit means the playerId field carried a
    real authenticated identity; a miss means treat it as an anonymous id.
    """
    return _verify("s1", token)


def make_state(provider: str) -> str:
    """Signed CSRF/anti-forgery state echoed through the OAuth redirect."""
    return _sign("st", {"p": provider, "exp": int(time.time()) + STATE_TTL})


def verify_state(provider: str, state: str) -> bool:
    p = _verify("st", state)
    return p is not None and p.get("p") == provider


# -- provider config / urls --------------------------------------------------


def _creds(provider: str) -> tuple[str, str]:
    return (
        os.environ.get(f"{provider.upper()}_CLIENT_ID", ""),
        os.environ.get(f"{provider.upper()}_CLIENT_SECRET", ""),
    )


def is_configured(provider: str) -> bool:
    return provider in PROVIDERS and all(_creds(provider))


def auth_base() -> str:
    return os.environ.get("CHOCCUS_AUTH_BASE", "http://localhost:8770").rstrip("/")


def app_origin() -> str:
    return os.environ.get("CHOCCUS_APP_ORIGIN", "http://localhost:5173").rstrip("/")


def redirect_uri(provider: str) -> str:
    """Must EXACTLY match the URI registered in the provider's dev portal."""
    return f"{auth_base()}/auth/callback/{provider}"


def authorize_url(provider: str) -> str:
    """The provider login URL to 302 the browser to."""
    cid, _ = _creds(provider)
    p = PROVIDERS[provider]
    params = {
        "client_id": cid,
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        "scope": p["scope"],
        "state": make_state(provider),
    }
    if provider == "google":
        # Force the account chooser so switching Google accounts works.
        params["prompt"] = "select_account"
    return f"{p['authorize']}?{urllib.parse.urlencode(params)}"


# -- network (the only impure part) ------------------------------------------


def _post_form(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 (trusted hosts)
        return json.loads(r.read())


def _get_json(url: str, access_token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310
        return json.loads(r.read())


def userinfo_to_identity(provider: str, info: dict) -> dict:
    """Map a provider's userinfo payload to ``{pid, name}`` (pure; testable)."""
    if provider == "discord":
        uid = str(info["id"])
        name = info.get("global_name") or info.get("username") or "Player"
    else:  # google
        uid = str(info["sub"])
        name = info.get("name") or info.get("given_name") or "Player"
    return {"pid": f"{provider}:{uid}", "name": str(name)[:32]}


def exchange_code(provider: str, code: str) -> dict:
    """Authorization code -> ``{pid, name}`` (token exchange + userinfo).

    Raises on any provider/network error — the caller renders an error page.
    """
    cid, secret = _creds(provider)
    p = PROVIDERS[provider]
    tok = _post_form(
        p["token"],
        {
            "client_id": cid,
            "client_secret": secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri(provider),
        },
    )
    access = tok["access_token"]
    return userinfo_to_identity(provider, _get_json(p["userinfo"], access))


def session_redirect(token: str) -> str:
    """Final hop: back to the app with the freshly minted session token."""
    return f"{app_origin()}/?session={urllib.parse.quote(token)}"
