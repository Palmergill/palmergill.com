"""
Poker Game API Router - Simplified for debugging
"""
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, Dict, List
import uuid
import os
import secrets
import time
from collections import defaultdict

from app.poker_game import PokerGame
from app.poker_ai import AIManager

router = APIRouter(prefix="/api/poker", tags=["poker"])

# In-memory game storage
games: Dict[str, PokerGame] = {}
ai_managers: Dict[str, Optional[AIManager]] = {}
game_last_accessed: Dict[str, float] = {}
ai_last_processed: Dict[str, float] = {}
player_tokens: Dict[str, Dict[str, str]] = {}

GAME_MAX_AGE_SECONDS = 3600
AI_TURN_MIN_INTERVAL_SECONDS = 1.5

# Simple sliding-window rate limiter: max 60 requests per minute per IP
_RATE_LIMIT_WINDOW = 60
_RATE_LIMIT_MAX = 60
_TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {"1", "true", "yes", "on"}
_rate_limit_store: Dict[str, List[float]] = defaultdict(list)
BUY_BACK_AMOUNT = 1000

def _client_ip(request: Request) -> str:
    if _TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            first_ip = forwarded_for.split(",", 1)[0].strip()
            if first_ip:
                return first_ip

        for header in ("cf-connecting-ip", "x-real-ip"):
            value = request.headers.get(header)
            if value:
                return value.strip()

    return request.client.host if request.client else "unknown"

def _check_rate_limit(client_ip: str) -> bool:
    now = time.time()
    cutoff = now - _RATE_LIMIT_WINDOW
    timestamps = _rate_limit_store[client_ip]
    _rate_limit_store[client_ip] = [t for t in timestamps if t > cutoff]
    if len(_rate_limit_store[client_ip]) >= _RATE_LIMIT_MAX:
        return False
    _rate_limit_store[client_ip].append(now)
    return True

