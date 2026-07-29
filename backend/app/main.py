import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager, suppress
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from app import accounts
from app.accounts import ROLE_ADMIN, ROLE_MEMBER, AccountError
from app.database import SessionLocal
from app.database_migration import init_db_with_migration
from app.log_handler import install_db_logging
from app.routers import admin, analytics, bitcoin, stocks, poker, craps, fantasy
from app.routers.analytics import cleanup_old_analytics, record_analytics_event
import os

logger = logging.getLogger(__name__)


# Bounded queue of pending analytics writes. The request middleware pushes
# event-kwargs dicts here (non-blocking) and a single background worker
# drains them — keeping synchronous SQLite writes off the event loop.
_ANALYTICS_QUEUE_MAX = 10_000
_analytics_event_queue: asyncio.Queue[dict] | None = None
_analytics_dropped = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _analytics_event_queue
    init_db_with_migration()
    install_db_logging()
    _analytics_event_queue = asyncio.Queue(maxsize=_ANALYTICS_QUEUE_MAX)
    cleanup_task = asyncio.create_task(_periodic_game_cleanup())
    analytics_cleanup_task = asyncio.create_task(_periodic_retention_cleanup())
    analytics_writer_task = asyncio.create_task(_analytics_writer())
    rate_limit_sweep_task = asyncio.create_task(_periodic_rate_limit_sweep())
    background_tasks = [
        cleanup_task,
        analytics_cleanup_task,
        analytics_writer_task,
        rate_limit_sweep_task,
    ]
    background_tasks.append(asyncio.create_task(_periodic_fantasy_collection()))
    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        for task in background_tasks:
            with suppress(asyncio.CancelledError):
                await task


async def _analytics_writer() -> None:
    """Drain queued analytics events into the database off the request path."""
    assert _analytics_event_queue is not None
    while True:
        kwargs = await _analytics_event_queue.get()
        try:
            await asyncio.to_thread(_write_analytics_event, kwargs)
        except Exception:
            logger.exception("Failed to flush analytics event")
        finally:
            _analytics_event_queue.task_done()


def _write_analytics_event(kwargs: dict) -> None:
    db = SessionLocal()
    try:
        record_analytics_event(db, **kwargs)
    finally:
        db.close()


def _enqueue_analytics_event(kwargs: dict) -> None:
    global _analytics_dropped
    queue = _analytics_event_queue
    if queue is None:
        return
    try:
        queue.put_nowait(kwargs)
    except asyncio.QueueFull:
        _analytics_dropped += 1
        # Log once every 100 drops so a flood doesn't spam, but we still
        # surface that we're losing data.
        if _analytics_dropped % 100 == 1:
            logger.warning(
                "Analytics queue full (capacity %d); dropped %d event(s) so far",
                _ANALYTICS_QUEUE_MAX,
                _analytics_dropped,
            )


# Cap individual cleanup invocations. If a sync DB call hangs (lock contention,
# disk stall, etc.), we want the periodic loop to recover instead of stalling
# all future cleanup runs.
_CLEANUP_TIMEOUT_SECONDS = 30


