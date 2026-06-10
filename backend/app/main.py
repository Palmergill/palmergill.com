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
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from app.database import SessionLocal
from app.database_migration import init_db_with_migration
from app.log_handler import install_db_logging
from app.routers import admin, analytics, bitcoin, stocks, poker
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
    try:
        yield
    finally:
        cleanup_task.cancel()
        analytics_cleanup_task.cancel()
        analytics_writer_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        with suppress(asyncio.CancelledError):
            await analytics_cleanup_task
        with suppress(asyncio.CancelledError):
            await analytics_writer_task


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
    "/poker",
    "/craps",
    "/login",
)
DEMO_PATH_PREFIXES = (
    "/api/stocks",
    "/api/bitcoin",
    "/stock-research",
    "/bitcoin-chat",
)
PROTECTED_PATH_PREFIXES = (
    "/docs",
    "/openapi.json",
    "/api",
    "/admin",
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


def create_app_session_token(username: str, password: str, now: int | None = None) -> str:
    payload = _base64url_encode(
        json.dumps(
            {
                "u": username,
                "exp": int(now if now is not None else time.time()) + SESSION_TTL_SECONDS,
            },
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return f"{payload}.{_session_signature(session_signing_secret(password), payload)}"


def valid_app_session_cookie(request: Request) -> bool:
    config = app_auth_config()
    if not config:
        return False

    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return False

    try:
        payload, signature = token.split(".", 1)
    except ValueError:
        return False

    expected_signature = _session_signature(session_signing_secret(config["password"]), payload)
    if not secrets.compare_digest(signature, expected_signature):
        return False

    try:
        data = json.loads(_base64url_decode(payload))
    except (ValueError, json.JSONDecodeError):
        return False

    return (
        secrets.compare_digest(str(data.get("u", "")), config["username"])
        and int(data.get("exp", 0)) > int(time.time())
    )


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


def missing_auth_config():
    return PlainTextResponse("App authentication is not configured", status_code=503)


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
    if not getattr(request.state, "app_auth_authenticated", False):
        return None
    config = app_auth_config()
    return config["username"] if config else None


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
    "X-Frame-Options": "DENY",
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

    authorization = request.headers.get("authorization")
    if valid_app_credentials(authorization) or valid_app_session_cookie(request):
        request.state.app_auth_authenticated = True
        clear_auth_failures(request)
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
        return missing_auth_config()

    return auth_challenge(request)


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
    if not (
        secrets.compare_digest(username, config["username"])
        and secrets.compare_digest(password, config["password"])
    ):
        record_auth_failure(request)
        return JSONResponse({"error": "Invalid username or password"}, status_code=401)

    clear_auth_failures(request)
    response = JSONResponse({"ok": True, "redirect": "/admin/"})
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_app_session_token(config["username"], config["password"]),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return response


@app.api_route("/login/logout", methods=["GET", "POST"])
async def login_logout(request: Request):
    if request.method == "GET":
        response = RedirectResponse("/login/", status_code=302)
    else:
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
app.include_router(analytics.router)
app.include_router(admin.router)

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
        "/blackjack": "blackjack",
        "/bitcoin-chat": "bitcoin-chat",
        "/casino": "casino",
        "/admin": "admin",
        "/login": "login",
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
