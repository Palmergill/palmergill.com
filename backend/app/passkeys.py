"""Passkey (WebAuthn) sign-in, alongside passwords rather than instead of them.

Who a passkey belongs to follows the same split as accounts.py:

  * Member passkeys point at their `app_users` row by id and only sign in an
    account that is still active under the same username.
  * The admin has no database row, so an admin passkey row also carries
    `admin_binding`, an HMAC over the credential keyed by the session secret.
    Something that can write to the database but does not hold that env
    secret still cannot plant a passkey that signs in as admin. Rotating
    APP_SESSION_SECRET (or the password it falls back to) therefore retires
    every admin passkey, which is the right outcome after a leak.

Challenges are single use and live in the database (see PasskeyChallenge).
The ceremony a response answers is found from the challenge the browser
echoes back in clientDataJSON, so no cookie or client-held state is needed.
"""

import hashlib
import hmac
import json
import os
from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import Request
from sqlalchemy.orm import Session
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, parse_client_data_json
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app import accounts
from app.accounts import ROLE_ADMIN, ROLE_MEMBER, AccountError
from app.database import PasskeyChallenge, PasskeyCredential, iso_utc, utc_now

RP_NAME = "Palmer Gill"
CHALLENGE_TTL = timedelta(minutes=5)
CEREMONY_TIMEOUT_MS = 120_000
MAX_PASSKEYS_PER_ACCOUNT = 10
MAX_OPEN_CHALLENGES = 2000
NAME_MAX_LENGTH = 60
PURPOSE_REGISTER = "register"
PURPOSE_AUTHENTICATE = "authenticate"
DEFAULT_ORIGINS = ("https://palmergill.com", "https://www.palmergill.com")
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def relying_party(request: Request) -> tuple[str, list[str]]:
    """The RP ID and the origins a ceremony may come from.

    Production is palmergill.com unless WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS say
    otherwise. The browser reports the page's origin inside the signed client
    data, so proxies in between (Vercel rewriting to Railway) do not matter.
    Local previews (LOCAL_SITE_ROOT on a loopback connection) accept the
    localhost origin they were opened on; nothing else trusts the Host header.
    """
    origins = [
        origin.strip().rstrip("/")
        for origin in os.getenv("WEBAUTHN_ORIGINS", "").split(",")
        if origin.strip()
    ]
    rp_id = os.getenv("WEBAUTHN_RP_ID", "").strip()

    local_site = os.getenv("LOCAL_SITE_ROOT", "").lower() in {"1", "true", "yes"}
    if not origins and local_site and request.client and request.client.host in LOOPBACK_HOSTS:
        host = request.headers.get("host", "")
        if urlsplit(f"http://{host}").hostname == "localhost":
            origins = [f"http://{host}"]
            rp_id = rp_id or "localhost"

    if not origins:
        origins = list(DEFAULT_ORIGINS)
    return rp_id or urlsplit(origins[0]).hostname, origins


def admin_binding(secret: str, credential_id: str, public_key: str, owner: str) -> str:
    message = "\x00".join(["passkey-admin", credential_id, public_key, owner])
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def _user_handle(role: str, owner: str, member_id: int | None) -> bytes:
    # Stable per account so a second registration on the same authenticator
    # replaces the first instead of stacking duplicates in the picker.
    return hashlib.sha256(f"palmergill-passkey|{role}|{owner}|{member_id or ''}".encode("utf-8")).digest()


def owner_for_identity(db: Session, identity: dict, admin_username: str) -> dict | None:
    """Map a signed-in identity to the passkey owner fields, or None."""
    if identity["role"] == ROLE_ADMIN:
        return {
            "role": ROLE_ADMIN,
            "owner": admin_username,
            "member_id": None,
            "display_name": admin_username,
        }
    user = accounts.get_user(db, identity["username"])
    if user is None or not user.is_active:
        return None
    return {
        "role": ROLE_MEMBER,
        "owner": user.username,
        "member_id": user.id,
        "display_name": user.display_name,
        "user": user,
    }