async def _run_with_timeout(label: str, func, *args, timeout: int = _CLEANUP_TIMEOUT_SECONDS):
    """Run `func(*args)` in a thread with a timeout, logging timeouts/errors."""
    try:
        return await asyncio.wait_for(asyncio.to_thread(func, *args), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("%s timed out after %ds", label, timeout)
        return None
    except Exception:
        logger.exception("Error during %s", label)
        return None


async def _periodic_game_cleanup(interval: int = 300) -> None:
    """Prune stale poker games every `interval` seconds."""
    while True:
        await asyncio.sleep(interval)
        removed = await _run_with_timeout("poker game cleanup", poker.cleanup_old_games)
        if removed:
            logger.info("Cleaned up %d stale poker game(s)", removed)


async def _periodic_rate_limit_sweep(interval: int = 10 * 60) -> None:
    """Evict per-IP rate-limit store keys with no attempts left in their window.

    Each store re-filters a key's own timestamps only when that key is
    accessed again, so an IP that hits a public endpoint once and never
    returns (e.g. a botnet scan) leaves a stale entry behind forever. This
    sweep bounds memory for the unauthenticated poker/craps/analytics APIs
    and the auth-failure tracker.
    """

    def _sweep() -> int:
        return (
            sweep_auth_failure_store()
            + craps.sweep_rate_limit_store()
            + analytics.sweep_analytics_rate_limit_store()
            + poker.sweep_rate_limit_store()
        )

    while True:
        await asyncio.sleep(interval)
        removed = await _run_with_timeout("rate limit sweep", _sweep)
        if removed:
            logger.info("Rate limit sweep evicted %d stale key(s)", removed)


async def _periodic_retention_cleanup(interval: int = 6 * 60 * 60) -> None:
    """Prune analytics and log data on a 90-day retention window."""

    def _retention_cycle():
        db = SessionLocal()
        try:
            return cleanup_old_analytics(db), admin.cleanup_old_logs(db)
        finally:
            db.close()

    while True:
        await asyncio.sleep(interval)
        result = await _run_with_timeout("retention cleanup", _retention_cycle)
        if not result:
            continue
        analytics_removed, logs_removed = result
        if analytics_removed or logs_removed:
            logger.info(
                "Deleted %d analytics event(s) and %d log entry(s) older than 90 days",
                analytics_removed,
                logs_removed,
            )

async def _periodic_fantasy_collection(interval: int = 15 * 60) -> None:
    """Run due fantasy data-collection jobs every `interval` seconds.

    The scheduler decides which jobs are due from cached NFL state and the
    per-job next-due timestamps it persists, so this loop just ticks. The
    first cycle runs right away — next-due timestamps live in the DB, so on
    an already-populated deployment it's a no-op, and on a fresh one it
    seeds the data immediately instead of 15 minutes after boot. Each cycle
    is wrapped in the timeout guard and its own DB session.
    """

    def _cycle():
        from app.services import fantasy_collector

        db = SessionLocal()
        try:
            return fantasy_collector.run_scheduled(db)
        finally:
            db.close()

    while True:
        summaries = await _run_with_timeout("fantasy collection", _cycle, timeout=600)
        if summaries:
            logger.info("Fantasy collection ran %d job(s)", len(summaries))
        await asyncio.sleep(interval)


app = FastAPI(title="Palmer Gill API", version="0.2.0-p5", lifespan=lifespan)

AUTH_REALM = "Palmer Gill Apps"
SESSION_COOKIE_NAME = "pg_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
AUTH_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("APP_AUTH_RATE_LIMIT_WINDOW_SECONDS", "900"))
AUTH_RATE_LIMIT_MAX_ATTEMPTS = int(os.getenv("APP_AUTH_RATE_LIMIT_MAX_ATTEMPTS", "8"))
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
# Number of trusted reverse proxies in front of the app (e.g. Railway/Vercel
# edge). The real client IP is the entry X-Forwarded-For positions in from the
# right — anything to its left was supplied by the client and is spoofable.
TRUSTED_PROXY_HOPS = max(1, int(os.getenv("TRUSTED_PROXY_HOPS", "1")))
# Best-effort, per-process auth-failure tracking. On serverless / multi-worker
# deployments each instance has its own dict, so MAX_ATTEMPTS is enforced per
# instance rather than globally. For a hard lockout, back this with Redis or
# another shared store.
_auth_failure_store: dict[str, list[float]] = {}
PUBLIC_PATH_PREFIXES = (
    "/api/analytics",
    "/api/poker",
    "/api/craps",
    "/poker",
    "/craps",
    "/craps-strategy",
    "/login",
)
DEMO_PATH_PREFIXES = (
    "/api/stocks",
    "/api/bitcoin",
    "/api/fantasy",
    "/stock-research",
    "/bitcoin-chat",
    "/fantasy",
)
PROTECTED_PATH_PREFIXES = (
    "/docs",
    "/openapi.json",
    "/api",
    "/admin",
)
# Signed in is not enough for these — they expose logs, analytics, and the
# raw API surface, so they require the admin role specifically.
ADMIN_PATH_PREFIXES = (
    "/admin",
    "/api/admin",
    "/api/fantasy/admin",
    "/docs",
    "/openapi.json",
)


