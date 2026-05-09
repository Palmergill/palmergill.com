"""
Poker Game API - FastAPI Backend
"""
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, field_validator
from typing import Optional, Dict, List, Any
import uuid
import asyncio
import re
import time
from collections import defaultdict
from datetime import datetime

from .game import PokerGame
from .ai import AIManager
from .config import Config, get_logger, set_correlation_id, clear_correlation_id
from .metrics import metrics_manager
from .monitoring import performance_middleware, performance_monitor
from .adaptive_ai import adaptive_ai_manager
from .analytics import usage_analytics
from .persistence import persistence, GamePersistence
from .game_integrity import integrity_manager
from .csrf import CSRFMiddleware, get_csrf_token
from .tournament import tournament_manager, TournamentStatus

# Setup logging
logger = get_logger()

# =============================================================================
# Sentry Error Tracking Setup
# =============================================================================
if Config.SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        
        sentry_sdk.init(
            dsn=Config.SENTRY_DSN,
            environment=Config.SENTRY_ENVIRONMENT,
            traces_sample_rate=Config.SENTRY_TRACES_SAMPLE_RATE,
            profiles_sample_rate=0.1,
            integrations=[
                StarletteIntegration(
                    transaction_style="endpoint"
                ),
                FastApiIntegration(
                    transaction_style="endpoint"
                ),
            ],
        )
        logger.info(f"Sentry initialized for environment: {Config.SENTRY_ENVIRONMENT}")
    except ImportError:
        logger.warning("Sentry SDK not installed, error tracking disabled")
    except Exception as e:
        logger.error(f"Failed to initialize Sentry: {e}")

# =============================================================================
# Response Models
# =============================================================================

class PlayerInfo(BaseModel):
    """Player information in game state"""
    id: str = Field(..., description="Unique player identifier")
    name: str = Field(..., description="Player display name")
    chips: int = Field(..., description="Current chip stack", ge=0)
    bet: int = Field(..., description="Current bet in the pot", ge=0)
    folded: bool = Field(..., description="Whether player has folded")
    is_human: bool = Field(..., description="True if human player, False if AI")
    is_dealer: bool = Field(..., description="True if player is the dealer")
    is_small_blind: bool = Field(..., description="True if player posted small blind")
    is_big_blind: bool = Field(..., description="True if player posted big blind")
    is_all_in: bool = Field(..., description="True if player is all-in")
    cards: Optional[List[dict]] = Field(None, description="Player's hole cards (visible to player only)")
    avatar: Optional[str] = Field(None, description="Player avatar emoji")


class PotInfo(BaseModel):
    """Pot information"""
    amount: int = Field(..., description="Total amount in pot", ge=0)
    eligible_players: List[str] = Field(..., description="Player IDs eligible to win this pot")


class LastActionInfo(BaseModel):
    """Most recent poker action"""
    player: str = Field(..., description="Name of the player who acted")
    action: str = Field(..., description="Action taken: fold, check, call, raise, or all-in")
    amount: Optional[int] = Field(None, description="Amount associated with the action, when applicable", ge=0)


class GameState(BaseModel):
    """Complete game state response"""
    game_id: str = Field(..., description="Unique game identifier")
    phase: str = Field(..., description="Current game phase: preflop, flop, turn, river, showdown, waiting")
    hand_number: int = Field(..., description="Current hand number", ge=0)
    community_cards: List[dict] = Field(..., description="Community cards on the table")
    pot: int = Field(..., description="Main pot amount", ge=0)
    current_bet: int = Field(..., description="Current bet to call", ge=0)
    min_raise: int = Field(..., description="Minimum raise amount", ge=0)
    players: List[dict] = Field(..., description="All players in the game (with cards hidden for opponents)")
    current_player: Optional[str] = Field(None, description="ID of player whose turn it is")
    dealer_index: int = Field(..., description="Index of dealer button")
    last_action: Optional[LastActionInfo] = Field(None, description="Most recent action taken")
    winners: Optional[List[dict]] = Field(None, description="Winners from showdown with amounts won")
    action_token: Optional[str] = Field(None, description="Token required for next action (anti-replay)")


class CreateGameRequest(BaseModel):
    """Request to create a new game"""
    player_name: str = Field(
        default="Player",
        min_length=1,
        max_length=20,
        description="Player's display name (1-20 characters)",
        examples=["Alice", "PokerPro99"]
    )

    @field_validator('player_name')
    @classmethod
    def sanitize_player_name(cls, v: str) -> str:
        # Trim whitespace
        v = v.strip()
        # Remove control characters and restrict to printable ASCII
        v = ''.join(c for c in v if c.isprintable() and ord(c) < 128)
        # Collapse multiple spaces
        v = ' '.join(v.split())
        return v[:20]  # Ensure max length


class CreateGameResponse(BaseModel):
    """Response after creating a new game"""
    game_id: str = Field(..., description="Unique game identifier (8 characters)")
    player_id: str = Field(..., description="Player's unique identifier")
    state: GameState = Field(..., description="Initial game state")
    session_id: str = Field(..., description="Analytics session identifier")


class ActionRequest(BaseModel):
    """Player action request"""
    player_id: str = Field(
        ...,
        min_length=1,
        max_length=10,
        description="Player's unique identifier",
        examples=["p1a2b3c4d"]
    )
    action: str = Field(
        ...,
        pattern=r'^(fold|check|call|raise)$',
        description="Action to take: fold, check, call, or raise",
        examples=["call", "raise"]
    )
    amount: Optional[int] = Field(
        default=None,
        ge=0,
        le=1000000,
        description="Raise amount (required only for raise action)",
        examples=[100, 500]
    )
    action_token: Optional[str] = Field(
        default=None,
        description="Anti-replay token from game state (required when it's player's turn)",
        examples=["a1b2c3d4e5f67890"]
    )

    @field_validator('player_id')
    @classmethod
    def validate_player_id(cls, v: str) -> str:
        if not re.match(r'^[a-zA-Z0-9]+$', v):
            raise ValueError('Player ID must be alphanumeric')
        return v


class BuyBackRequest(BaseModel):
    """Request to add chips between hands"""
    player_id: str = Field(..., min_length=1, max_length=10)
    amount: int = Field(default=1000, gt=0, le=1000000)

    @field_validator('player_id')
    @classmethod
    def validate_player_id(cls, v: str) -> str:
        if not re.match(r'^[a-zA-Z0-9]+$', v):
            raise ValueError('Player ID must be alphanumeric')
        return v


class ActionResponse(GameState):
    """Response after player action (includes AI turn processing)"""
    pass


class HealthStatus(BaseModel):
    """Health check response"""
    status: str = Field(..., description="API status: 'ok' if healthy")
    active_games: int = Field(..., description="Number of active games in memory")
    config: dict = Field(..., description="Current game configuration")


