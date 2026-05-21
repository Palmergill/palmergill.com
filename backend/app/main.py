import asyncio
import base64
import logging
import secrets

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, PlainTextResponse
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
PUBLIC_PATH_PREFIXES = (
    "/api/poker",
    "/poker",
    "/craps",
)
PROTECTED_PATH_PREFIXES = (
    "/docs",
    "/openapi.json",
    "/api",
    "/stock-research",
    "/bitcoin-chat",
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


def auth_challenge():
    return PlainTextResponse(
        "Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": f'Basic realm="{AUTH_REALM}", charset="UTF-8"'},
    )


def missing_auth_config():
    return PlainTextResponse("App authentication is not configured", status_code=503)


@app.middleware("http")
async def require_app_auth(request: Request, call_next):
    if not is_protected_path(request.url.path):
        return await call_next(request)

    config = app_auth_config()
    if not config:
        return missing_auth_config()

    credentials = basic_auth_credentials(request.headers.get("authorization"))
    if not credentials:
        return auth_challenge()

    username, password = credentials
    if not (
        secrets.compare_digest(username, config["username"])
        and secrets.compare_digest(password, config["password"])
    ):
        return auth_challenge()

    return await call_next(request)

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
        "/admin": "admin",
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