def app_auth_config():
    password = os.getenv("APP_AUTH_PASSWORD")
    if not password:
        return None
    return {
        "username": os.getenv("APP_AUTH_USERNAME", "palmer"),
        "password": password,
    }


def session_signing_secret(password: str) -> str:
    # Sign session tokens with a dedicated secret so a leaked token is not an
    # offline oracle for the account password (a token is value.HMAC(secret,
    # value); if secret == password an attacker can brute-force it offline).
    # Falls back to the password when unset to preserve existing deployments,
    # but setting APP_SESSION_SECRET decouples the two and enables rotating
    # sessions without a password change.
    return os.getenv("APP_SESSION_SECRET") or password


def basic_auth_credentials(authorization: str | None):
    if not authorization or not authorization.startswith("Basic "):
        return None

    try:
        decoded = base64.b64decode(authorization.removeprefix("Basic ")).decode("utf-8")
        username, password = decoded.split(":", 1)
        return username, password
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None


def client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            # Take the hop the trusted proxy appended (counting from the right),
            # not the leftmost entry which the client controls and can forge.
            hops = [hop.strip() for hop in forwarded_for.split(",") if hop.strip()]
            if hops:
                index = min(TRUSTED_PROXY_HOPS, len(hops))
                return hops[-index]

        for header in ("cf-connecting-ip", "x-real-ip"):
            value = request.headers.get(header)
            if value:
                return value.strip()

    return request.client.host if request.client else "unknown"


def _auth_rate_limit_key(request: Request) -> str:
    return client_ip(request)


def _recent_auth_failures(key: str, now: float | None = None) -> list[float]:
    now = time.time() if now is None else now
    cutoff = now - AUTH_RATE_LIMIT_WINDOW_SECONDS
    attempts = [t for t in _auth_failure_store.get(key, []) if t > cutoff]
    if attempts:
        _auth_failure_store[key] = attempts
    else:
        _auth_failure_store.pop(key, None)
    return attempts


def auth_rate_limited(request: Request) -> bool:
    return len(_recent_auth_failures(_auth_rate_limit_key(request))) >= AUTH_RATE_LIMIT_MAX_ATTEMPTS


def record_auth_failure(request: Request) -> None:
    key = _auth_rate_limit_key(request)
    attempts = _recent_auth_failures(key)
    attempts.append(time.time())
    _auth_failure_store[key] = attempts


def clear_auth_failures(request: Request) -> None:
    _auth_failure_store.pop(_auth_rate_limit_key(request), None)


def sweep_auth_failure_store(now: float | None = None) -> int:
    """Drop keys with no attempts left in the window.

    `_recent_auth_failures` only re-filters the key it was called with, so an
    IP that fails once and never returns leaves a stale entry behind forever.
    Called periodically to bound memory on this public surface.
    """
    now = time.time() if now is None else now
    cutoff = now - AUTH_RATE_LIMIT_WINDOW_SECONDS
    stale_keys = [key for key, attempts in _auth_failure_store.items() if not any(t > cutoff for t in attempts)]
    for key in stale_keys:
        del _auth_failure_store[key]
    return len(stale_keys)


def auth_rate_limit_response():
    return JSONResponse(
        {"error": "Too many sign-in attempts. Try again later."},
        status_code=429,
        headers={"Retry-After": str(AUTH_RATE_LIMIT_WINDOW_SECONDS)},
    )