def _owned_query(db: Session, owner: dict):
    query = db.query(PasskeyCredential).filter(
        PasskeyCredential.role == owner["role"],
        PasskeyCredential.owner == owner["owner"],
    )
    if owner["role"] == ROLE_MEMBER:
        query = query.filter(PasskeyCredential.member_id == owner["member_id"])
    return query


def _store_challenge(db: Session, challenge: bytes, purpose: str, owner: dict | None = None) -> None:
    now = utc_now()
    db.query(PasskeyChallenge).filter(PasskeyChallenge.expires_at <= now).delete()
    # Sign-in options are public, so bound how many open ceremonies anyone
    # can make the database hold at once.
    if db.query(PasskeyChallenge).count() >= MAX_OPEN_CHALLENGES:
        db.commit()
        raise AccountError("Too many passkey requests right now. Try again in a few minutes.", 429)
    db.add(PasskeyChallenge(
        challenge=bytes_to_base64url(challenge),
        purpose=purpose,
        role=owner["role"] if owner else None,
        owner=owner["owner"] if owner else None,
        member_id=owner["member_id"] if owner else None,
        expires_at=now + CHALLENGE_TTL,
    ))
    db.commit()


def _claim_challenge(db: Session, credential: object, purpose: str) -> dict | None:
    """Consume the challenge this response answers. One use, then gone."""
    try:
        client_data = parse_client_data_json(
            base64url_to_bytes(credential["response"]["clientDataJSON"])
        )
    except (KeyError, TypeError, ValueError, WebAuthnException):
        return None

    challenge = bytes_to_base64url(client_data.challenge)
    row = db.query(PasskeyChallenge).filter(
        PasskeyChallenge.challenge == challenge,
        PasskeyChallenge.purpose == purpose,
    ).first()
    if row is None:
        return None
    claimed = {
        "challenge": client_data.challenge,
        "role": row.role,
        "owner": row.owner,
        "member_id": row.member_id,
        "expires_at": row.expires_at,
    }
    # The delete's row count is the real claim: two requests racing with the
    # same response can both read the row, but only one deletes it.
    deleted = db.query(PasskeyChallenge).filter(PasskeyChallenge.challenge == challenge).delete()
    db.commit()
    if deleted != 1 or claimed["expires_at"] <= utc_now():
        return None
    return claimed


def registration_options(db: Session, request: Request, owner: dict) -> dict:
    existing = _owned_query(db, owner).all()
    if len(existing) >= MAX_PASSKEYS_PER_ACCOUNT:
        raise AccountError(
            f"An account can hold at most {MAX_PASSKEYS_PER_ACCOUNT} passkeys. Remove one first.",
            409,
        )

    rp_id, _ = relying_party(request)
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_name=owner["display_name"],
        user_display_name=owner["display_name"],
        user_id=_user_handle(owner["role"], owner["owner"], owner["member_id"]),
        timeout=CEREMONY_TIMEOUT_MS,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(row.credential_id))
            for row in existing
        ],
    )
    _store_challenge(db, options.challenge, PURPOSE_REGISTER, owner)
    return json.loads(options_to_json(options))


def _clean_name(value: object) -> str:
    name = " ".join(str(value or "").split())[:NAME_MAX_LENGTH]
    return name or "Passkey"


