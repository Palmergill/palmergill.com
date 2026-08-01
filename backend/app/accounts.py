"""Member accounts: password hashing, signup validation, credential checks.

Two kinds of identity exist in this app and they are stored in different
places on purpose:

  * The admin (Palmer) comes from APP_AUTH_USERNAME / APP_AUTH_PASSWORD env
    vars. There is no admin row in the database, so nothing that can write to
    `app_users` can mint an account that reads the logs.
  * Members live in `app_users` and only ever get role "member".

Passwords are hashed with scrypt from the standard library — no new
dependency, and memory-hard enough that a leaked table is not a wordlist
away from plaintext.
"""

import hashlib
import os
import re
import secrets
import unicodedata

from sqlalchemy.orm import Session

from app.database import AppUser, FantasyDraftSession, utc_now

ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"

# scrypt parameters. n=2**14 with r=8 lands around 16 MB and ~50-80ms per
# hash on the Railway instance — slow enough to matter offline, fast enough
# that a login does not feel laggy.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SALT_BYTES = 16

USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 24
PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 200

_USERNAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$")

# Names that would let a member impersonate the operator or a system page.
# The configured admin username is added to this set at check time.
RESERVED_USERNAMES = frozenset({
    "admin",
    "administrator",
    "api",
    "docs",
    "login",
    "logout",
    "moderator",
    "null",
    "palmer",
    "palmergill",
    "root",
    "signup",
    "staff",
    "superuser",
    "support",
    "sysadmin",
    "system",
    "undefined",
    "user",
})


class AccountError(Exception):
    """A signup or login problem that is safe to show the person."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def normalize_username(value: object) -> str:
    if not isinstance(value, str):
        return ""
    # NFKC first: without it "ADMIN" in fullwidth characters normalizes to
    # "admin" only after casefolding, and we would compare the wrong string
    # against the reserved list.
    return unicodedata.normalize("NFKC", value).strip().casefold()


def admin_username() -> str:
    return os.getenv("APP_AUTH_USERNAME", "palmer")


def signup_invite_code() -> str | None:
    code = os.getenv("APP_SIGNUP_INVITE_CODE", "").strip()
    return code or None


def signup_enabled() -> bool:
    """Signup requires an invite code to be configured. With no code set the
    endpoint stays closed rather than falling open to the whole internet."""
    return signup_invite_code() is not None


def check_invite_code(submitted: object, db: Session | None = None) -> None:
    """Accept the site invite or an open fantasy draft-room code.

    A room code is intentionally also an account invitation: the host only
    needs to share one code with the league, and a newly created account lands
    back on the room link to claim its own seat.
    """
    expected = signup_invite_code()
    submitted_code = submitted.strip() if isinstance(submitted, str) else ""
    if len(submitted_code) > 128:
        raise AccountError("That invite code isn't valid.", 403)
    # Compare bytes, not str: secrets.compare_digest raises TypeError on a
    # non-ASCII string, which would turn a mistyped code into a 500.
    if expected is not None and secrets.compare_digest(
        submitted_code.encode("utf-8"), expected.encode("utf-8")
    ):
        return

    room_code = "".join(submitted_code.upper().split())
    if db is not None and room_code:
        open_room = db.query(FantasyDraftSession.id).filter(
            FantasyDraftSession.join_code == room_code,
            FantasyDraftSession.state == "lobby",
            FantasyDraftSession.mode == "league",
        ).first()
        if open_room:
            return

    if expected is None:
        raise AccountError("Sign-ups are closed right now.", 403)
    raise AccountError("That invite code isn't valid.", 403)


def validate_username(value: object) -> str:
    username = normalize_username(value)
    if not username:
        raise AccountError("Choose a username.")
    if len(username) < USERNAME_MIN_LENGTH or len(username) > USERNAME_MAX_LENGTH:
        raise AccountError(
            f"Usernames are {USERNAME_MIN_LENGTH}-{USERNAME_MAX_LENGTH} characters."
        )
    if not _USERNAME_PATTERN.match(username):
        raise AccountError(
            "Usernames can use letters, numbers, hyphens, and underscores, "
            "and must start and end with a letter or number."
        )
    if username in RESERVED_USERNAMES or username == normalize_username(admin_username()):
        raise AccountError("That username isn't available.")
    return username


def validate_password(value: object, username: str = "") -> str:
    if not isinstance(value, str) or not value:
        raise AccountError("Choose a password.")
    if len(value) < PASSWORD_MIN_LENGTH:
        raise AccountError(f"Passwords need at least {PASSWORD_MIN_LENGTH} characters.")
    if len(value) > PASSWORD_MAX_LENGTH:
        # Unbounded input into a memory-hard KDF is a cheap way to burn the
        # server's CPU and RAM.
        raise AccountError(f"Passwords can be at most {PASSWORD_MAX_LENGTH} characters.")
    if username and username in value.casefold():
        raise AccountError("Pick a password that doesn't contain your username.")
    return value


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=64 * 1024 * 1024,
    )
    return "$".join(
        ["scrypt", str(_SCRYPT_N), str(_SCRYPT_R), str(_SCRYPT_P), salt.hex(), derived.hex()]
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, hash_hex = encoded.split("$")
        if scheme != "scrypt":
            return False
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(hash_hex)),
            maxmem=64 * 1024 * 1024,
        )
    except (AttributeError, MemoryError, ValueError):
        return False

    return secrets.compare_digest(derived.hex(), hash_hex)


def get_user(db: Session, username: object) -> AppUser | None:
    normalized = normalize_username(username)
    if not normalized:
        return None
    return db.query(AppUser).filter(AppUser.username == normalized).first()


def create_user(db: Session, username: object, password: object) -> AppUser:
    normalized = validate_username(username)
    validate_password(password, normalized)

    if get_user(db, normalized) is not None:
        raise AccountError("That username is taken.", 409)

    display_name = unicodedata.normalize("NFKC", str(username)).strip()
    user = AppUser(
        username=normalized,
        display_name=display_name,
        password_hash=hash_password(password),
        is_active=True,
    )
    db.add(user)
    try:
        db.commit()
    except Exception:
        # Two signups racing on the same name: the unique index is the real
        # arbiter, the check above is only a nicer error path.
        db.rollback()
        raise AccountError("That username is taken.", 409)
    db.refresh(user)
    return user


def authenticate(db: Session, username: object, password: object) -> AppUser | None:
    user = get_user(db, username)
    if user is None:
        # Spend comparable time on a miss so response timing doesn't reveal
        # which usernames exist.
        hash_password(secrets.token_urlsafe(16))
        return None
    if not user.is_active:
        return None
    if not isinstance(password, str) or not verify_password(password, user.password_hash):
        return None

    user.last_login_at = utc_now()
    db.commit()
    return user