class DetailedHealthStatus(BaseModel):
    """Detailed health check response with system metrics"""
    status: str = Field(..., description="API status: 'ok' if healthy")
    uptime_seconds: float = Field(..., description="API uptime in seconds")
    active_games: int = Field(..., description="Number of active games in memory")
    total_players: int = Field(..., description="Total players across all games")
    memory_usage_mb: float = Field(..., description="Estimated memory usage in MB")
    games_by_phase: dict = Field(..., description="Count of games by phase")
    avg_game_age_minutes: float = Field(..., description="Average game age in minutes")
    config: dict = Field(..., description="Current game configuration")
    version: str = Field(..., description="API version")


class ReadinessStatus(BaseModel):
    """Readiness probe response for Kubernetes/deployments"""
    status: str = Field(..., description="'ready' if ready to serve traffic")
    checks: dict = Field(..., description="Individual check results")
    timestamp: str = Field(..., description="ISO timestamp")


class LivenessStatus(BaseModel):
    """Liveness probe response for Kubernetes/deployments"""
    status: str = Field(..., description="'alive' if service is running")
    uptime_seconds: float = Field(..., description="Service uptime in seconds")
    timestamp: str = Field(..., description="ISO timestamp")


class HandHistoryEntry(BaseModel):
    """Single hand history entry"""
    hand_number: int = Field(..., description="Hand number")
    timestamp: str = Field(..., description="ISO timestamp of hand completion")
    players: List[str] = Field(..., description="Player names who participated")
    community_cards: List[str] = Field(..., description="Community cards dealt")
    pot: int = Field(..., description="Total pot amount")
    winners: List[dict] = Field(..., description="Hand winners and amounts")


class HandHistoryResponse(BaseModel):
    """Game history response"""
    game_id: str = Field(..., description="Game identifier")
    hands: List[HandHistoryEntry] = Field(default_factory=list, description="Completed hands")


class AIStatsResponse(BaseModel):
    """AI bot statistics response"""
    game_id: str = Field(..., description="Game identifier")
    bots: Dict[str, dict] = Field(..., description="Stats for each AI bot by name")


class PlayerBehaviorEntry(BaseModel):
    """Player behavior statistics"""
    player_id: str = Field(..., description="Player identifier")
    player_name: str = Field(..., description="Player display name")
    total_actions: int = Field(..., description="Total actions taken")
    fold_percentage: float = Field(..., description="Percentage of hands folded")
    call_percentage: float = Field(..., description="Percentage of hands called")
    raise_percentage: float = Field(..., description="Percentage of hands raised")
    all_ins: int = Field(..., description="Number of all-in actions")
    checks: int = Field(..., description="Number of check actions")


class GameMetricsResponse(BaseModel):
    """Game metrics and analytics response"""
    game_id: str = Field(..., description="Game identifier")
    session_start: str = Field(..., description="ISO timestamp when game started")
    session_duration_minutes: float = Field(..., description="Game session duration in minutes")
    hands_played: int = Field(..., description="Total hands played")
    average_pot_size: float = Field(..., description="Average pot size across all hands")
    hands_per_hour: float = Field(..., description="Calculated hands per hour")
    total_pot_accumulated: int = Field(..., description="Sum of all pot sizes")
    phase_distribution: Dict[str, int] = Field(..., description="Count of hands ending in each phase")
    player_behaviors: List[PlayerBehaviorEntry] = Field(..., description="Behavior stats for each player")


class PlayerTendencyResponse(BaseModel):
    """Player tendency analysis response"""
    player_name: str = Field(..., description="Player display name")
    hands_played: int = Field(..., description="Total hands played")
    hands_won: int = Field(..., description="Hands won")
    win_rate: float = Field(..., description="Win rate (0-1)")
    vpip: float = Field(..., description="Voluntarily Put $ In Pot percentage")
    pfr: float = Field(..., description="Pre-flop raise percentage")
    aggression_factor: float = Field(..., description="Aggression factor (raises/calls)")
    fold_percentage: float = Field(..., description="Fold frequency")
    showdown_percentage: float = Field(..., description="Hands reaching showdown")
    bluff_frequency: float = Field(..., description="Estimated bluff frequency")
    avg_decision_time_ms: float = Field(..., description="Average decision time in ms")
    player_type: str = Field(..., description="Classified player type")
    ai_adjustments: Dict[str, float] = Field(..., description="AI adjustment factors")
    recommendations: List[str] = Field(..., description="Strategy recommendations")


class UsageAnalyticsResponse(BaseModel):
    """Usage analytics summary response"""
    uptime_hours: float = Field(..., description="API uptime in hours")
    active_sessions: int = Field(..., description="Currently active sessions")
    active_sessions_5min: int = Field(..., description="Active sessions in last 5 minutes")
    total_sessions: int = Field(..., description="Total sessions since startup")
    unique_players_24h: int = Field(..., description="Unique players in last 24 hours")
    avg_session_duration_minutes: float = Field(..., description="Average session duration")
    total_requests: int = Field(..., description="Total API requests")
    total_games_created: int = Field(..., description="Total games created")
    total_hands_played: int = Field(..., description="Total hands played")
    total_actions: int = Field(..., description="Total player actions")
    requests_per_hour: float = Field(..., description="Average requests per hour")
    today: Dict[str, Any] = Field(..., description="Today's statistics")
    hourly_activity: Dict[str, int] = Field(..., description="Hourly request counts")


class ErrorResponse(BaseModel):
    """Error response"""
    detail: str = Field(..., description="Error message")


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(
    title="Texas Hold'em Poker API",
    description="""
    A multiplayer Texas Hold'em poker game API with AI opponents.

    ## Features

    - **Multiplayer**: Play against 5 AI bots with varying play styles
    - **Real-time**: Polling-based game state updates
    - **Complete poker rules**: All betting rounds, blinds, side pots, showdowns
    - **AI opponents**: Each bot has unique aggression levels and strategies

    ## Game Flow

    1. **Create Game** - `POST /api/poker/games` to start a new game
    2. **Get State** - `GET /api/poker/games/{game_id}?player_id={id}` to view game
    3. **Take Action** - `POST /api/poker/games/{game_id}/action` when it's your turn
    4. **Next Hand** - `POST /api/poker/games/{game_id}/next-hand` after showdown

    ## Actions

    - **fold**: Give up your hand
    - **check**: Pass when no bet to call (only when `can_check` is true)
    - **call**: Match the current bet
    - **raise**: Increase the bet (requires `amount` parameter)
    """,
    version="1.0.0",
    contact={
        "name": "Poker API Support",
        "url": "https://palmergill.com"
    },
    debug=Config.DEBUG
)

