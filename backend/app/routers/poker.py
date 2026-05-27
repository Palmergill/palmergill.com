"""
Poker Game API Router - Simplified for debugging
"""
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, Dict, List
import asyncio
import json
import uuid
import os
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.poker_game import Card, Player, PokerGame, Rank, Suit
from app.poker_ai import AIManager, PERSONALITIES, PokerAI
from app.database import PokerGameState, SessionLocal

router = APIRouter(prefix="/api/poker", tags=["poker"])

# Hot in-process game cache. Each active game is also snapshotted to the DB.
games: Dict[str, PokerGame] = {}
ai_managers: Dict[str, Optional[AIManager]] = {}
game_last_accessed: Dict[str, float] = {}
ai_last_processed: Dict[str, float] = {}
player_tokens: Dict[str, Dict[str, str]] = {}

# Per-game asyncio locks serialize read-modify-write cycles on the in-process
# state above. FastAPI may schedule multiple coroutines that target the same
# game; without these locks, two requests could interleave at `await` points
# and corrupt game state (duplicate seat IDs, lost chip deltas, AI manager
# swapped out mid-turn). The guard lock protects the lookup dict itself.
_game_locks: Dict[str, asyncio.Lock] = {}
_game_locks_guard: Optional[asyncio.Lock] = None

# Per-game WebSocket subscribers. Connecting clients append their socket to
# this set; mutating endpoints call `notify_game_changed(game_id)` to fan a
# "state_changed" ping to everyone. Clients then fetch the latest state via
# the existing JSON endpoint — that keeps a single serializer (no parallel
# protocols) while collapsing perceived latency from poll cycles to ~ms.
_game_subscribers: Dict[str, set] = defaultdict(set)


