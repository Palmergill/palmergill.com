"""Member accounts: signup, login, and the admin/member privilege boundary."""

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.accounts import AccountError, ROLE_ADMIN, ROLE_MEMBER
from app.database import AppUser, Base, SessionLocal, engine
from app.main import (
    SESSION_COOKIE_NAME,
    _auth_failure_store,
    app,
    create_app_session_token,
)

ADMIN_USERNAME = "palmer"
ADMIN_PASSWORD = "secret"
INVITE_CODE = "come-on-in"


def setup_function():
    _auth_failure_store.clear()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        db.query(AppUser).delete()
        db.commit()
    finally:
        db.close()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.setenv("APP_SIGNUP_INVITE_CODE", INVITE_CODE)
    return TestClient(app)


def signup(client, username="taylor", password="a-good-password", code=INVITE_CODE):
    return client.post(
        "/login/signup",
        json={"username": username, "password": password, "inviteCode": code},
    )


def member_client(monkeypatch, username="taylor"):
    """A client holding a signed member session for `username`."""
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(username, ADMIN_PASSWORD, role=ROLE_MEMBER),
    )
    return client


def admin_client():
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(ADMIN_USERNAME, ADMIN_PASSWORD, role=ROLE_ADMIN),
    )
    return client


# --- password hashing -------------------------------------------------------


def test_password_hash_round_trips_and_rejects_wrong_password():
    encoded = accounts.hash_password("correct-horse-battery")
    assert encoded.startswith("scrypt$")
    assert "correct-horse-battery" not in encoded
    assert accounts.verify_password("correct-horse-battery", encoded)
    assert not accounts.verify_password("Correct-horse-battery", encoded)


def test_password_hash_is_salted_per_user():
    assert accounts.hash_password("same-password") != accounts.hash_password("same-password")


def test_verify_password_rejects_malformed_hash():
    assert not accounts.verify_password("anything", "")
    assert not accounts.verify_password("anything", "plaintext")
    assert not accounts.verify_password("anything", "md5$1$2$3$ab$cd")


# --- signup validation ------------------------------------------------------


def test_signup_creates_member_and_signs_them_in(configured):
    response = signup(configured)

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["role"] == ROLE_MEMBER
    assert body["username"] == "taylor"
    assert SESSION_COOKIE_NAME in response.cookies

    session = configured.get("/login/session").json()
    assert session["authenticated"] is True
    assert session["role"] == ROLE_MEMBER


def test_signup_rejects_wrong_invite_code(configured):
    response = signup(configured, code="guess")

    assert response.status_code == 403
    assert "invite code" in response.json()["error"].lower()


def test_signup_closed_when_no_invite_code_configured(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.delenv("APP_SIGNUP_INVITE_CODE", raising=False)
    client = TestClient(app)

    assert client.get("/login/signup").json() == {"enabled": False}
    assert signup(client, code="").status_code == 403
    assert signup(client, code="anything").status_code == 403


def test_signup_status_reports_enabled(configured):
    assert configured.get("/login/signup").json() == {"enabled": True}


def test_signup_rejects_admin_username(configured):
    response = signup(configured, username=ADMIN_USERNAME)

    assert response.status_code == 400
    assert "available" in response.json()["error"]


def test_signup_rejects_admin_username_in_other_casing(configured):
    assert signup(configured, username="Palmer").status_code == 400
    assert signup(configured, username="PALMER").status_code == 400


@pytest.mark.parametrize("username", ["admin", "root", "api", "system", "support"])
def test_signup_rejects_reserved_usernames(configured, username):
    assert signup(configured, username=username).status_code == 400


@pytest.mark.parametrize("username", ["ab", "a" * 25, "-nope", "nope-", "sp ace", "emoji😀"])
def test_signup_rejects_malformed_usernames(configured, username):
    assert signup(configured, username=username).status_code == 400


def test_signup_rejects_short_password(configured):
    response = signup(configured, password="short")

    assert response.status_code == 400
    assert "10 characters" in response.json()["error"]


def test_signup_rejects_overlong_password(configured):
    # Unbounded input into a memory-hard KDF is a cheap CPU/RAM burn.
    assert signup(configured, password="x" * 5000).status_code == 400


def test_signup_rejects_password_containing_username(configured):
    assert signup(configured, username="taylor", password="taylor12345").status_code == 400


def test_signup_rejects_duplicate_username(configured):
    assert signup(configured).status_code == 200
    duplicate = signup(TestClient(app), username="Taylor")

    assert duplicate.status_code == 409
    assert "taken" in duplicate.json()["error"]


def test_signup_stores_hash_not_password(configured):
    signup(configured, password="a-good-password")

    db = SessionLocal()
    try:
        user = db.query(AppUser).filter(AppUser.username == "taylor").one()
    finally:
        db.close()

    assert "a-good-password" not in user.password_hash
    assert user.username == "taylor"


# --- login ------------------------------------------------------------------


def test_member_can_log_in_after_signup(configured):
    signup(configured, username="taylor", password="a-good-password")

    client = TestClient(app)
    response = client.post(
        "/login/session",
        json={"username": "taylor", "password": "a-good-password"},
    )

    assert response.status_code == 200
    assert response.json()["role"] == ROLE_MEMBER
    assert client.get("/login/session").json()["role"] == ROLE_MEMBER


def test_member_login_is_case_insensitive_on_username(configured):
    signup(configured, username="taylor", password="a-good-password")

    response = TestClient(app).post(
        "/login/session",
        json={"username": "TAYLOR", "password": "a-good-password"},
    )

    assert response.status_code == 200


def test_member_login_rejects_wrong_password(configured):
    signup(configured, username="taylor", password="a-good-password")

    response = TestClient(app).post(
        "/login/session",
        json={"username": "taylor", "password": "a-good-passwore"},
    )

    assert response.status_code == 401
    assert response.json()["error"] == "Invalid username or password"


def test_unknown_username_and_wrong_password_give_the_same_error(configured):
    signup(configured, username="taylor", password="a-good-password")
    client = TestClient(app)

    unknown = client.post("/login/session", json={"username": "nobody", "password": "whatever123"})
    wrong = client.post("/login/session", json={"username": "taylor", "password": "whatever123"})

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_admin_login_still_works(configured):
    client = TestClient(app)
    response = client.post(
        "/login/session",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    )

    assert response.status_code == 200
    assert response.json()["role"] == ROLE_ADMIN


def test_deactivated_member_cannot_log_in(configured):
    signup(configured, username="taylor", password="a-good-password")

    db = SessionLocal()
    try:
        db.query(AppUser).filter(AppUser.username == "taylor").one().is_active = False
        db.commit()
    finally:
        db.close()

    response = TestClient(app).post(
        "/login/session",
        json={"username": "taylor", "password": "a-good-password"},
    )
    assert response.status_code == 401


# --- the privilege boundary -------------------------------------------------


def test_member_session_cannot_read_logs(configured, monkeypatch):
    response = member_client(monkeypatch).get("/api/admin/logs")

    assert response.status_code == 403
    assert response.json()["error"] == "Admin access required"


def test_member_session_cannot_open_admin_dashboard(configured, monkeypatch):
    response = member_client(monkeypatch).get(
        "/admin/", headers={"Accept": "text/html"}, follow_redirects=False
    )

    assert response.status_code == 403
    assert "admin-only" in response.text


def test_member_session_cannot_reach_openapi_or_docs(configured, monkeypatch):
    client = member_client(monkeypatch)

    assert client.get("/openapi.json").status_code == 403
    assert client.get("/docs").status_code == 403


def test_member_session_cannot_trigger_fantasy_collector(configured, monkeypatch):
    response = member_client(monkeypatch).post("/api/fantasy/admin/refresh?job=players")

    assert response.status_code == 403


def test_admin_session_still_reaches_admin_api(configured):
    assert admin_client().get("/api/admin/logs").status_code == 200


def test_member_session_is_authenticated_for_ordinary_pages(configured, monkeypatch):
    session = member_client(monkeypatch).get("/login/session").json()

    assert session["authenticated"] is True
    assert session["role"] == ROLE_MEMBER
    assert session["username"] == "taylor"


# --- session token forgery --------------------------------------------------


def test_signed_admin_claim_is_rejected_for_non_admin_username(configured):
    """The API signs member and admin tokens with the same secret, so the
    username on an admin claim has to be checked, not just the signature."""
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("mallory", ADMIN_PASSWORD, role=ROLE_ADMIN),
    )

    assert client.get("/login/session").json()["authenticated"] is False
    assert client.get("/api/admin/logs").status_code in (401, 403)