# HTTPS enforcement middleware (production only)
@app.middleware("http")
async def https_enforcement_middleware(request: Request, call_next):
    """Redirect HTTP to HTTPS in production environments with proper load balancer support"""
    if not Config.DEBUG:
        # Only enforce if we have explicit indication of HTTP from a load balancer/proxy
        # X-Forwarded-Proto is set by most load balancers (AWS ALB/ELB, Nginx, CloudFlare, etc.)
        forwarded_proto = request.headers.get("X-Forwarded-Proto", "")
        
        # Only redirect if load balancer explicitly says HTTP and not health check
        if forwarded_proto == "http" and request.url.path != "/api/poker/health":
            https_url = request.url.replace(scheme="https")
            return JSONResponse(
                status_code=307,  # Temporary redirect
                headers={"Location": str(https_url)},
                content={"detail": "HTTPS required"}
            )
    return await call_next(request)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=Config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# CSRF protection middleware (after CORS so cookies work correctly)
app.add_middleware(CSRFMiddleware)


@app.middleware("http")
async def correlation_id_middleware(request: Request, call_next):
    """Add correlation ID to each request for tracing"""
    cid = request.headers.get("X-Correlation-ID", str(uuid.uuid4())[:8])
    set_correlation_id(cid)
    
    response = await call_next(request)
    response.headers["X-Correlation-ID"] = cid
    
    clear_correlation_id()
    return response


