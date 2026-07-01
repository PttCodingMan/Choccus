"""Unit tests for relay/auth.py — signing, verification, identity mapping.

Pure/offline: the only networked function (exchange_code) is exercised by
stubbing its two transport helpers, so no real OAuth provider is contacted.
"""

import time

import pytest

from relay import auth
from relay.relay_server import RelayServer


@pytest.fixture(autouse=True)
def _fixed_secret(monkeypatch):
    # Pin a known secret so signatures are stable and independent of the env.
    monkeypatch.setenv("CHOCCUS_AUTH_SECRET", "test-secret")


# -- session tokens ----------------------------------------------------------


def test_session_roundtrip():
    tok = auth.make_session("discord:42", "Choco")
    got = auth.verify_session(tok)
    assert got is not None
    assert got["pid"] == "discord:42"
    assert got["name"] == "Choco"


def test_session_rejects_tampered_payload():
    tok = auth.make_session("discord:42", "Choco")
    prefix, body, sig = tok.split(".")
    # Re-sign nothing: swap the body for a forged one, keep the old signature.
    forged = auth.make_session("discord:999", "Hacker").split(".")[1]
    assert auth.verify_session(f"{prefix}.{forged}.{sig}") is None


def test_session_rejects_wrong_secret(monkeypatch):
    tok = auth.make_session("discord:42", "Choco")
    monkeypatch.setenv("CHOCCUS_AUTH_SECRET", "different-secret")
    assert auth.verify_session(tok) is None


def test_session_rejects_expired(monkeypatch):
    tok = auth.make_session("discord:42", "Choco")
    # Jump the clock far past the TTL (auth.py calls time.time()).
    monkeypatch.setattr(time, "time", lambda: 1e18)
    assert auth.verify_session(tok) is None


@pytest.mark.parametrize("garbage", ["", "not-a-token", "a.b", "s1.x.y.z", "st.abc.def"])
def test_session_rejects_garbage(garbage):
    assert auth.verify_session(garbage) is None


# -- state (CSRF) ------------------------------------------------------------


def test_state_roundtrip_and_provider_binding():
    st = auth.make_state("discord")
    assert auth.verify_state("discord", st) is True
    # A state minted for one provider must not validate for another.
    assert auth.verify_state("google", st) is False


def test_state_rejects_garbage():
    assert auth.verify_state("discord", "nope") is False


# -- identity mapping --------------------------------------------------------


def test_discord_identity_prefers_global_name():
    ident = auth.userinfo_to_identity(
        "discord", {"id": 7, "username": "legacy", "global_name": "Choco"}
    )
    assert ident == {"pid": "discord:7", "name": "Choco"}


def test_discord_identity_falls_back_to_username():
    ident = auth.userinfo_to_identity("discord", {"id": 7, "username": "legacy"})
    assert ident["name"] == "legacy"


def test_google_identity_uses_sub():
    ident = auth.userinfo_to_identity("google", {"sub": "abc", "name": "Cake"})
    assert ident == {"pid": "google:abc", "name": "Cake"}


def test_identity_name_is_capped():
    ident = auth.userinfo_to_identity("google", {"sub": "x", "name": "z" * 100})
    assert len(ident["name"]) == 32


# -- authorize url -----------------------------------------------------------


def test_authorize_url_has_required_params(monkeypatch):
    monkeypatch.setenv("DISCORD_CLIENT_ID", "cid123")
    monkeypatch.setenv("DISCORD_CLIENT_SECRET", "sek")
    monkeypatch.setenv("CHOCCUS_AUTH_BASE", "https://x.test")
    url = auth.authorize_url("discord")
    assert url.startswith("https://discord.com/oauth2/authorize?")
    assert "client_id=cid123" in url
    assert "redirect_uri=https%3A%2F%2Fx.test%2Fauth%2Fcallback%2Fdiscord" in url
    assert "state=" in url


def test_is_configured_requires_both_creds(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    assert auth.is_configured("google") is False
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    assert auth.is_configured("google") is False  # secret still missing
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "sek")
    assert auth.is_configured("google") is True


# -- exchange_code (networked path, transport stubbed) -----------------------


def test_exchange_code_stubbed(monkeypatch):
    monkeypatch.setenv("DISCORD_CLIENT_ID", "cid")
    monkeypatch.setenv("DISCORD_CLIENT_SECRET", "sek")
    calls = {}

    def fake_post(url, data):
        calls["token_url"] = url
        calls["data"] = data
        return {"access_token": "AT"}

    def fake_get(url, access_token):
        calls["userinfo_url"] = url
        calls["bearer"] = access_token
        return {"id": "555", "global_name": "Choco"}

    monkeypatch.setattr(auth, "_post_form", fake_post)
    monkeypatch.setattr(auth, "_get_json", fake_get)

    ident = auth.exchange_code("discord", "the-code")
    assert ident == {"pid": "discord:555", "name": "Choco"}
    assert calls["data"]["code"] == "the-code"
    assert calls["data"]["grant_type"] == "authorization_code"
    assert calls["bearer"] == "AT"


# -- relay integration: JoinRoom honours a signed token ----------------------


def test_relay_join_trusts_signed_session():
    """A valid session token in playerId becomes the trusted rating key; an
    anonymous id passes through unchanged (logged-out path)."""
    server = RelayServer(db_path=":memory:")

    class FakeWS:
        remote_address = ("127.0.0.1", 0)

    fake_fields = {
        "room": None,
        "slot": None,
        "send": lambda self, d: None,
        "ping": lambda self: None,  # not awaited by _join itself
    }

    # Logged-in join: playerId carries a signed token -> embedded pid wins.
    conn = type("C", (), fake_fields)()
    token = auth.make_session("discord:42", "Choco")
    server._join(conn, {"roomId": "r1", "name": "", "playerId": token})
    assert conn.room.players[conn.slot].player_id == "discord:42"
    # Name was empty -> filled from the verified session.
    assert conn.room.players[conn.slot].name == "Choco"

    # Anonymous join: a bare id is used as-is (still spoofable, unchanged).
    conn2 = type("C", (), fake_fields)()
    server._join(conn2, {"roomId": "r2", "name": "Guest", "playerId": "anon-uuid-xyz"})
    assert conn2.room.players[conn2.slot].player_id == "anon-uuid-xyz"