def test_member_token_naming_the_admin_gets_no_admin_rights(configured):
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(ADMIN_USERNAME, ADMIN_PASSWORD, role=ROLE_MEMBER),
    )

    assert client.get("/api/admin/logs").status_code == 403


def test_unknown_role_claim_is_rejected(configured):
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("taylor", ADMIN_PASSWORD, role="superadmin"),
    )

    assert client.get("/login/session").json()["authenticated"] is False


def test_legacy_token_without_role_still_authenticates_the_admin(configured):
    """Cookies issued before member accounts existed carry no role claim."""
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(ADMIN_USERNAME, ADMIN_PASSWORD),
    )

    session = client.get("/login/session").json()
    assert session["authenticated"] is True
    assert session["role"] == ROLE_ADMIN
    assert client.get("/api/admin/logs").status_code == 200


def test_legacy_token_without_role_is_rejected_for_other_usernames(configured):
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("taylor", ADMIN_PASSWORD),
    )

    assert client.get("/login/session").json()["authenticated"] is False


def test_member_token_signed_with_wrong_secret_is_rejected(configured):
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("taylor", "not-the-secret", role=ROLE_MEMBER),
    )

    assert client.get("/login/session").json()["authenticated"] is False


def test_expired_member_token_is_rejected(configured):
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("taylor", ADMIN_PASSWORD, now=0, role=ROLE_MEMBER),
    )

    assert client.get("/login/session").json()["authenticated"] is False


# --- invite code handling ---------------------------------------------------


def test_check_invite_code_requires_exact_match(monkeypatch):
    monkeypatch.setenv("APP_SIGNUP_INVITE_CODE", INVITE_CODE)

    accounts.check_invite_code(INVITE_CODE)
    accounts.check_invite_code(f"  {INVITE_CODE}  ")

    for wrong in [None, "", "come-on-i", f"{INVITE_CODE}x", INVITE_CODE.upper(), 42]:
        with pytest.raises(AccountError):
            accounts.check_invite_code(wrong)


def test_check_invite_code_rejects_non_ascii_without_crashing(monkeypatch):
    """secrets.compare_digest raises TypeError on non-ASCII str, which turned
    a mistyped code into a 500 instead of a refusal."""
    monkeypatch.setenv("APP_SIGNUP_INVITE_CODE", INVITE_CODE)

    for wrong in ["café☕", "пароль", "🎲🎲🎲"]:
        with pytest.raises(AccountError):
            accounts.check_invite_code(wrong)


def test_signup_rejects_non_ascii_invite_code(configured):
    response = configured.post("/login/signup", json={
        "username": "curious",
        "password": "a-great-password",
        "inviteCode": "café☕",
    })

    assert response.status_code == 403
    assert response.json()["error"] == "That invite code isn't valid."