# Performance monitoring middleware
@app.middleware("http")
async def performance_tracking_middleware(request: Request, call_next):
    """Track API response times and performance metrics"""
    return await performance_middleware(request, call_next)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Rate limiting middleware - exempt health checks"""
    # Skip rate limiting for health checks
    if request.url.path == "/api/poker/health":
        return await call_next(request)
    
    # Get client IP (handle proxies)
    client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    client_ip = client_ip.split(",")[0].strip() if "," in client_ip else client_ip
    
    # Check rate limit
    if not rate_limiter.is_allowed(client_ip):
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded. Please try again later."},
            headers={"Retry-After": "60"}
        )
    
    # Process request and add rate limit headers
    response = await call_next(request)
    remaining = rate_limiter.get_remaining(client_ip)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    response.headers["X-RateLimit-Limit"] = str(rate_limiter.burst_size)
    
    # Track request in usage analytics (skip health checks)
    if not request.url.path.startswith('/api/poker/health'):
        usage_analytics.record_request()
    
    return response


# In-memory game storage
games: Dict[str, PokerGame] = {}
ai_managers: Dict[str, AIManager] = {}

# Track startup time for uptime calculation
import time as time_module
STARTUP_TIME = time_module.time()

# =============================================================================
# Startup/Shutdown Events
# =============================================================================

@app.on_event("startup")
async def startup_event():
    """Load persisted games on startup"""
    global games
    
    logger.info("Starting up Poker API...")
    
    # Load persisted games
    if persistence.is_enabled():
        persisted_games = persistence.load_games()
        if persisted_games:
            games.update(persisted_games)
            logger.info(f"Restored {len(persisted_games)} games from persistence")
        
        # Start periodic save task
        await persistence.start_periodic_save(lambda: games)
    else:
        logger.info("Persistence disabled, starting with empty game state")


@app.on_event("shutdown")
async def shutdown_event():
    """Save games on shutdown"""
    logger.info("Shutting down Poker API...")
    
    if persistence.is_enabled():
        await persistence.stop(games)


# =============================================================================
# Rate Limiting
# =============================================================================

class RateLimiter:
    """Simple in-memory rate limiter per IP address"""
    
    def __init__(self, requests_per_minute: int = 60, burst_size: int = 10):
        self.requests_per_minute = requests_per_minute
        self.burst_size = burst_size
        self.requests: Dict[str, List[float]] = defaultdict(list)
        self.blocked: Dict[str, float] = {}
    
    def is_allowed(self, client_ip: str) -> bool:
        """Check if request is allowed for this IP"""
        now = time.time()
        
        # Check if IP is temporarily blocked
        if client_ip in self.blocked:
            if now < self.blocked[client_ip]:
                return False
            else:
                del self.blocked[client_ip]
        
        # Clean old requests older than 1 minute
        cutoff = now - 60
        self.requests[client_ip] = [t for t in self.requests[client_ip] if t > cutoff]
        
        # Check burst limit
        if len(self.requests[client_ip]) >= self.burst_size:
            # Block for 1 minute if burst exceeded
            self.blocked[client_ip] = now + 60
            logger.warning(f"Rate limit exceeded for IP: {client_ip}")
            return False
        
        # Record this request
        self.requests[client_ip].append(now)
        return True
    
    def get_remaining(self, client_ip: str) -> int:
        """Get remaining requests in current window"""
        now = time.time()
        cutoff = now - 60
        recent = [t for t in self.requests[client_ip] if t > cutoff]
        return max(0, self.burst_size - len(recent))


# Initialize rate limiter
rate_limiter = RateLimiter(requests_per_minute=60, burst_size=20)


def validate_game_id(game_id: str) -> str:
    """Validate game ID format - alphanumeric only, max 16 chars"""
    if not game_id or len(game_id) > 16:
        raise HTTPException(status_code=400, detail="Invalid game ID format")
    if not re.match(r'^[a-zA-Z0-9-]+$', game_id):
        raise HTTPException(status_code=400, detail="Invalid game ID characters")
    return game_id


def validate_player_id(player_id: str) -> str:
    """Validate player ID format - alphanumeric only"""
    if not player_id or len(player_id) > 10:
        raise HTTPException(status_code=400, detail="Invalid player ID format")
    if not re.match(r'^[a-zA-Z0-9]+$', player_id):
        raise HTTPException(status_code=400, detail="Invalid player ID characters")
    return player_id


# Note: Request/Response models defined above with FastAPI app


@app.post(
    "/api/poker/games",
    response_model=CreateGameResponse,
    tags=["Game Management"],
    summary="Create new game",
    description="Create a new poker game with AI opponents. Returns game ID, player ID, and initial game state.",
    responses={
        201: {"description": "Game created successfully", "model": CreateGameResponse},
        422: {"description": "Invalid request parameters", "model": ErrorResponse}
    }
)
async def create_game(request: CreateGameRequest):
    """Create a new poker game with AI opponents"""
    game_id = str(uuid.uuid4())[:8]
    logger.info(f"Creating new game: {game_id}, player: {request.player_name}")

    game = PokerGame(game_id)

    # Add human player
    human = game.add_player(request.player_name, is_human=True)

    # Add AI bots with varied difficulty levels
    ai_manager = AIManager(game)
    if Config.AI_DIFFICULTY == "mixed":
        # Default: mix of difficulties for varied gameplay
        ai_manager.add_default_bots()
    elif Config.AI_DIFFICULTY == "easy":
        for name in ["Alex", "Bob", "Charlie", "Diana", "Eve"]:
            ai_manager.add_bot(name, difficulty="easy")
    elif Config.AI_DIFFICULTY == "medium":
        for name in ["Alex", "Bob", "Charlie", "Diana", "Eve"]:
            ai_manager.add_bot(name, difficulty="medium")
    elif Config.AI_DIFFICULTY == "hard":
        for name in ["Alex", "Bob", "Charlie", "Diana", "Eve"]:
            ai_manager.add_bot(name, difficulty="hard")
    elif Config.AI_DIFFICULTY == "expert":
        for name in ["Alex", "Bob", "Charlie", "Diana", "Eve"]:
            ai_manager.add_bot(name, difficulty="expert")
    else:
        # Fallback to default mixed
        ai_manager.add_default_bots()

    # Start first hand
    game.start_hand()

    # Store game
    games[game_id] = game
    ai_managers[game_id] = ai_manager
    
    # Track usage analytics
    session_id = usage_analytics.start_session(human.id, request.player_name)
    usage_analytics.record_game_created(session_id)
    
    # Initialize player tendency tracker
    adaptive_ai_manager.get_or_create_tracker(human.id, request.player_name)
    
    # Initialize integrity session for the player
    integrity_manager.create_session(game_id, human.id)

    logger.info(f"Game {game_id} created successfully with {len(game.players)} players")

    # Get initial state with action token
    state = game.to_dict(for_player=human.id)
    state['action_token'] = integrity_manager.generate_action_token(game_id, human.id)
    integrity_manager.store_state_fingerprint(game_id, state)

    return {
        "game_id": game_id,
        "player_id": human.id,
        "state": state,
        "session_id": session_id
    }


@app.get(
    "/api/poker/games/{game_id}",
    response_model=GameState,
    tags=["Game State"],
    summary="Get game state",
    description="Retrieve the current state of a game. Must provide player_id to get personalized view (hole cards visible only to requesting player).",
    responses={
        200: {"description": "Game state retrieved successfully", "model": GameState},
        400: {"description": "Invalid game ID or player ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def get_game_state(game_id: str, player_id: str, process_ai: bool = True):
    """Get current game state"""
    # Validate inputs
    validate_game_id(game_id)
    validate_player_id(player_id)

    if game_id not in games:
        logger.warning(f"Game not found: {game_id}")
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]

    is_single_player = getattr(game, 'game_type', 'single') == 'single'
    if process_ai and is_single_player and game.phase not in ('showdown', 'waiting'):
        active = [p for p in game.players if not p.folded and not p.is_all_in]
        if len(active) <= 1:
            game._advance_phase()
        else:
            current = game.get_current_player()
            if current and not current.is_human:
                ai_manager = ai_managers.get(game_id)
                if ai_manager:
                    await ai_manager.process_bot_turn_async()

    state = game.to_dict(for_player=player_id)
    
    # Generate action token if it's this player's turn
    current_player = game.get_current_player()
    if current_player and current_player.id == player_id:
        token = integrity_manager.generate_action_token(game_id, player_id)
        if token:
            state['action_token'] = token
            integrity_manager.store_state_fingerprint(game_id, state)
    
    return state


@app.post(
    "/api/poker/games/{game_id}/action",
    response_model=ActionResponse,
    tags=["Gameplay"],
    summary="Execute player action",
    description="Execute a player action (fold, check, call, or raise). Automatically processes AI opponent turns until it's the human player's turn again or the hand completes.",
    responses={
        200: {"description": "Action executed successfully", "model": ActionResponse},
        400: {"description": "Invalid action, not player's turn, or action failed", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse},
        429: {"description": "Rate limit exceeded", "model": ErrorResponse}
    }
)
async def player_action(game_id: str, request: ActionRequest):
    """Execute player action"""
    # Validate game ID
    validate_game_id(game_id)

    if game_id not in games:
        logger.warning(f"Action on non-existent game: {game_id}")
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]

    # Verify it's player's turn
    current = game.get_current_player()
    if not current or current.id != request.player_id:
        logger.warning(f"Action attempted out of turn: game={game_id}, player={request.player_id}")
        raise HTTPException(status_code=400, detail="Not your turn")
    
    # Game integrity validation
    is_valid, error_msg = integrity_manager.validate_action_request(
        game_id, request.player_id, request.action, request.action_token
    )
    if not is_valid:
        logger.warning(f"Integrity check failed: game={game_id}, player={request.player_id}, error={error_msg}")
        raise HTTPException(status_code=400, detail=f"Security validation failed: {error_msg}")

    # Execute action
    logger.info(f"Player action: game={game_id}, player={request.player_id}, action={request.action}")
    success = False
    if request.action == "fold":
        success = game.action_fold(request.player_id)
    elif request.action == "check":
        success = game.action_check(request.player_id)
    elif request.action == "call":
        success = game.action_call(request.player_id)
    elif request.action == "raise":
        if request.amount is None:
            raise HTTPException(status_code=400, detail="Amount required for raise")
        success = game.action_raise(request.player_id, request.amount)
    else:
        raise HTTPException(status_code=400, detail="Invalid action")

    if not success:
        logger.warning(f"Action failed: game={game_id}, action={request.action}")
        raise HTTPException(status_code=400, detail="Action failed")
    
    # Record successful action in integrity manager
    integrity_manager.record_action(game_id, request.player_id, request.action, request.action_token)
    
    # Track player action for tendency analysis
    player = next((p for p in game.players if p.id == request.player_id), None)
    if player and player.is_human:
        # Estimate hand strength for tracking (simplified)
        from .ai import PokerAI
        temp_ai = PokerAI()
        hand_strength = temp_ai._estimate_hand_strength(game, player)
        
        adaptive_ai_manager.record_player_action(
            player_id=request.player_id,
            player_name=player.name,
            action=request.action,
            amount=request.amount or 0,
            game_phase=game.phase,
            hand_strength=hand_strength
        )
        
        # Track usage analytics
        usage_analytics.record_action()
    
    return game.to_dict(for_player=request.player_id)


@app.post(
    "/api/poker/games/{game_id}/buy-back",
    response_model=GameState,
    tags=["Gameplay"],
    summary="Buy back into a game",
    description="Add chips for a player between completed hands.",
    responses={
        200: {"description": "Buy-back applied", "model": GameState},
        400: {"description": "Hand still in progress or invalid request", "model": ErrorResponse},
        404: {"description": "Game or player not found", "model": ErrorResponse}
    }
)
async def buy_back(game_id: str, request: BuyBackRequest):
    """Add chips for a busted player before the next hand."""
    validate_game_id(game_id)
    validate_player_id(request.player_id)

    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    if game.phase not in ['showdown', 'waiting']:
        raise HTTPException(status_code=400, detail="Buy-back is only available between hands")

    player = next((p for p in game.players if p.id == request.player_id), None)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    player.chips += request.amount
    if player.chips > 0:
        player.is_all_in = False

    logger.info(f"Buy-back applied: game={game_id}, player={request.player_id}, amount={request.amount}")
    return game.to_dict(for_player=request.player_id)


@app.post(
    "/api/poker/games/{game_id}/next-hand",
    response_model=GameState,
    tags=["Gameplay"],
    summary="Start next hand",
    description="Start a new hand after the current hand completes (showdown or waiting phase). Moves dealer button and processes AI blinds/actions automatically.",
    responses={
        200: {"description": "New hand started successfully", "model": GameState},
        400: {"description": "Hand still in progress or invalid request", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def next_hand(game_id: str, player_id: str):
    """Start next hand"""
    # Validate inputs
    validate_game_id(game_id)
    validate_player_id(player_id)

    if game_id not in games:
        logger.warning(f"Next hand on non-existent game: {game_id}")
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]

    # Only proceed if hand is complete
    if game.phase not in ['showdown', 'waiting']:
        raise HTTPException(status_code=400, detail="Hand still in progress")
    
    # Track hand completion for analytics
    usage_analytics.record_hand_played()
    
    # Record hand results for player tendencies
    human_player = next((p for p in game.players if p.id == player_id and p.is_human), None)
    if human_player:
        # Determine if human won and reached showdown
        won = False
        reached_showdown = game.phase == 'showdown'
        pot_size = 0
        
        # Check if there are winners from the last hand
        if hasattr(game, 'last_hand_winners') and game.last_hand_winners:
            for winner in game.last_hand_winners:
                if winner.get('player_id') == player_id:
                    won = True
                    pot_size = winner.get('amount', 0)
                    break
        
        adaptive_ai_manager.record_hand_result(
            player_id=player_id,
            won=won,
            reached_showdown=reached_showdown,
            pot_size=pot_size
        )

    logger.info(f"Starting next hand: game={game_id}, hand_number={game.hand_number + 1}")

    # Move dealer button
    game.dealer_index = (game.dealer_index + 1) % len(game.players)

    # Start new hand
    game.start_hand()

    # Prepare response state with integrity token
    state = game.to_dict(for_player=player_id)
    current = game.get_current_player()
    if current and current.id == player_id:
        token = integrity_manager.generate_action_token(game_id, player_id)
        if token:
            state['action_token'] = token
            integrity_manager.store_state_fingerprint(game_id, state)

    return state


@app.get(
    "/api/poker/games/{game_id}/history",
    response_model=HandHistoryResponse,
    tags=["Game State"],
    summary="Get game history",
    description="Retrieve hand history for a game. Returns all completed hands with winners, pots, and community cards.",
    responses={
        200: {"description": "Game history retrieved", "model": HandHistoryResponse},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def get_game_history(game_id: str):
    """Get hand history for a game"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    game = games[game_id]
    return {
        "game_id": game_id, 
        "hands": game.get_hand_history()
    }