def _require_rate_limit(request: Request) -> None:
    if not _check_rate_limit(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many requests")

def cleanup_old_games():
    """Remove games that haven't been accessed in a while"""
    current_time = time.time()
    games_to_remove = []
    for game_id, last_access in list(game_last_accessed.items()):
        if current_time - last_access > GAME_MAX_AGE_SECONDS:
            games_to_remove.append(game_id)
    for game_id in games_to_remove:
        games.pop(game_id, None)
        ai_managers.pop(game_id, None)
        ai_last_processed.pop(game_id, None)
        game_last_accessed.pop(game_id, None)
        player_tokens.pop(game_id, None)
    return len(games_to_remove)

def update_game_access(game_id: str):
    """Update last access time for a game"""
    game_last_accessed[game_id] = time.time()


def normalize_player_name(name: str) -> str:
    cleaned = " ".join((name or "Player").strip().split()) or "Player"
    if any(char in cleaned for char in "<>") or any(ord(char) < 32 for char in cleaned):
        raise HTTPException(status_code=400, detail="Player name contains unsupported characters")
    return cleaned[:32]


def create_player_token(game_id: str, player_id: str) -> str:
    token = secrets.token_urlsafe(24)
    player_tokens.setdefault(game_id, {})[player_id] = token
    return token


def require_player_token(game_id: str, player_id: str, player_token: Optional[str]) -> None:
    expected = player_tokens.get(game_id, {}).get(player_id)
    if not expected or not player_token or not secrets.compare_digest(expected, player_token):
        raise HTTPException(status_code=403, detail="Invalid player token")


def process_ai_turn_if_needed(game_id: str, game: PokerGame) -> None:
    """Advance one AI turn for single-player games when the current actor is a bot."""
    is_single_player = getattr(game, 'game_type', 'single') == 'single'
    if not is_single_player or game.phase in ('showdown', 'waiting'):
        return

    active = [p for p in game.players if not p.folded and not p.is_all_in]
    if len(active) <= 1:
        game._advance_phase()
        return

    current = game.get_current_player()
    if current and not current.is_human:
        now = time.time()
        if now - ai_last_processed.get(game_id, 0) < AI_TURN_MIN_INTERVAL_SECONDS:
            return

        ai_manager = ai_managers.get(game_id)
        if ai_manager:
            ai_manager.process_bot_turn()
            ai_last_processed[game_id] = now


class CreateGameRequest(BaseModel):
    player_name: str = Field("Player", max_length=48)
    game_type: str = "single"
    max_players: int = Field(6, ge=2, le=6)

class JoinGameRequest(BaseModel):
    game_id: str
    player_name: str = Field("Player", max_length=48)

class ActionRequest(BaseModel):
    player_id: str
    player_token: str
    action: str
    amount: Optional[int] = None

class PlayerAuthRequest(BaseModel):
    player_id: str
    player_token: str

@router.get("/csrf-token")
async def get_csrf_token():
    """Set a CSRF cookie for the frontend double-submit pattern."""
    token = secrets.token_urlsafe(32)
    response = JSONResponse({"ok": True})
    response.set_cookie(
        key="csrf_token",
        value=token,
        httponly=False,  # JS must be able to read it
        samesite="strict",
        secure=True,
        max_age=3600,
    )
    return response

@router.post("/games")
async def create_game(http_request: Request, request: CreateGameRequest):
    """Create a new poker game"""
    _require_rate_limit(http_request)
    if request.game_type not in ("single", "multiplayer"):
        raise HTTPException(status_code=400, detail="Unsupported game type")

    game_id = str(uuid.uuid4())[:8]
    game = PokerGame(game_id)
    game.game_type = request.game_type
    game.max_players = request.max_players

    # Add first player
    human = game.add_player(normalize_player_name(request.player_name), is_human=True)
    player_token = create_player_token(game_id, human.id)

    if request.game_type == "single":
        # Add AI bots
        ai_manager = AIManager(game)
        ai_manager.add_bot("Shelby", aggression=0.3)
        ai_manager.add_bot("Freya", aggression=0.5)
        ai_manager.add_bot("Charlie", aggression=0.7)
        ai_manager.add_bot("Diana", aggression=0.6)
        ai_manager.add_bot("Eve", aggression=0.4)

        game.start_hand()
        games[game_id] = game
        ai_managers[game_id] = ai_manager
        update_game_access(game_id)
        cleanup_old_games()

        return {
            "game_id": game_id,
            "player_id": human.id,
            "player_token": player_token,
            "state": game.to_dict(for_player=human.id),
            "game_type": "single"
        }
    else:
        # Multiplayer - waiting for players
        games[game_id] = game
        ai_managers[game_id] = None
        update_game_access(game_id)
        cleanup_old_games()

        return {
            "game_id": game_id,
            "player_id": human.id,
            "player_token": player_token,
            "state": game.to_dict(for_player=human.id),
            "game_type": "multiplayer",
            "players": [p.to_dict() for p in game.players],
            "waiting": True
        }

@router.post("/games/join")
async def join_game(http_request: Request, request: JoinGameRequest):
    """Join an existing multiplayer game"""
    _require_rate_limit(http_request)
    if request.game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[request.game_id]

    if getattr(game, 'game_type', 'single') != "multiplayer":
        raise HTTPException(status_code=400, detail="Cannot join single player game")

    if len(game.players) >= getattr(game, 'max_players', 6):
        raise HTTPException(status_code=400, detail="Game is full")

    if game.phase != 'waiting':
        raise HTTPException(status_code=400, detail="Game already started")

    # Add new player
    player = game.add_player(normalize_player_name(request.player_name), is_human=True)
    player_token = create_player_token(request.game_id, player.id)
    update_game_access(request.game_id)

    return {
        "game_id": request.game_id,
        "player_id": player.id,
        "player_token": player_token,
        "state": game.to_dict(for_player=player.id),
        "players": [p.to_dict() for p in game.players],
        "waiting": len(game.players) < 2
    }

@router.post("/games/{game_id}/start")
async def start_multiplayer_game(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Start a multiplayer game (host only)"""
    _require_rate_limit(http_request)
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, request.player_id, request.player_token)

    if getattr(game, 'game_type', 'single') != "multiplayer":
        raise HTTPException(status_code=400, detail="Not a multiplayer game")

    if len(game.players) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 players")

    if game.players[0].id != request.player_id:
        raise HTTPException(status_code=403, detail="Only host can start")

    game.waiting_for_players = False
    game.start_hand()
    update_game_access(game_id)

    return game.to_dict(for_player=request.player_id)

@router.get("/games/{game_id}")
async def get_game_state(
    game_id: str,
    player_id: str,
    player_token: Optional[str] = Header(None, alias="X-Player-Token"),
    process_ai: bool = True,
):
    """Get current game state"""
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, player_id, player_token)
    update_game_access(game_id)

    # The process_ai query parameter is retained for old clients, but GET is
    # intentionally read-only. Use POST /process-ai to advance a bot turn.

    return game.to_dict(for_player=player_id)


@router.post("/games/{game_id}/process-ai")
async def process_ai_turn(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Advance at most one AI turn for a single-player game."""
    _require_rate_limit(http_request)
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, request.player_id, request.player_token)
    update_game_access(game_id)
    process_ai_turn_if_needed(game_id, game)

    return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/action")
async def player_action(game_id: str, http_request: Request, request: ActionRequest):
    """Execute player action"""
    _require_rate_limit(http_request)
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, request.player_id, request.player_token)
    update_game_access(game_id)

    current = game.get_current_player()
    if not current or current.id != request.player_id:
        raise HTTPException(status_code=400, detail="Not your turn")

    success = False
    if request.action == "fold":
        success = game.action_fold(request.player_id)
    elif request.action == "check":
        success = game.action_check(request.player_id)
    elif request.action == "call":
        success = game.action_call(request.player_id)
    elif request.action == "raise":
        if request.amount is None:
            raise HTTPException(status_code=400, detail="Amount required")
        success = game.action_raise(request.player_id, request.amount)

    if not success:
        raise HTTPException(status_code=400, detail="Action failed")

    return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/buy-back")
async def buy_back(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Add chips for a busted player before the next hand."""
    _require_rate_limit(http_request)
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, request.player_id, request.player_token)
    player = game._get_player(request.player_id)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    if game.phase not in ('showdown', 'waiting'):
        raise HTTPException(status_code=400, detail="Buy-back is only available between hands")

    if player.chips > 0:
        raise HTTPException(status_code=400, detail="Buy-back is only available for busted players")

    player.chips = BUY_BACK_AMOUNT
    player.is_all_in = False

    update_game_access(game_id)
    return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/next-hand")
async def next_hand(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Start next hand"""
    _require_rate_limit(http_request)
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    require_player_token(game_id, request.player_id, request.player_token)

    if game.phase not in ('showdown', 'waiting'):
        raise HTTPException(status_code=400, detail="Hand still in progress")

    game.dealer_index = (game.dealer_index + 1) % len(game.players)
    game.start_hand()

    return game.to_dict(for_player=request.player_id)

@router.get("/health")
async def health_check():
    """Health check endpoint"""
    cleaned = cleanup_old_games()
    return {"status": "ok", "active_games": len(games), "cleaned_games": cleaned}
