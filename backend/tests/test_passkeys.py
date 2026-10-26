"""Passkey sign-in: the ownership rules around the WebAuthn ceremony.

A tiny software authenticator below produces real attestations and
assertions, so the library's checks run for real; what these tests pin down
is ours — single-use challenges, the admin binding, and member ownership.
"""
import base64
import hashlib
import json
import uuid

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app import accounts
from app.database import AppUser, PasskeyCredential, SessionLocal
from app.main import ROLE_ADMIN, ROLE_MEMBER, SESSION_COOKIE_NAME, app, create_app_session_token

ADMIN = "palmer"
SECRET = "secret"
ORIGIN = "https://palmergill.com"
RP_ID = "palmergill.com"
MEMBER_PASSWORD = "correct-horse-battery"


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN)
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.setenv("WEBAUTHN_ORIGINS", ORIGIN)
    monkeypatch.delenv("APP_SESSION_SECRET", raising=False)
    monkeypatch.delenv("LOCAL_SITE_ROOT", raising=False)
    monkeypatch.delenv("LOCAL_AUTH_USER", raising=False)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class SoftAuthenticator:
    """One P-256 passkey, answering with user presence and verification."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = uuid.uuid4().bytes
        self.counter = 0

    def _client_data(self, kind: str, challenge: str) -> bytes:
        return json.dumps({"type": kind, "challenge": challenge, "origin": ORIGIN}).encode()

    def create(self, options: dict) -> dict:
        numbers = self.key.public_key().public_numbers()
        cose_key = cbor2.dumps({
            1: 2, 3: -7, -1: 1,
            -2: numbers.x.to_bytes(32, "big"),
            -3: numbers.y.to_bytes(32, "big"),
        })
        auth_data = (
            hashlib.sha256(RP_ID.encode()).digest()
            + bytes([0x45])  # UP | UV | AT
            + self.counter.to_bytes(4, "big")
            + bytes(16)
            + len(self.credential_id).to_bytes(2, "big")
            + self.credential_id
            + cose_key
        )
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64url(self._client_data("webauthn.create", options["challenge"])),
                "attestationObject": b64url(attestation),
                "transports": ["internal"],
            },
        }

    def get(self, options: dict) -> dict:
        self.counter += 1
        auth_data = (
            hashlib.sha256(RP_ID.encode()).digest()
            + bytes([0x05])  # UP | UV
            + self.counter.to_bytes(4, "big")
        )
        client_data = self._client_data("webauthn.get", options["challenge"])
        signature = self.key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(signature),
                "userHandle": None,
            },
        }


def _member() -> tuple[TestClient, str]:
    name = f"pk{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, name, MEMBER_PASSWORD)
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(name, SECRET, role=ROLE_MEMBER))
    return client, name


def _admin() -> TestClient:
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(ADMIN, SECRET, role=ROLE_ADMIN))
    return client


def _register(client: TestClient, authenticator: SoftAuthenticator, password: str):
    options = client.post("/login/passkey/register/options", json={"password": password})
    assert options.status_code == 200, options.text
    credential = authenticator.create(options.json()["publicKey"])
    return client.post("/login/passkey/register", json={"credential": credential, "name": "Laptop"})


def _assertion(authenticator: SoftAuthenticator) -> dict:
    options = TestClient(app).post("/login/passkey/options")
    assert options.status_code == 200, options.text
    return authenticator.get(options.json()["publicKey"])


def _sign_in(credential: dict):
    return TestClient(app).post("/login/passkey", json={"credential": credential, "next": "/"})


def test_member_round_trip_and_challenge_is_single_use():
    client, name = _member()
    authenticator = SoftAuthenticator()
    registered = _register(client, authenticator, MEMBER_PASSWORD)
    assert registered.status_code == 201, registered.text
    assert [p["name"] for p in registered.json()["passkeys"]] == ["Laptop"]

    credential = _assertion(authenticator)
    signed_in = _sign_in(credential)
    assert signed_in.status_code == 200, signed_in.text
    assert signed_in.json()["role"] == ROLE_MEMBER
    assert signed_in.json()["username"] == name
    assert SESSION_COOKIE_NAME in signed_in.cookies

    # The same signed response again: its challenge is already spent.
    assert _sign_in(credential).status_code == 401


def test_adding_a_passkey_needs_the_password_and_a_session():
    client, _ = _member()
    wrong = client.post("/login/passkey/register/options", json={"password": "not-it-at-all"})
    assert wrong.status_code == 401

    anonymous = TestClient(app).post("/login/passkey/register/options", json={"password": MEMBER_PASSWORD})
    assert anonymous.status_code == 401


def test_a_ceremony_cannot_be_finished_by_another_account():
    first, _ = _member()
    second, _ = _member()
    authenticator = SoftAuthenticator()
    options = first.post("/login/passkey/register/options", json={"password": MEMBER_PASSWORD})
    credential = authenticator.create(options.json()["publicKey"])

    hijacked = second.post("/login/passkey/register", json={"credential": credential})
    assert hijacked.status_code == 400


def test_admin_passkey_signs_in_as_admin_until_the_secret_rotates(monkeypatch):
    authenticator = SoftAuthenticator()
    assert _register(_admin(), authenticator, SECRET).status_code == 201

    signed_in = _sign_in(_assertion(authenticator))
    assert signed_in.status_code == 200
    assert signed_in.json()["role"] == ROLE_ADMIN

    monkeypatch.setenv("APP_SESSION_SECRET", "a-rotated-signing-secret")
    assert _sign_in(_assertion(authenticator)).status_code == 401


def test_a_planted_admin_row_without_the_binding_is_refused():
    authenticator = SoftAuthenticator()
    client, _ = _member()
    assert _register(client, authenticator, MEMBER_PASSWORD).status_code == 201

    # Someone with database write access promotes the row to admin.
    db = SessionLocal()
    try:
        row = db.query(PasskeyCredential).filter(
            PasskeyCredential.credential_id == b64url(authenticator.credential_id)
        ).one()
        row.role = ROLE_ADMIN
        row.owner = ADMIN
        row.member_id = None
        row.admin_binding = "0" * 64
        db.commit()
    finally:
        db.close()

    assert _sign_in(_assertion(authenticator)).status_code == 401


def test_a_recreated_username_does_not_inherit_old_passkeys():
    client, name = _member()
    authenticator = SoftAuthenticator()
    assert _register(client, authenticator, MEMBER_PASSWORD).status_code == 201

    db = SessionLocal()
    try:
        db.query(AppUser).filter(AppUser.username == name).delete()
        db.commit()
        accounts.create_user(db, name, MEMBER_PASSWORD)
    finally:
        db.close()

    assert _sign_in(_assertion(authenticator)).status_code == 401


def test_members_only_see_and_remove_their_own_passkeys():
    owner, _ = _member()
    other, _ = _member()
    registered = _register(owner, SoftAuthenticator(), MEMBER_PASSWORD)
    passkey_id = registered.json()["passkeys"][0]["id"]

    assert other.get("/login/passkey/credentials").json()["passkeys"] == []
    assert other.delete(f"/login/passkey/credentials/{passkey_id}").status_code == 404
    assert owner.delete(f"/login/passkey/credentials/{passkey_id}").status_code == 200
    assert owner.get("/login/passkey/credentials").json()["passkeys"] == []


def _visitor(ip: str) -> TestClient:
    return TestClient(app, headers={"X-Real-IP": ip})


def test_an_anonymous_flood_cannot_lock_everyone_out_of_passkeys(monkeypatch):
    # Regression: open challenges were capped site-wide and the cap refused
    # new ones, so one script asking for sign-in options over and over held
    # every slot and passkey sign-in and setup 429'd for everybody.
    from app import main, passkeys
    from app.database import PasskeyChallenge

    monkeypatch.setattr(main, "TRUST_PROXY_HEADERS", True)
    monkeypatch.setattr(passkeys, "MAX_OPEN_CHALLENGES", 30)
    owner, _ = _member()
    authenticator = SoftAuthenticator()
    assert _register(owner, authenticator, MEMBER_PASSWORD).status_code == 201

    for attacker in range(5):
        flood = _visitor(f"203.0.113.{attacker}")
        assert {flood.post("/login/passkey/options").status_code for _ in range(20)} == {200}

    victim = _visitor("198.51.100.7")
    options = victim.post("/login/passkey/options")
    assert options.status_code == 200, options.text
    signed_in = victim.post(
        "/login/passkey",
        json={"credential": authenticator.get(options.json()["publicKey"]), "next": "/"},
    )
    assert signed_in.status_code == 200, signed_in.text

    db = SessionLocal()
    try:
        assert db.query(PasskeyChallenge).count() <= 30
        assert db.query(PasskeyChallenge).filter(
            PasskeyChallenge.client_key == passkeys.client_key("203.0.113.0")
        ).count() <= passkeys.MAX_OPEN_CHALLENGES_PER_CLIENT
    finally:
        db.close()


def test_a_visitor_keeps_only_their_newest_challenges(monkeypatch):
    from app import main, passkeys

    monkeypatch.setattr(main, "TRUST_PROXY_HEADERS", True)
    owner, _ = _member()
    authenticator = SoftAuthenticator()
    assert _register(owner, authenticator, MEMBER_PASSWORD).status_code == 201

    visitor = _visitor("198.51.100.8")
    issued = [
        visitor.post("/login/passkey/options").json()["publicKey"]
        for _ in range(passkeys.MAX_OPEN_CHALLENGES_PER_CLIENT + 1)
    ]
    oldest = visitor.post("/login/passkey", json={"credential": authenticator.get(issued[0])})
    newest = visitor.post("/login/passkey", json={"credential": authenticator.get(issued[-1])})
    assert oldest.status_code == 401
    assert newest.status_code == 200, newest.text


def test_a_removed_passkey_does_not_count_as_a_failed_login(monkeypatch):
    # Regression: picking a passkey the account page had removed, but the
    # device still offered, counted as a failed login, so a few tries locked
    # that network out of password sign-in too.
    from app import main

    monkeypatch.setattr(main, "TRUST_PROXY_HEADERS", True)
    owner, name = _member()
    authenticator = SoftAuthenticator()
    registered = _register(owner, authenticator, MEMBER_PASSWORD)
    passkey_id = registered.json()["passkeys"][0]["id"]
    assert owner.delete(f"/login/passkey/credentials/{passkey_id}").status_code == 200

    visitor = _visitor("198.51.100.9")
    for _ in range(main.AUTH_RATE_LIMIT_MAX_ATTEMPTS + 2):
        options = visitor.post("/login/passkey/options").json()["publicKey"]
        stale = visitor.post("/login/passkey", json={"credential": authenticator.get(options)})
        assert stale.status_code == 401
        assert stale.json()["unknownCredential"] is True
        assert stale.json()["credentialId"] == b64url(authenticator.credential_id)

    password = visitor.post("/login/session", json={"username": name, "password": MEMBER_PASSWORD})
    assert password.status_code == 200, password.text