def is_protected_path(path: str):
    if any(path == prefix or path.startswith(f"{prefix}/") for prefix in PUBLIC_PATH_PREFIXES):
        return False

    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in PROTECTED_PATH_PREFIXES)


def is_demo_path(path: str):
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in DEMO_PATH_PREFIXES)


def valid_app_credentials(authorization: str | None):
    config = app_auth_config()
    credentials = basic_auth_credentials(authorization)
    if not config or not credentials:
        return False

    username, password = credentials
    return (
        secrets.compare_digest(username, config["username"])
        and secrets.compare_digest(password, config["password"])
    )


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def _session_signature(secret: str, payload: str) -> str:
    return _base64url_encode(
        hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest()
    )


def create_app_session_token(
    username: str,
    password: str,
    now: int | None = None,
    role: str | None = None,
) -> str:
    """Mint a session token. `role=None` omits the claim, producing the
    pre-accounts token shape; the verifier reads a missing role as admin only
    when the username matches the configured admin, so cookies issued before
    member accounts existed stay valid until they expire."""
    claims = {
        "u": username,
        "exp": int(now if now is not None else time.time()) + SESSION_TTL_SECONDS,
    }
    if role is not None:
        claims["r"] = role
    payload = _base64url_encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    return f"{payload}.{_session_signature(session_signing_secret(password), payload)}"


def session_identity(request: Request) -> dict | None:
    """Resolve the `pg_session` cookie to {"username", "role"}, or None."""
    config = app_auth_config()
    if not config:
        return None

    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None

    try:
        payload, signature = token.split(".", 1)
    except ValueError:
        return None

    expected_signature = _session_signature(session_signing_secret(config["password"]), payload)
    if not secrets.compare_digest(signature, expected_signature):
        return None

    try:
        data = json.loads(_base64url_decode(payload))
    except (ValueError, json.JSONDecodeError):
        return None

    if int(data.get("exp", 0)) <= int(time.time()):
        return None

    username = str(data.get("u", ""))
    if not username:
        return None

    role = data.get("r")
    if role is None:
        # Legacy token with no role claim: only the admin could have been
        # issued one, so anything else is not trusted with a role at all.
        if not secrets.compare_digest(username, config["username"]):
            return None
        return {"username": config["username"], "role": ROLE_ADMIN}

    if role == ROLE_ADMIN:
        # An admin claim is only honored for the configured admin username,
        # so a member account named in a forged-but-unsigned way is moot and
        # a renamed admin cannot leave a stale admin token behind.
        if not secrets.compare_digest(username, config["username"]):
            return None
        return {"username": config["username"], "role": ROLE_ADMIN}

    if role == ROLE_MEMBER:
        return {"username": username, "role": ROLE_MEMBER}

    return None


def valid_app_session_cookie(request: Request) -> bool:
    return session_identity(request) is not None


def should_redirect_to_login(request: Request) -> bool:
    path = request.url.path
    if request.method not in {"GET", "HEAD"}:
        return False
    if not (path == "/admin" or path.startswith("/admin/")):
        return False

    accept = request.headers.get("accept", "")
    return "text/html" in accept or "*/*" in accept


def login_redirect(request: Request):
    next_path = request.url.path
    if request.url.query:
        next_path = f"{next_path}?{request.url.query}"
    return RedirectResponse(f"/login/?next={quote(next_path, safe='/')}", status_code=302)


def auth_challenge(request: Request):
    if should_redirect_to_login(request):
        return login_redirect(request)

    return PlainTextResponse(
        "Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": f'Basic realm="{AUTH_REALM}", charset="UTF-8"'},
    )


def is_admin_path(path: str) -> bool:
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in ADMIN_PATH_PREFIXES)