def schedule_game_changed(game_id: str) -> None:
    """Sync wrapper that schedules a WS broadcast on the running loop.

    Used from sync mutation sites that already hold the per-game lock — the
    broadcast itself is fire-and-forget so it doesn't block the response.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(notify_game_changed(game_id))
    except RuntimeError:
        # No running loop (e.g. import-time call) — silently skip.
        pass


async def notify_game_changed(game_id: str) -> None:
    subs = list(_game_subscribers.get(game_id, ()))
    if not subs:
        return
    payload = {"type": "state_changed", "game_id": game_id}
    dead = []
    for ws in subs:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    if dead:
        bucket = _game_subscribers.get(game_id)
        if bucket is not None:
            for ws in dead:
                bucket.discard(ws)


def _ensure_locks_guard() -> asyncio.Lock:
    global _game_locks_guard
    if _game_locks_guard is None:
        _game_locks_guard = asyncio.Lock()
    return _game_locks_guard


async def _game_lock(game_id: str) -> asyncio.Lock:
    """Return (creating if needed) the asyncio.Lock for a game id."""
    guard = _ensure_locks_guard()
    async with guard:
        lock = _game_locks.get(game_id)
        if lock is None:
            lock = asyncio.Lock()
            _game_locks[game_id] = lock
        return lock

GAME_MAX_AGE_SECONDS = 3600
AI_TURN_MIN_INTERVAL_SECONDS = 1.5

# Simple sliding-window rate limiter: max 60 requests per minute per IP
_RATE_LIMIT_WINDOW = 60
_RATE_LIMIT_MAX = 60
_TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {"1", "true", "yes", "on"}
_rate_limit_store: Dict[str, List[float]] = defaultdict(list)
BUY_BACK_AMOUNT = 1000
BOT_AGGRESSION_BY_NAME = {
    "Shelby": 0.3,
    "Freya": 0.5,
    "Charlie": 0.7,
    "Diana": 0.6,
    "Eve": 0.4,
    # New personality-named bots from the AI personalities feature.
    "Reg": 0.7,
    "Cal": 0.2,
    "Action Jackson": 0.95,
    "Stone": 0.35,
    "Avery": 0.5,
}


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

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


def _ai_manager_for_game(game: PokerGame) -> Optional[AIManager]:
    if getattr(game, "game_type", "single") not in ("single", "tournament"):
        return None

    manager = AIManager(game)
    for player in game.players:
        if not player.is_human:
            personality = getattr(player, "ai_personality", None)
            if personality in PERSONALITIES:
                p = PERSONALITIES[personality]
                manager.bots[player.id] = PokerAI(
                    aggression=p["aggression"],
                    looseness=p["looseness"],
                    personality=personality,
                )
                player.ai_personality_label = p["label"]
            else:
                manager.bots[player.id] = PokerAI(
                    aggression=BOT_AGGRESSION_BY_NAME.get(player.name, 0.5)
                )
    return manager


def _serialize_card(card: Card) -> dict:
    return {"suit": card.suit.name, "rank": card.rank.value}


def _deserialize_card(data: dict) -> Card:
    return Card(suit=Suit[data["suit"]], rank=Rank(data["rank"]))


def _serialize_player(player: Player) -> dict:
    return {
        "id": player.id,
        "name": player.name,
        "chips": player.chips,
        "hand": [_serialize_card(card) for card in player.hand],
        "bet": player.bet,
        "total_bet": player.total_bet,
        "folded": player.folded,
        "is_all_in": player.is_all_in,
        "is_human": player.is_human,
        "ai_personality": player.ai_personality,
        "ai_personality_label": player.ai_personality_label,
    }


def _deserialize_player(data: dict) -> Player:
    return Player(
        id=data["id"],
        name=data["name"],
        chips=data["chips"],
        hand=[_deserialize_card(card) for card in data.get("hand", [])],
        bet=data.get("bet", 0),
        total_bet=data.get("total_bet", 0),
        folded=data.get("folded", False),
        is_all_in=data.get("is_all_in", False),
        is_human=data.get("is_human", False),
        ai_personality=data.get("ai_personality"),
        ai_personality_label=data.get("ai_personality_label"),
    )


def _serialize_game(game: PokerGame) -> dict:
    return {
        "game_id": game.game_id,
        "players": [_serialize_player(player) for player in game.players],
        "deck": [_serialize_card(card) for card in game.deck.cards],
        "community_cards": [_serialize_card(card) for card in game.community_cards],
        "pot": game.pot,
        "current_bet": game.current_bet,
        "dealer_index": game.dealer_index,
        "current_player_index": game.current_player_index,
        "small_blind": game.small_blind,
        "big_blind": game.big_blind,
        "phase": game.phase,
        "round_bets": game.round_bets,
        "min_raise": game.min_raise,
        "winners": game.winners,
        "last_action": game.last_action,
        "last_ai_action": game.last_ai_action,
        "hand_number": game.hand_number,
        "acted_this_round": list(game.acted_this_round),
        "round_start_player": game.round_start_player,
        "game_type": getattr(game, "game_type", "single"),
        "max_players": getattr(game, "max_players", 6),
        "waiting_for_players": getattr(game, "waiting_for_players", False),
        "tournament": getattr(game, "tournament", None),
    }


def _deserialize_game(data: dict) -> PokerGame:
    game = PokerGame(data["game_id"])
    game.players = [_deserialize_player(player) for player in data.get("players", [])]
    game.deck.cards = [_deserialize_card(card) for card in data.get("deck", [])]
    game.community_cards = [_deserialize_card(card) for card in data.get("community_cards", [])]
    game.pot = data.get("pot", 0)
    game.current_bet = data.get("current_bet", 0)
    game.dealer_index = data.get("dealer_index", 0)
    game.current_player_index = data.get("current_player_index", 0)
    game.small_blind = data.get("small_blind", 10)
    game.big_blind = data.get("big_blind", 20)
    game.phase = data.get("phase", "waiting")
    game.round_bets = data.get("round_bets", {})
    game.min_raise = data.get("min_raise", game.big_blind)
    game.winners = data.get("winners", [])
    game.last_action = data.get("last_action")
    game.last_ai_action = data.get("last_ai_action")
    game.hand_number = data.get("hand_number", 0)
    game.acted_this_round = set(data.get("acted_this_round", []))
    game.round_start_player = data.get("round_start_player", 0)
    game.game_type = data.get("game_type", "single")
    game.max_players = data.get("max_players", 6)
    game.waiting_for_players = data.get("waiting_for_players", False)
    game.tournament = data.get("tournament")
    return game


def save_game_state(game_id: str, *, broadcast: bool = True) -> None:
    game = games.get(game_id)
    if not game:
        return

    payload = json.dumps(
        {
            "game": _serialize_game(game),
            "player_tokens": player_tokens.get(game_id, {}),
            "game_last_accessed": game_last_accessed.get(game_id, time.time()),
            "ai_last_processed": ai_last_processed.get(game_id, 0),
        },
        separators=(",", ":"),
    ).encode("utf-8")

    db = SessionLocal()
    try:
        row = db.get(PokerGameState, game_id)
        if row is None:
            row = PokerGameState(game_id=game_id, payload=payload)
            db.add(row)
        else:
            row.payload = payload
            row.updated_at = utc_now()
        db.commit()
    finally:
        db.close()

    if broadcast:
        schedule_game_changed(game_id)


def load_game_state(game_id: str) -> bool:
    if game_id in games:
        return True

    db = SessionLocal()
    try:
        row = db.get(PokerGameState, game_id)
        if row is None:
            return False

        data = json.loads(row.payload.decode("utf-8"))
        game = _deserialize_game(data["game"])
        games[game_id] = game
        player_tokens[game_id] = data.get("player_tokens", {})
        game_last_accessed[game_id] = data.get("game_last_accessed", time.time())
        ai_last_processed[game_id] = data.get("ai_last_processed", 0)
        ai_managers[game_id] = _ai_manager_for_game(game)
        return True
    finally:
        db.close()


def cleanup_old_games():
    """Remove games that haven't been accessed in a while"""
    current_time = time.time()
    games_to_remove = []
    for game_id, last_access in list(game_last_accessed.items()):
        if current_time - last_access > GAME_MAX_AGE_SECONDS:
            games_to_remove.append(game_id)
    for game_id in games_to_remove:
        # Skip games with in-flight requests; next cleanup pass will catch them.
        lock = _game_locks.get(game_id)
        if lock is not None and lock.locked():
            continue
        games.pop(game_id, None)
        ai_managers.pop(game_id, None)
        ai_last_processed.pop(game_id, None)
        game_last_accessed.pop(game_id, None)
        player_tokens.pop(game_id, None)
        _game_locks.pop(game_id, None)

    persisted_removed = 0
    db = SessionLocal()
    try:
        cutoff = utc_now() - timedelta(seconds=GAME_MAX_AGE_SECONDS)
        stale_rows = db.query(PokerGameState).filter(PokerGameState.updated_at < cutoff).all()
        for row in stale_rows:
            db.delete(row)
            persisted_removed += 1
        if persisted_removed:
            db.commit()
    finally:
        db.close()

    return len(games_to_remove) + persisted_removed

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


