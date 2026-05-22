import asyncio
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from app.database_migration import init_db_with_migration
from app.log_handler import install_db_logging
from app.routers import admin, bitcoin, stocks, poker
import os

logger = logging.getLogger(__name__)


async def _periodic_game_cleanup(interval: int = 300) -> None:
    """Prune stale poker games every `interval` seconds."""
    while True:
        await asyncio.sleep(interval)
        try:
            removed = poker.cleanup_old_games()
            if removed:
                logger.info("Cleaned up %d stale poker game(s)", removed)
        except Exception:
            logger.exception("Error during periodic game cleanup")

app = FastAPI(title="Palmer Gill API", version="0.2.0-p5")

AUTH_REALM = "Palmer Gill Apps"
SESSION_COOKIE_NAME = "pg_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
PUBLIC_PATH_PREFIXES = (
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


def basic_auth_credentials(authorization: str | None):
    if not authorization or not authorization.startswith("Basic "):
        return None

    try:
        decoded = base64.b64decode(authorization.removeprefix("Basic ")).decode("utf-8")
        username, password = decoded.split(":", 1)
        return username, password
    except (ValueError, UnicodeDecodeError):
        return None


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
    return f"{payload}.{_session_signature(password, payload)}"


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

    expected_signature = _session_signature(config["password"], payload)
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


@app.middleware("http")
async def require_app_auth(request: Request, call_next):
    request.state.demo_mode = False
    request.state.app_auth_authenticated = False

    authorization = request.headers.get("authorization")
    if valid_app_credentials(authorization) or valid_app_session_cookie(request):
        request.state.app_auth_authenticated = True
        return await call_next(request)

    if authorization and app_auth_config() and (
        is_demo_path(request.url.path) or is_protected_path(request.url.path)
    ):
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

    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "Invalid login request"}, status_code=400)

    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if not (
        secrets.compare_digest(username, config["username"])
        and secrets.compare_digest(password, config["password"])
    ):
        return JSONResponse({"error": "Invalid username or password"}, status_code=401)

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

@app.on_event("startup")
async def startup():
    init_db_with_migration()
    install_db_logging()
    asyncio.create_task(_periodic_game_cleanup())

app.include_router(stocks.router)
app.include_router(poker.router)
app.include_router(bitcoin.router)
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