@app.get(
    "/api/poker/games/{game_id}/ai-stats",
    response_model=AIStatsResponse,
    tags=["Game State"],
    summary="Get AI bot statistics",
    description="Retrieve statistics for all AI bots in a game including their playing patterns, win rates, and behavioral tells.",
    responses={
        200: {"description": "AI stats retrieved", "model": AIStatsResponse},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def get_ai_stats(game_id: str):
    """Get AI bot statistics for a game"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    ai_manager = ai_managers.get(game_id)
    if not ai_manager:
        raise HTTPException(status_code=404, detail="AI manager not found for this game")
    
    stats = ai_manager.get_all_bot_stats()
    return {
        "game_id": game_id,
        "bots": stats
    }


@app.get(
    "/api/poker/health",
    response_model=HealthStatus,
    tags=["System"],
    summary="Health check",
    description="Check API health status and get current configuration. Exempt from rate limiting.",
    responses={
        200: {"description": "API is healthy", "model": HealthStatus}
    }
)
async def health_check():
    """Health check endpoint - used by monitoring and load balancers"""
    return {
        "status": "ok",
        "active_games": len(games),
        "config": {
            "starting_chips": Config.STARTING_CHIPS,
            "small_blind": Config.SMALL_BLIND,
            "big_blind": Config.BIG_BLIND,
            "ai_difficulty": Config.AI_DIFFICULTY,
        }
    }


@app.get(
    "/api/poker/health/detailed",
    response_model=DetailedHealthStatus,
    tags=["System"],
    summary="Detailed health check",
    description="Get detailed system metrics including memory usage, game statistics, and uptime. Useful for monitoring and debugging.",
    responses={
        200: {"description": "Detailed health information", "model": DetailedHealthStatus}
    }
)
async def detailed_health_check():
    """Detailed health check with system metrics"""
    import sys
    
    # Calculate uptime
    uptime_seconds = time_module.time() - STARTUP_TIME
    
    # Count total players and games by phase
    total_players = 0
    games_by_phase = {}
    total_game_age_seconds = 0
    now = time_module.time()
    
    for game in games.values():
        total_players += len(game.players)
        phase = game.phase
        games_by_phase[phase] = games_by_phase.get(phase, 0) + 1
        # Estimate game age from hand number (approximate)
        total_game_age_seconds += game.hand_number * 2 * 60  # Assume ~2 min per hand
    
    avg_game_age_minutes = (total_game_age_seconds / len(games) / 60) if games else 0
    
    # Estimate memory usage (rough approximation)
    # Each game ~50KB + players + history
    estimated_memory_mb = len(games) * 0.05 + total_players * 0.001
    
    return {
        "status": "ok",
        "uptime_seconds": round(uptime_seconds, 2),
        "active_games": len(games),
        "total_players": total_players,
        "memory_usage_mb": round(estimated_memory_mb, 3),
        "games_by_phase": games_by_phase,
        "avg_game_age_minutes": round(avg_game_age_minutes, 2),
        "config": {
            "starting_chips": Config.STARTING_CHIPS,
            "small_blind": Config.SMALL_BLIND,
            "big_blind": Config.BIG_BLIND,
            "ai_difficulty": Config.AI_DIFFICULTY,
            "ai_decision_delay": Config.AI_DECISION_DELAY,
        },
        "version": "1.0.9"
    }


@app.get(
    "/api/poker/health/ready",
    response_model=ReadinessStatus,
    tags=["System"],
    summary="Readiness probe",
    description="Kubernetes-style readiness probe. Returns 200 when the service is ready to accept traffic. Checks persistence system and basic functionality.",
    responses={
        200: {"description": "Service is ready", "model": ReadinessStatus},
        503: {"description": "Service is not ready"}
    }
)
async def readiness_probe():
    """Readiness probe for load balancers and orchestrators"""
    from datetime import datetime
    
    checks = {
        "persistence": persistence.is_enabled(),
        "memory": True,  # Could add memory threshold checks
        "games_loaded": True  # Games are loaded on startup
    }
    
    all_ready = all(checks.values())
    status = "ready" if all_ready else "not_ready"
    
    return {
        "status": status,
        "checks": checks,
        "timestamp": datetime.now().isoformat()
    }


@app.get(
    "/api/poker/health/live",
    response_model=LivenessStatus,
    tags=["System"],
    summary="Liveness probe",
    description="Kubernetes-style liveness probe. Returns 200 if the service is running and not deadlocked. Always returns 200 unless the process is hung.",
    responses={
        200: {"description": "Service is alive", "model": LivenessStatus}
    }
)
async def liveness_probe():
    """Liveness probe for orchestrators"""
    from datetime import datetime
    
    uptime_seconds = time_module.time() - STARTUP_TIME
    
    return {
        "status": "alive",
        "uptime_seconds": round(uptime_seconds, 2),
        "timestamp": datetime.now().isoformat()
    }


@app.get(
    "/api/poker/health/persistence",
    tags=["System"],
    summary="Persistence status",
    description="Get game persistence system status including save timestamps and file information.",
    responses={
        200: {"description": "Persistence status retrieved"}
    }
)
async def persistence_status():
    """Get persistence system status"""
    return persistence.get_persistence_status()


@app.post(
    "/api/poker/health/persistence/save",
    tags=["System"],
    summary="Trigger game save",
    description="Manually trigger a save of all active games to persistence storage. Returns the number of games saved.",
    responses={
        200: {"description": "Games saved successfully"}
    }
)
async def trigger_persistence_save():
    """Manually trigger game persistence save"""
    success = persistence.save_games(games)
    return {
        "success": success,
        "games_saved": len(games) if success else 0,
        "timestamp": datetime.now().isoformat()
    }


@app.get(
    "/api/poker/health/performance",
    tags=["System"],
    summary="Performance metrics",
    description="Get API performance metrics including response times, request counts, and slow request tracking. Returns aggregated statistics for all tracked endpoints.",
    responses={
        200: {"description": "Performance metrics retrieved"}
    }
)
async def performance_metrics():
    """Get API performance metrics and statistics"""
    return performance_monitor.get_stats()


@app.get(
    "/api/poker/health/integrity/{game_id}",
    tags=["System"],
    summary="Game integrity status",
    description="Get integrity monitoring statistics for a game including active sessions and suspicious activity. Used for security monitoring.",
    responses={
        200: {"description": "Integrity status retrieved"},
        400: {"description": "Invalid game ID format"},
        404: {"description": "Game not found"}
    }
)
async def integrity_status(game_id: str):
    """Get game integrity status and suspicious activity logs"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    return {
        "game_id": game_id,
        "integrity": integrity_manager.get_session_stats(game_id),
        "suspicious_activity": integrity_manager.get_suspicious_activity(game_id)
    }


@app.get(
    "/api/poker/analytics/usage",
    response_model=UsageAnalyticsResponse,
    tags=["Analytics"],
    summary="Get usage analytics",
    description="Retrieve comprehensive usage analytics including active sessions, player counts, request rates, and daily statistics.",
    responses={
        200: {"description": "Usage analytics retrieved", "model": UsageAnalyticsResponse}
    }
)
async def get_usage_analytics():
    """Get usage analytics and session statistics"""
    usage_analytics.record_request()
    return usage_analytics.get_summary()


@app.get(
    "/api/poker/analytics/player/{player_id}",
    response_model=PlayerTendencyResponse,
    tags=["Analytics"],
    summary="Get player tendency analysis",
    description="Retrieve detailed player tendency analysis including VPIP, PFR, aggression factor, player type classification, and AI adjustments.",
    responses={
        200: {"description": "Player analysis retrieved", "model": PlayerTendencyResponse},
        404: {"description": "Player not found in analytics", "model": ErrorResponse}
    }
)
async def get_player_analysis(player_id: str):
    """Get detailed player tendency analysis"""
    validate_player_id(player_id)
    usage_analytics.record_request()
    
    analysis = adaptive_ai_manager.get_player_analysis(player_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Player not found in analytics data")
    
    return analysis


@app.get(
    "/api/poker/analytics/players",
    tags=["Analytics"],
    summary="Get all player analyses",
    description="Retrieve tendency analysis for all tracked players.",
    responses={
        200: {"description": "All player analyses retrieved"}
    }
)
async def get_all_player_analyses():
    """Get analysis for all tracked players"""
    usage_analytics.record_request()
    return adaptive_ai_manager.get_all_analyses()


@app.get(
    "/api/poker/games/{game_id}/metrics",
    response_model=GameMetricsResponse,
    tags=["Game State"],
    summary="Get game metrics and analytics",
    description="Retrieve detailed metrics for a game including hands per hour, average pot size, and player behavior statistics.",
    responses={
        200: {"description": "Game metrics retrieved", "model": GameMetricsResponse},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def get_game_metrics(game_id: str):
    """Get detailed metrics and analytics for a game"""
    validate_game_id(game_id)

    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    metrics = metrics_manager.get_metrics(game_id)
    if not metrics:
        # Return empty metrics if none exist yet
        return {
            "game_id": game_id,
            "session_start": datetime.utcnow().isoformat(),
            "session_duration_minutes": 0,
            "hands_played": 0,
            "average_pot_size": 0,
            "hands_per_hour": 0,
            "total_pot_accumulated": 0,
            "phase_distribution": {},
            "player_behaviors": []
        }

    return metrics.get_summary()


# =============================================================================
# CSRF Token Endpoint
# =============================================================================

class CSRFTokenResponse(BaseModel):
    """CSRF token response"""
    csrf_token: str = Field(..., description="CSRF token to include in X-CSRF-Token header for state-changing requests")


@app.get("/api/poker/csrf-token", tags=["Security"], response_model=CSRFTokenResponse)
async def get_csrf_token_endpoint(request: Request):
    """
    Get a CSRF token for making state-changing requests.
    
    The token is also set as a cookie. For POST/PUT/PATCH/DELETE requests,
    include the token in the X-CSRF-Token header.
    """
    token = get_csrf_token(request)
    if not token:
        # If no cookie exists, a new one will be set by the middleware
        # Return a placeholder - the actual token comes from the cookie
        return CSRFTokenResponse(csrf_token="check_cookie")
    return CSRFTokenResponse(csrf_token=token)


@app.get("/", tags=["System"], include_in_schema=False)
async def root_redirect():
    """Redirect root to API documentation"""
    return RedirectResponse(url="/docs")


@app.get("/api", tags=["System"], include_in_schema=False)
async def api_redirect():
    """Redirect /api to API documentation"""
    return RedirectResponse(url="/docs")


# =============================================================================
# Backup Strategy - Game Data Export/Restore
# =============================================================================

class BackupResponse(BaseModel):
    """Game backup response"""
    game_id: str = Field(..., description="Game identifier")
    backup_data: dict = Field(..., description="Complete game state backup")
    exported_at: str = Field(..., description="ISO timestamp of export")
    version: str = Field(..., description="Backup format version")


class BackupListResponse(BaseModel):
    """List of available backups"""
    backups: List[dict] = Field(..., description="List of available backups")
    count: int = Field(..., description="Total number of backups")


class RestoreResponse(BaseModel):
    """Game restore response"""
    success: bool = Field(..., description="Whether restore was successful")
    game_id: str = Field(..., description="Restored game identifier")
    message: str = Field(..., description="Status message")
    restored_at: str = Field(..., description="ISO timestamp of restore")


@app.get(
    "/api/poker/games/{game_id}/backup",
    response_model=BackupResponse,
    tags=["Backup"],
    summary="Export game backup",
    description="Export a complete backup of game state including players, history, and AI state. Can be used to restore the game later.",
    responses={
        200: {"description": "Backup exported successfully", "model": BackupResponse},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def export_game_backup(game_id: str):
    """Export a complete backup of game state for restoration later"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    game = games[game_id]
    ai_manager = ai_managers.get(game_id)
    
    # Build comprehensive backup
    backup_data = {
        "game_state": game.to_dict(),
        "players": [
            {
                "id": p.id,
                "name": p.name,
                "chips": p.chips,
                "is_human": p.is_human,
                "avatar": getattr(p, 'avatar', None)
            }
            for p in game.players
        ],
        "hand_history": game.get_hand_history() if hasattr(game, 'get_hand_history') else [],
        "ai_state": ai_manager.get_all_bot_stats() if ai_manager else {},
        "metrics": metrics_manager.get_metrics(game_id).get_summary() if metrics_manager.get_metrics(game_id) else None,
    }
    
    logger.info(f"Backup exported for game {game_id}")
    
    return {
        "game_id": game_id,
        "backup_data": backup_data,
        "exported_at": datetime.utcnow().isoformat(),
        "version": "1.0.0"
    }


@app.post(
    "/api/poker/games/{game_id}/restore",
    response_model=RestoreResponse,
    tags=["Backup"],
    summary="Restore game from backup",
    description="Restore a game from previously exported backup data. Requires the complete backup_data object from the export endpoint.",
    responses={
        200: {"description": "Game restored successfully", "model": RestoreResponse},
        400: {"description": "Invalid game ID or backup data", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def restore_game_backup(game_id: str, backup_data: dict):
    """Restore a game from backup data"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    try:
        game = games[game_id]
        
        # Restore player chips and states
        for player_backup in backup_data.get("players", []):
            player = next((p for p in game.players if p.id == player_backup["id"]), None)
            if player:
                player.chips = player_backup.get("chips", player.chips)
        
        logger.info(f"Game {game_id} restored from backup")
        
        return {
            "success": True,
            "game_id": game_id,
            "message": "Game restored successfully",
            "restored_at": datetime.utcnow().isoformat()
        }
    except Exception as e:
        logger.error(f"Failed to restore game {game_id}: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to restore game: {str(e)}")


# =============================================================================
# Spectator Mode - Watch Games Without Playing
# =============================================================================

class SpectatorState(BaseModel):
    """Game state for spectators (no hole cards visible)"""
    game_id: str = Field(..., description="Unique game identifier")
    phase: str = Field(..., description="Current game phase")
    hand_number: int = Field(..., description="Current hand number")
    community_cards: List[dict] = Field(..., description="Community cards on the table")
    pot: int = Field(..., description="Main pot amount")
    current_bet: int = Field(..., description="Current bet to call")
    players: List[dict] = Field(..., description="Players with hidden hole cards")
    current_player: Optional[str] = Field(None, description="ID of player whose turn it is")
    dealer_index: int = Field(..., description="Index of dealer button")
    last_action: Optional[LastActionInfo] = Field(None, description="Most recent action taken")
    winners: Optional[List[dict]] = Field(None, description="Winners from showdown")
    spectators: int = Field(0, description="Number of active spectators")


# Track spectator counts per game
spectator_counts: Dict[str, int] = {}


@app.get(
    "/api/poker/games/{game_id}/spectate",
    response_model=SpectatorState,
    tags=["Spectator"],
    summary="Spectate a game",
    description="Watch a game without playing. Returns game state with hole cards hidden. No player_id required.",
    responses={
        200: {"description": "Spectator state retrieved", "model": SpectatorState},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def spectate_game(game_id: str):
    """Spectate a game - watch without playing (no hole cards visible)"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    game = games[game_id]
    
    # Get base state without player-specific data
    base_state = game.to_dict(for_player=None)
    
    # Hide all hole cards for spectators
    for player in base_state.get("players", []):
        player["cards"] = None  # Hide hole cards
        if "hand_strength" in player:
            del player["hand_strength"]  # Remove hand strength info
    
    # Track spectator count
    spectator_counts[game_id] = spectator_counts.get(game_id, 0) + 1
    
    # Clean up old spectator counts for games that don't exist
    for gid in list(spectator_counts.keys()):
        if gid not in games:
            del spectator_counts[gid]
    
    return {
        "game_id": game_id,
        "phase": base_state["phase"],
        "hand_number": base_state["hand_number"],
        "community_cards": base_state["community_cards"],
        "pot": base_state["pot"],
        "current_bet": base_state["current_bet"],
        "players": base_state["players"],
        "current_player": base_state.get("current_player"),
        "dealer_index": base_state["dealer_index"],
        "last_action": base_state.get("last_action"),
        "winners": base_state.get("winners"),
        "spectators": spectator_counts.get(game_id, 0)
    }


@app.get(
    "/api/poker/games/{game_id}/spectators",
    tags=["Spectator"],
    summary="Get spectator count",
    description="Get the number of active spectators for a game.",
    responses={
        200: {"description": "Spectator count retrieved"},
        400: {"description": "Invalid game ID format", "model": ErrorResponse},
        404: {"description": "Game not found", "model": ErrorResponse}
    }
)
async def get_spectator_count(game_id: str):
    """Get the number of active spectators for a game"""
    validate_game_id(game_id)
    
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    return {
        "game_id": game_id,
        "spectators": spectator_counts.get(game_id, 0),
        "timestamp": datetime.utcnow().isoformat()
    }


# =============================================================================
# Tournament Mode - Sit & Go Tournaments
# =============================================================================

class CreateTournamentRequest(BaseModel):
    """Request to create a new tournament"""
    player_name: str = Field(
        default="Player",
        min_length=1,
        max_length=20,
        description="Player's display name (1-20 characters)",
        examples=["TournamentPro"]
    )
    max_players: int = Field(
        default=6,
        ge=2,
        le=10,
        description="Maximum number of players (2-10)",
        examples=[6, 9]
    )
    buy_in: int = Field(
        default=1000,
        ge=100,
        le=100000,
        description="Tournament buy-in amount",
        examples=[1000, 5000]
    )

    @field_validator('player_name')
    @classmethod
    def sanitize_player_name(cls, v: str) -> str:
        v = v.strip()
        v = ''.join(c for c in v if c.isprintable() and ord(c) < 128)
        v = ' '.join(v.split())
        return v[:20]


class CreateTournamentResponse(BaseModel):
    """Response after creating a tournament"""
    tournament_id: str = Field(..., description="Unique tournament identifier")
    game_id: str = Field(..., description="Associated game ID")
    player_id: str = Field(..., description="Player's unique identifier")
    state: dict = Field(..., description="Tournament state")


class TournamentStateResponse(BaseModel):
    """Tournament state response"""
    tournament_id: str = Field(..., description="Unique tournament identifier")
    status: str = Field(..., description="Tournament status")
    max_players: int = Field(..., description="Maximum players allowed")
    registered_players: int = Field(..., description="Number of registered players")
    active_players: int = Field(..., description="Players still in tournament")
    eliminated_players: int = Field(..., description="Eliminated players count")
    buy_in: int = Field(..., description="Entry fee")
    total_prize_pool: int = Field(..., description="Total prize pool")
    current_level: dict = Field(..., description="Current blind level")
    level_index: int = Field(..., description="Current level number")
    time_in_level: Optional[int] = Field(None, description="Seconds in current level")
    time_remaining_in_level: Optional[int] = Field(None, description="Seconds remaining")
    players: List[dict] = Field(..., description="All tournament players")
    prizes: List[dict] = Field(..., description="Prize distribution")
    game_id: Optional[str] = Field(None, description="Associated game ID")
    can_start: bool = Field(..., description="Whether tournament can start")


class TournamentListResponse(BaseModel):
    """List of tournaments response"""
    tournaments: List[dict] = Field(..., description="List of tournament summaries")


@app.post(
    "/api/poker/tournaments",
    response_model=CreateTournamentResponse,
    tags=["Tournament"],
    summary="Create new tournament",
    description="Create a new Sit & Go tournament with increasing blinds.",
    responses={
        201: {"description": "Tournament created", "model": CreateTournamentResponse},
        422: {"description": "Invalid parameters", "model": ErrorResponse}
    }
)
async def create_tournament(request: CreateTournamentRequest):
    """Create a new Sit & Go tournament"""
    logger.info(f"Creating tournament for player: {request.player_name}")
    
    # Create tournament
    tournament = tournament_manager.create_tournament(
        max_players=request.max_players,
        buy_in=request.buy_in
    )
    
    # Create associated game
    game_id = str(uuid.uuid4())[:8]
    game = PokerGame(game_id)
    
    # Set tournament blinds as starting blinds
    game.small_blind = tournament.current_blind_level.small_blind
    game.big_blind = tournament.current_blind_level.big_blind
    
    # Add human player
    human = game.add_player(request.player_name, is_human=True)
    tournament.register_player(human.id, request.player_name, is_human=True)
    
    # Add AI bots to fill seats
    ai_manager = AIManager(game)
    ai_names = ["Alex", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Henry", "Ivy"][:request.max_players-1]
    for name in ai_names:
        bot = game.add_player(name, is_human=False)
        ai_manager.add_bot(name)
        tournament.register_player(bot.id, name, is_human=False)
    
    # Start the game and tournament
    game.start_hand()
    tournament.start_tournament(game_id)
    
    # Store game
    games[game_id] = game
    ai_managers[game_id] = ai_manager
    
    # Track usage
    session_id = usage_analytics.start_session(human.id, request.player_name)
    usage_analytics.record_game_created(session_id)
    adaptive_ai_manager.get_or_create_tracker(human.id, request.player_name)
    integrity_manager.create_session(game_id, human.id)
    
    logger.info(f"Tournament {tournament.tournament_id} created with game {game_id}")
    
    return {
        "tournament_id": tournament.tournament_id,
        "game_id": game_id,
        "player_id": human.id,
        "state": tournament.to_dict()
    }


@app.get(
    "/api/poker/tournaments/{tournament_id}",
    response_model=TournamentStateResponse,
    tags=["Tournament"],
    summary="Get tournament state",
    description="Get current state of a tournament including blinds, players, and prizes.",
    responses={
        200: {"description": "Tournament state retrieved", "model": TournamentStateResponse},
        404: {"description": "Tournament not found", "model": ErrorResponse}
    }
)
async def get_tournament(tournament_id: str):
    """Get tournament state"""
    tournament = tournament_manager.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    # Check if blinds should advance
    tournament.check_level_advance()
    
    # Update game blinds if level changed
    if tournament.game_id and tournament.game_id in games:
        game = games[tournament.game_id]
        current_level = tournament.current_blind_level
        if game.small_blind != current_level.small_blind or game.big_blind != current_level.big_blind:
            game.small_blind = current_level.small_blind
            game.big_blind = current_level.big_blind
            logger.info(f"Tournament {tournament_id} blind level advanced: {current_level.small_blind}/{current_level.big_blind}")
    
    return tournament.to_dict()


@app.get(
    "/api/poker/tournaments",
    response_model=TournamentListResponse,
    tags=["Tournament"],
    summary="List tournaments",
    description="List all tournaments, optionally filtered by status.",
    responses={
        200: {"description": "Tournaments list retrieved", "model": TournamentListResponse}
    }
)
async def list_tournaments(status: Optional[str] = None):
    """List all tournaments"""
    tournaments = tournament_manager.list_tournaments(status)
    return {
        "tournaments": [t.to_dict() for t in tournaments]
    }


@app.post(
    "/api/poker/tournaments/{tournament_id}/advance-level",
    tags=["Tournament"],
    summary="Advance blind level",
    description="Manually advance to the next blind level (for testing).",
    responses={
        200: {"description": "Level advanced"},
        400: {"description": "Cannot advance level"},
        404: {"description": "Tournament not found"}
    }
)
async def advance_tournament_level(tournament_id: str):
    """Manually advance tournament blind level"""
    tournament = tournament_manager.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    if tournament.advance_level():
        # Update game blinds
        if tournament.game_id and tournament.game_id in games:
            game = games[tournament.game_id]
            current_level = tournament.current_blind_level
            game.small_blind = current_level.small_blind
            game.big_blind = current_level.big_blind
        
        return {
            "success": True,
            "message": "Blind level advanced",
            "new_level": tournament.current_blind_level.to_dict()
        }
    else:
        raise HTTPException(status_code=400, detail="Cannot advance level - tournament not active")


@app.on_event("startup")
async def startup_event():
    """Startup tasks"""
    logger.info("Poker API starting up")
    logger.info(f"Configuration: chips={Config.STARTING_CHIPS}, blinds={Config.SMALL_BLIND}/{Config.BIG_BLIND}")


@app.on_event("shutdown")
async def shutdown_event():
    """Shutdown tasks"""
    logger.info("Poker API shutting down")
    logger.info(f"Active games at shutdown: {len(games)}")