def process_ai_turn_if_needed(game_id: str, game: PokerGame) -> bool:
    """Advance one AI turn for AI-backed games when the current actor is a bot."""
    is_ai_game = getattr(game, 'game_type', 'single') in ('single', 'tournament')
    if not is_ai_game or game.phase in ('showdown', 'waiting'):
        return False

    active = [p for p in game.players if not p.folded and not p.is_all_in]
    if len(active) <= 1:
        game._advance_phase()
        return True

    current = game.get_current_player()
    if current and not current.is_human:
        now = time.time()
        if now - ai_last_processed.get(game_id, 0) < AI_TURN_MIN_INTERVAL_SECONDS:
            return False

        ai_manager = ai_managers.get(game_id)
        if ai_manager:
            ai_manager.process_bot_turn()
            ai_last_processed[game_id] = now
            return True

    return False


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
    """Compatibility endpoint for older poker clients.

    The active API authorizes player actions with per-player tokens, not CSRF
    cookies. New clients do not need this endpoint.
    """
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
    if request.game_type not in ("single", "multiplayer", "tournament"):
        raise HTTPException(status_code=400, detail="Unsupported game type")

    game_id = str(uuid.uuid4())[:8]
    game = PokerGame(game_id)
    game.game_type = request.game_type
    game.max_players = request.max_players

    # Add first player
    human = game.add_player(normalize_player_name(request.player_name), is_human=True)
    player_token = create_player_token(game_id, human.id)

    if request.game_type in ("single", "tournament"):
        # Add AI bots with named personalities so each opponent plays differently.
        # The roster mixes archetypes — one of each plus a TAG variant — to
        # give a single-table experience the feel of a real mixed lineup.
        ai_manager = AIManager(game)
        ai_manager.add_bot("Reg",            personality="tag")
        ai_manager.add_bot("Cal",            personality="lp")
        ai_manager.add_bot("Action Jackson", personality="mn")
        ai_manager.add_bot("Stone",          personality="rock")
        ai_manager.add_bot("Avery",          personality="std")

        if request.game_type == "tournament":
            game.configure_tournament()

        game.start_hand()
        games[game_id] = game
        ai_managers[game_id] = ai_manager
        update_game_access(game_id)
        cleanup_old_games()
        save_game_state(game_id)

        return {
            "game_id": game_id,
            "player_id": human.id,
            "player_token": player_token,
            "state": game.to_dict(for_player=human.id),
            "game_type": request.game_type,
        }
    else:
        # Multiplayer - waiting for players
        games[game_id] = game
        ai_managers[game_id] = None
        update_game_access(game_id)
        cleanup_old_games()
        save_game_state(game_id)

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
    lock = await _game_lock(request.game_id)
    async with lock:
        if not load_game_state(request.game_id):
            raise HTTPException(status_code=404, detail="Game not found")

        game = games[request.game_id]

        if getattr(game, 'game_type', 'single') != "multiplayer":
            raise HTTPException(status_code=400, detail="Cannot join single player game")

        if len(game.players) >= getattr(game, 'max_players', 6):
            raise HTTPException(status_code=400, detail="Game is full")

        # Only the lobby phase accepts new joiners; in_progress / showdown / etc. all reject.
        if game.phase != 'waiting':
            raise HTTPException(status_code=400, detail="Game already started")

        # Add new player
        player = game.add_player(normalize_player_name(request.player_name), is_human=True)
        player_token = create_player_token(request.game_id, player.id)
        update_game_access(request.game_id)
        save_game_state(request.game_id)

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
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
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
        save_game_state(game_id)

        return game.to_dict(for_player=request.player_id)