def finish_registration(
    db: Session,
    request: Request,
    owner: dict,
    credential: object,
    name: object,
    signing_secret: str,
) -> PasskeyCredential:
    claimed = _claim_challenge(db, credential, PURPOSE_REGISTER)
    # The ceremony must be finished by the same account that started it.
    if claimed is None or (claimed["role"], claimed["owner"], claimed["member_id"]) != (
        owner["role"], owner["owner"], owner["member_id"]
    ):
        raise AccountError("That passkey request expired. Try again.", 400)

    rp_id, origins = relying_party(request)
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=claimed["challenge"],
            expected_rp_id=rp_id,
            expected_origin=origins,
            require_user_verification=True,
        )
    except (WebAuthnException, KeyError, TypeError, ValueError):
        raise AccountError("That passkey couldn't be verified.", 400)

    credential_id = bytes_to_base64url(verified.credential_id)
    public_key = bytes_to_base64url(verified.credential_public_key)
    if db.query(PasskeyCredential).filter(PasskeyCredential.credential_id == credential_id).first():
        raise AccountError("That passkey is already registered.", 409)

    transports = credential.get("response", {}).get("transports") if isinstance(credential, dict) else None
    if not (isinstance(transports, list) and all(isinstance(t, str) for t in transports)):
        transports = None

    row = PasskeyCredential(
        credential_id=credential_id,
        public_key=public_key,
        sign_count=verified.sign_count,
        role=owner["role"],
        owner=owner["owner"],
        member_id=owner["member_id"],
        admin_binding=(
            admin_binding(signing_secret, credential_id, public_key, owner["owner"])
            if owner["role"] == ROLE_ADMIN
            else None
        ),
        name=_clean_name(name),
        transports=json.dumps(transports[:8]) if transports else None,
    )
    db.add(row)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise AccountError("That passkey is already registered.", 409)
    db.refresh(row)
    return row


def authentication_options(db: Session, request: Request) -> dict:
    rp_id, _ = relying_party(request)
    # No allowCredentials: the browser offers whichever discoverable passkey
    # the person has for this site, so the form needs no username first.
    options = generate_authentication_options(
        rp_id=rp_id,
        timeout=CEREMONY_TIMEOUT_MS,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _store_challenge(db, options.challenge, PURPOSE_AUTHENTICATE)
    return json.loads(options_to_json(options))


def finish_authentication(
    db: Session,
    request: Request,
    credential: object,
    admin_username: str,
    signing_secret: str,
) -> dict | None:
    """Verify a sign-in assertion and return {"username", "role"}, or None."""
    claimed = _claim_challenge(db, credential, PURPOSE_AUTHENTICATE)
    if claimed is None:
        return None

    credential_id = credential.get("id") if isinstance(credential, dict) else None
    if not isinstance(credential_id, str) or not credential_id:
        return None
    row = db.query(PasskeyCredential).filter(PasskeyCredential.credential_id == credential_id).first()
    if row is None:
        return None

    rp_id, origins = relying_party(request)
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=claimed["challenge"],
            expected_rp_id=rp_id,
            expected_origin=origins,
            credential_public_key=base64url_to_bytes(row.public_key),
            credential_current_sign_count=row.sign_count,
            require_user_verification=True,
        )
    except (WebAuthnException, KeyError, TypeError, ValueError):
        return None

    if row.role == ROLE_ADMIN:
        expected = admin_binding(signing_secret, row.credential_id, row.public_key, row.owner)
        if not (
            row.admin_binding
            and hmac.compare_digest(row.admin_binding, expected)
            and hmac.compare_digest(row.owner.encode("utf-8"), admin_username.encode("utf-8"))
        ):
            return None
        identity = {"username": admin_username, "role": ROLE_ADMIN}
    elif row.role == ROLE_MEMBER:
        user = accounts.get_user(db, row.owner)
        # The id check alone is not enough: SQLite hands a deleted row's id
        # to the next insert, so a re-created username can land on the same
        # id. A passkey can never be older than the account it was added to.
        if (
            user is None
            or not user.is_active
            or user.id != row.member_id
            or (user.created_at and row.created_at < user.created_at)
        ):
            return None
        user.last_login_at = utc_now()
        identity = {"username": user.display_name, "role": ROLE_MEMBER}
    else:
        return None

    row.sign_count = verified.new_sign_count
    row.last_used_at = utc_now()
    db.commit()
    return identity


def list_passkeys(db: Session, owner: dict) -> list[dict]:
    rows = _owned_query(db, owner).order_by(PasskeyCredential.created_at.asc()).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "createdAt": iso_utc(row.created_at),
            "lastUsedAt": iso_utc(row.last_used_at),
        }
        for row in rows
    ]


def delete_passkey(db: Session, owner: dict, passkey_id: int) -> bool:
    deleted = _owned_query(db, owner).filter(PasskeyCredential.id == passkey_id).delete()
    db.commit()
    return deleted == 1