FORBIDDEN_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not your area — Palmer Gill</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf6f0; color: #23201c; font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 420px; margin: 24px; padding: 36px 32px; background: #ffffff; border: 1px solid #ece4d8; border-radius: 18px; text-align: center; box-shadow: 0 10px 30px rgba(60, 50, 35, 0.08); }
  h1 { font-size: 1.25rem; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { color: #5d574e; margin: 0 0 22px; line-height: 1.55; font-size: 0.95rem; }
  a { display: inline-block; padding: 10px 20px; border-radius: 999px; background: #5b7152; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  a:hover { background: #4c6044; }
</style>
</head>
<body>
<div class="card">
  <h1>This part is admin-only</h1>
  <p>Your account is signed in, but logs and site internals are limited to the site owner.</p>
  <a href="/">Back to projects</a>
</div>
</body>
</html>"""


def admin_required(request: Request):
    accept = request.headers.get("accept") or ""
    if request.method in {"GET", "HEAD"} and "text/html" in accept:
        return HTMLResponse(FORBIDDEN_PAGE, status_code=403)
    return JSONResponse({"error": "Admin access required"}, status_code=403)


MISSING_CONFIG_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temporarily unavailable — Palmer Gill</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf6f0; color: #23201c; font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 420px; margin: 24px; padding: 36px 32px; background: #ffffff; border: 1px solid #ece4d8; border-radius: 18px; text-align: center; box-shadow: 0 10px 30px rgba(60, 50, 35, 0.08); }
  h1 { font-size: 1.25rem; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { color: #5d574e; margin: 0 0 22px; line-height: 1.55; font-size: 0.95rem; }
  a { display: inline-block; padding: 10px 20px; border-radius: 999px; background: #5b7152; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  a:hover { background: #4c6044; }
</style>
</head>
<body>
<div class="card">
  <h1>This section is temporarily unavailable</h1>
  <p>Sign-in isn't configured on this deployment, so protected pages can't be shown right now.</p>
  <a href="/">Back to projects</a>
</div>
</body>
</html>"""


def missing_auth_config(request: Request | None = None):
    accept = (request.headers.get("accept") or "") if request is not None else ""
    if "text/html" in accept:
        return HTMLResponse(MISSING_CONFIG_PAGE, status_code=503)
    return PlainTextResponse("App authentication is not configured", status_code=503)


def safe_next_path(value: object, fallback: str = "/") -> str:
    if not isinstance(value, str) or not value:
        return fallback

    # Browsers treat backslashes as forward slashes when resolving a URL, but
    # urlsplit does not — "/\\evil.com" parses with an empty netloc and a
    # path starting with "/", passing the checks below, yet a browser
    # navigates to https://evil.com. Reject backslashes outright.
    if "\\" in value:
        return fallback

    try:
        parsed = urlsplit(value)
    except ValueError:
        return fallback

    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
        return fallback
    if parsed.path in {"/login", "/login/"}:
        return fallback

    next_path = parsed.path
    if parsed.query:
        next_path = f"{next_path}?{parsed.query}"
    if parsed.fragment:
        next_path = f"{next_path}#{parsed.fragment}"
    return next_path


def _should_record_request_analytics(path: str) -> bool:
    ignored_prefixes = (
        "/api/analytics",
        "/assets",
        "/shared",
        "/favicon.ico",
    )
    return not any(path == prefix or path.startswith(f"{prefix}/") for prefix in ignored_prefixes)


def _request_cookie(request: Request, name: str) -> str | None:
    value = request.cookies.get(name)
    return value if value and len(value) <= 120 else None


def _analytics_username(request: Request) -> str | None:
    identity = getattr(request.state, "app_user", None)
    return identity["username"] if identity else None


@app.middleware("http")
async def record_request_analytics(request: Request, call_next):
    started = time.perf_counter()
    response = None
    error_raised = False
    try:
        response = await call_next(request)
        return response
    except Exception:
        error_raised = True
        raise
    finally:
        path = request.url.path
        if _should_record_request_analytics(path):
            status_code = 500 if error_raised else getattr(response, "status_code", None)
            # Enqueue for a background worker — synchronous SQLite writes in
            # the request finalizer would serialize the event loop on the
            # write lock under load.
            _enqueue_analytics_event({
                "event_type": "request",
                "event_name": "http_request",
                "app": analytics.app_from_path(path),
                "path": path,
                "method": request.method,
                "status_code": status_code,
                "referrer": request.headers.get("referer"),
                "user_agent": request.headers.get("user-agent"),
                "ip_address": client_ip(request),
                "visitor_id": _request_cookie(request, "pg_visitor_id"),
                "session_id": _request_cookie(request, "pg_session_id"),
                "is_authenticated": bool(getattr(request.state, "app_auth_authenticated", False)),
                "is_admin": path == "/admin" or path.startswith("/admin/") or path.startswith("/api/admin"),
                "username": _analytics_username(request),
                "duration_ms": (time.perf_counter() - started) * 1000,
            })


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    # SAMEORIGIN (not DENY): /about embeds /assets/Resume2026.pdf in an iframe.
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


@app.middleware("http")
async def require_app_auth(request: Request, call_next):
    request.state.demo_mode = False
    request.state.app_auth_authenticated = False
    request.state.app_user = None

    authorization = request.headers.get("authorization")
    identity = None
    if valid_app_credentials(authorization):
        identity = {"username": app_auth_config()["username"], "role": ROLE_ADMIN}
    else:
        identity = session_identity(request)

    if identity:
        request.state.app_auth_authenticated = True
        request.state.app_user = identity
        clear_auth_failures(request)
        if identity["role"] != ROLE_ADMIN and is_admin_path(request.url.path):
            return admin_required(request)
        return await call_next(request)

    if authorization and app_auth_config() and (
        is_demo_path(request.url.path) or is_protected_path(request.url.path)
    ):
        if auth_rate_limited(request):
            return auth_rate_limit_response()
        record_auth_failure(request)
        return auth_challenge(request)

    if is_demo_path(request.url.path):
        request.state.demo_mode = True
        return await call_next(request)

    if not is_protected_path(request.url.path):
        return await call_next(request)

    if not app_auth_config():
        return missing_auth_config(request)

    return auth_challenge(request)


@app.get("/login/session")
async def login_session_status(request: Request):
    """Return the signed-in identity without exposing the HttpOnly cookie."""
    identity = getattr(request.state, "app_user", None)
    body: dict = {"authenticated": bool(identity)}
    if identity:
        body["username"] = identity["username"]
        body["role"] = identity["role"]
    body["signupEnabled"] = accounts.signup_enabled()
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def _set_session_cookie(response: JSONResponse, request: Request, username: str, role: str):
    config = app_auth_config()
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_app_session_token(username, config["password"], role=role),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return response


@app.post("/login/session")
async def login_session(request: Request):
    config = app_auth_config()
    if not config:
        return JSONResponse({"error": "App authentication is not configured"}, status_code=503)

    if auth_rate_limited(request):
        return auth_rate_limit_response()

    try:
        body = await request.json()
    except ValueError:
        record_auth_failure(request)
        return JSONResponse({"error": "Invalid login request"}, status_code=400)

    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    redirect = safe_next_path(body.get("next"))

    is_admin = (
        secrets.compare_digest(username, config["username"])
        and secrets.compare_digest(password, config["password"])
    )

    if is_admin:
        identity = {"username": config["username"], "role": ROLE_ADMIN}
    else:
        db = SessionLocal()
        try:
            user = accounts.authenticate(db, username, password)
            identity = (
                {"username": user.display_name, "role": ROLE_MEMBER} if user else None
            )
        finally:
            db.close()

    if identity is None:
        record_auth_failure(request)
        return JSONResponse({"error": "Invalid username or password"}, status_code=401)

    clear_auth_failures(request)
    response = JSONResponse(
        {
            "ok": True,
            "redirect": redirect,
            "username": identity["username"],
            "role": identity["role"],
        },
        headers={"Cache-Control": "no-store"},
    )
    return _set_session_cookie(response, request, identity["username"], identity["role"])


@app.get("/login/signup")
async def signup_status():
    """Lets the sign-in page decide whether to advertise account creation."""
    return JSONResponse(
        {"enabled": accounts.signup_enabled()},
        headers={"Cache-Control": "no-store"},
    )


@app.post("/login/signup")
async def signup(request: Request):
    config = app_auth_config()
    if not config:
        return JSONResponse({"error": "App authentication is not configured"}, status_code=503)

    # Signup is rate limited on the same counter as failed logins: it is the
    # other way to guess an invite code, and it is the expensive one to serve.
    if auth_rate_limited(request):
        return auth_rate_limit_response()

    try:
        body = await request.json()
    except ValueError:
        record_auth_failure(request)
        return JSONResponse({"error": "Invalid signup request"}, status_code=400)

    redirect = safe_next_path(body.get("next"))
    db = SessionLocal()
    try:
        accounts.check_invite_code(body.get("inviteCode"))
        user = accounts.create_user(db, body.get("username"), body.get("password"))
    except AccountError as error:
        record_auth_failure(request)
        return JSONResponse({"error": error.message}, status_code=error.status_code)
    finally:
        db.close()

    clear_auth_failures(request)
    logger.info("Created member account %s", user.username)
    response = JSONResponse(
        {
            "ok": True,
            "redirect": redirect,
            "username": user.display_name,
            "role": ROLE_MEMBER,
        },
        headers={"Cache-Control": "no-store"},
    )
    return _set_session_cookie(response, request, user.display_name, ROLE_MEMBER)


@app.post("/login/logout")
async def login_logout(request: Request):
    # POST-only: a GET endpoint that clears the session is a CSRF vector — any
    # third-party page can trigger it with a plain <img> tag. Nothing in this
    # app links to /login/logout as a GET, so there is no compatibility cost.
    response = JSONResponse({"ok": True})
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return response


# CORS - allow frontend to call backend
# Allow all origins for development (restrict in production)
allowed_origins_str = os.getenv("ALLOWED_ORIGINS", "https://palmergill.com")
if allowed_origins_str == "*":
    # Allow all origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,  # Must be False when using "*"
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    allowed_origins = [origin.strip() for origin in allowed_origins_str.split(",")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(stocks.router)
app.include_router(poker.router)
app.include_router(bitcoin.router)
app.include_router(craps.router)
app.include_router(analytics.router)
app.include_router(admin.router)
app.include_router(fantasy.router)

@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.2.1"}

# Static site serving is only enabled for local development. Production should
# treat this FastAPI app as the API service; the public site is hosted separately.
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
repo_root = os.path.abspath(os.path.join(backend_dir, ".."))
local_site_root_enabled = os.getenv("LOCAL_SITE_ROOT", "").lower() in {"1", "true", "yes"}

if local_site_root_enabled:
    for route, folder in {
        "/assets": "assets",
        "/shared": "shared",
        "/about": "about",
        "/stock-research": "stock-research",
        "/poker": "poker",
        "/craps": "craps",
        "/craps-strategy": "craps-strategy",
        "/blackjack": "blackjack",
        "/bitcoin-chat": "bitcoin-chat",
        "/fantasy": "fantasy",
        "/casino": "casino",
        "/admin": "admin",
        "/login": "login",
        "/signup": "signup",
    }.items():
        directory = os.path.join(repo_root, folder)
        if os.path.exists(directory):
            app.mount(route, StaticFiles(directory=directory, html=True), name=folder)

@app.get("/")
async def root():
    if local_site_root_enabled:
        return FileResponse(os.path.join(repo_root, "index.html"))
    return {
        "service": "Palmer Gill API",
        "status": "ok",
        "docs": "/docs",
        "health": "/health",
        "local_site": "Set LOCAL_SITE_ROOT=true to serve local static pages from this process.",
    }