@router.get("/games/{game_id}")
async def get_game_state(
    game_id: str,
    player_id: str,
    player_token: Optional[str] = Header(None, alias="X-Player-Token"),
    process_ai: bool = True,
):
    """Get current game state"""
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
            raise HTTPException(status_code=404, detail="Game not found")

        game = games[game_id]
        require_player_token(game_id, player_id, player_token)
        update_game_access(game_id)
        save_game_state(game_id, broadcast=False)

        # The process_ai query parameter is retained for old clients, but GET is
        # intentionally read-only. Use POST /process-ai to advance a bot turn.

        return game.to_dict(for_player=player_id)


@router.post("/games/{game_id}/process-ai")
async def process_ai_turn(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Advance at most one AI turn for a single-player game."""
    _require_rate_limit(http_request)
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
            raise HTTPException(status_code=404, detail="Game not found")

        game = games[game_id]
        require_player_token(game_id, request.player_id, request.player_token)
        update_game_access(game_id)
        changed = process_ai_turn_if_needed(game_id, game)
        save_game_state(game_id, broadcast=changed)

        return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/action")
async def player_action(game_id: str, http_request: Request, request: ActionRequest):
    """Execute player action"""
    _require_rate_limit(http_request)
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
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

        save_game_state(game_id)
        return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/buy-back")
async def buy_back(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Add chips for a busted player before the next hand."""
    _require_rate_limit(http_request)
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
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
        save_game_state(game_id)
        return game.to_dict(for_player=request.player_id)

@router.post("/games/{game_id}/next-hand")
async def next_hand(game_id: str, http_request: Request, request: PlayerAuthRequest):
    """Start next hand"""
    _require_rate_limit(http_request)
    lock = await _game_lock(game_id)
    async with lock:
        if not load_game_state(game_id):
            raise HTTPException(status_code=404, detail="Game not found")

        game = games[game_id]
        require_player_token(game_id, request.player_id, request.player_token)

        if game.phase not in ('showdown', 'waiting'):
            raise HTTPException(status_code=400, detail="Hand still in progress")

        game.dealer_index = (game.dealer_index + 1) % len(game.players)
        game.start_hand()
        update_game_access(game_id)
        save_game_state(game_id)

        return game.to_dict(for_player=request.player_id)

@router.get("/health")
async def health_check():
    """Health check endpoint"""
    cleaned = cleanup_old_games()
    return {"status": "ok", "active_games": len(games), "cleaned_games": cleaned}


@router.websocket("/games/{game_id}/ws")
async def game_ws(websocket: WebSocket, game_id: str):
    """WebSocket push channel for a poker game.

    Clients connect after they've joined a game and receive a
    ``{"type":"state_changed"}`` ping whenever a mutating action lands. The
    client should then issue a regular GET against ``/games/{game_id}`` to
    pull the latest state — this keeps a single serializer in play and lets
    the existing polling code be a fallback when WS is unavailable.

    Auth note: the WS is read-only (server -> client) and only emits a
    notification; the actual state payload still requires the player token
    via the GET endpoint, so eavesdropping on the WS leaks nothing more than
    "this game changed."
    """
    await websocket.accept()
    bucket = _game_subscribers[game_id]
    bucket.add(websocket)
    try:
        # Greet with one ping so the client can immediately fetch the latest
        # state without waiting for the next mutation.
        await websocket.send_json({"type": "hello", "game_id": game_id})
        while True:
            # We don't expect inbound traffic — but receive_text keeps the
            # connection alive and surfaces disconnects promptly.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        bucket.discard(websocket)
        if not bucket:
            _game_subscribers.pop(game_id, None)
