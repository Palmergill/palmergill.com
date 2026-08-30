from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    false,
)
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime, timezone

import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./stock_data.db")

# Check if using PostgreSQL
is_postgres = DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")

if is_postgres:
    # PostgreSQL config - no special connect args needed
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,  # Verify connections before using
        pool_recycle=300,    # Recycle connections after 5 minutes
    )
else:
    # SQLite config for local dev
    engine = create_engine(
        DATABASE_URL, 
        connect_args={"check_same_thread": False}
    )
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_utc(value):
    """Serialize a stored timestamp unambiguously, as `utc_now`'s inverse.

    Every timestamp column on this site is filled by `utc_now`, which stores
    naive UTC. `datetime.isoformat()` on a naive value emits no offset, and
    JavaScript's `new Date()` reads an offsetless date-time string as *local*
    time — so a browser west of UTC parses every stored timestamp hours into
    the future. Anything serializing a stored datetime for a client should go
    through here rather than calling `.isoformat()` directly.
    """
    if value is None:
        return None
    if getattr(value, "tzinfo", None) is None:
        return f"{value.isoformat()}Z"
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EarningsRecord(Base):
    __tablename__ = "earnings"
    
    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, index=True)
    fiscal_date = Column(Date)
    period = Column(String)  # Q1, Q2, Q3, Q4, FY
    reported_eps = Column(Float, nullable=True)
    estimated_eps = Column(Float, nullable=True)
    surprise_pct = Column(Float, nullable=True)
    revenue = Column(Float, nullable=True)
    free_cash_flow = Column(Float, nullable=True)
    pe_ratio = Column(Float, nullable=True)  # Historical P/E at time of earnings
    price = Column(Float, nullable=True)  # Stock price at time of earnings
    fetched_at = Column(DateTime, default=utc_now)

class StockSummary(Base):
    __tablename__ = "stock_summaries"
    
    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, index=True, unique=True)
    name = Column(String)
    description = Column(Text, nullable=True)
    industry = Column(String, nullable=True)
    sector = Column(String, nullable=True)
    employees = Column(Integer, nullable=True)
    list_date = Column(Date, nullable=True)
    headquarters = Column(String, nullable=True)
    website = Column(String, nullable=True)
    market_cap = Column(Float, nullable=True)
    pe_ratio = Column(Float, nullable=True)
    next_earnings_date = Column(Date, nullable=True)
    # Additional metrics
    profit_margin = Column(Float, nullable=True)
    operating_margin = Column(Float, nullable=True)
    roe = Column(Float, nullable=True)
    debt_to_equity = Column(Float, nullable=True)
    dividend_yield = Column(Float, nullable=True)
    beta = Column(Float, nullable=True)
    price_52w_high = Column(Float, nullable=True)
    price_52w_low = Column(Float, nullable=True)
    current_price = Column(Float, nullable=True)
    # Key overview metrics
    revenue_growth = Column(Float, nullable=True)
    free_cash_flow = Column(Float, nullable=True)
    # Additional valuation metrics
    ps_ratio = Column(Float, nullable=True)
    pb_ratio = Column(Float, nullable=True)
    ev_ebitda = Column(Float, nullable=True)
    enterprise_value = Column(Float, nullable=True)
    shares_outstanding = Column(Float, nullable=True)
    # Profitability metrics
    gross_margin = Column(Float, nullable=True)
    ebitda_margin = Column(Float, nullable=True)
    roa = Column(Float, nullable=True)
    roic = Column(Float, nullable=True)
    # Financial health metrics
    current_ratio = Column(Float, nullable=True)
    quick_ratio = Column(Float, nullable=True)
    interest_coverage = Column(Float, nullable=True)
    cash = Column(Float, nullable=True)
    working_capital = Column(Float, nullable=True)
    # Market data
    avg_volume = Column(Float, nullable=True)
    fetched_at = Column(DateTime, default=utc_now)

class LogEntry(Base):
    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=utc_now, index=True)
    level = Column(String, index=True)  # DEBUG, INFO, WARNING, ERROR, CRITICAL
    logger_name = Column(String, nullable=True)
    message = Column(String)
    path = Column(String, nullable=True)  # request path if HTTP
    status_code = Column(Integer, nullable=True)
    method = Column(String, nullable=True)


class AnalyticsEvent(Base):
    __tablename__ = "analytics_events"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=utc_now, index=True)
    event_type = Column(String, index=True)  # request, page_view, app_event
    event_name = Column(String, nullable=True, index=True)
    app = Column(String, nullable=True, index=True)
    path = Column(String, nullable=True, index=True)
    method = Column(String, nullable=True)
    status_code = Column(Integer, nullable=True, index=True)
    outcome = Column(String, nullable=True, index=True)  # success, warning, error
    referrer = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)
    visitor_id = Column(String, nullable=True, index=True)
    session_id = Column(String, nullable=True, index=True)
    is_authenticated = Column(Boolean, default=False, index=True)
    is_admin = Column(Boolean, default=False, index=True)
    username = Column(String, nullable=True)
    duration_ms = Column(Float, nullable=True)
    metadata_json = Column(Text, nullable=True)


class AppUser(Base):
    """A member account. The admin identity still comes from APP_AUTH_*
    env vars and is deliberately not stored here — a database row can never
    grant admin, so a write bug in this table cannot escalate to the logs."""

    __tablename__ = "app_users"

    id = Column(Integer, primary_key=True, index=True)
    # Lowercased for lookup and uniqueness; display_name keeps the casing the
    # person typed at signup.
    username = Column(String, unique=True, index=True, nullable=False)
    display_name = Column(String, nullable=False)
    password_hash = Column(String, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utc_now)
    last_login_at = Column(DateTime, nullable=True)


class PokerGameState(Base):
    __tablename__ = "poker_game_states"

    game_id = Column(String, primary_key=True, index=True)
    payload = Column(LargeBinary, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, index=True)


# ── Fantasy football (spec 16) ──────────────────────────────────────────
#
# All tables are prefixed `ff_`. The design keeps two shapes:
#   * canonical/upsert tables (players, games, actual stats, meta) that
#     hold the current best-known value, and
#   * snapshot tables (projections, rankings, trending) whose rows are
#     never overwritten — each collector run appends a fresh set so history
#     (projection drift, rank changes) is a query over `fetched_at`.
# "Latest" for a snapshot table = rows of the newest successful
# FantasyCollectionRun for that (job, season, week). Betting/odds snapshot
# tables are added in a later phase.


class FantasyPlayer(Base):
    __tablename__ = "ff_players"

    # Sleeper's player_id is the canonical key site-wide; the other id
    # columns are the free crosswalk to nflverse (gsis_id) and others.
    player_id = Column(String, primary_key=True, index=True)
    full_name = Column(String, index=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    search_name = Column(String, index=True)  # normalized for name matching
    team = Column(String, nullable=True, index=True)
    position = Column(String, nullable=True, index=True)
    status = Column(String, nullable=True)  # Active, Inactive, ...
    injury_status = Column(String, nullable=True)
    age = Column(Integer, nullable=True)
    years_exp = Column(Integer, nullable=True)
    gsis_id = Column(String, nullable=True, index=True)
    espn_id = Column(String, nullable=True)
    yahoo_id = Column(String, nullable=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyCollectionRun(Base):
    __tablename__ = "ff_collection_runs"

    id = Column(Integer, primary_key=True, index=True)
    job = Column(String, index=True)  # players|state|projections|rankings|...
    source = Column(String, nullable=True)
    season = Column(Integer, nullable=True)
    week = Column(Integer, nullable=True)
    started_at = Column(DateTime, default=utc_now, index=True)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String, index=True)  # success|partial|error|skipped
    rows_written = Column(Integer, default=0)
    credits_used = Column(Integer, default=0)  # Odds API budget accounting
    detail = Column(Text, nullable=True)


class FantasyProjection(Base):
    __tablename__ = "ff_projections"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    season = Column(Integer, index=True)
    week = Column(Integer, index=True)  # 0 = season-long
    source = Column(String)  # sleeper|fantasypros|espn
    player_id = Column(String, index=True)
    pts_ppr = Column(Float, nullable=True)
    pts_half_ppr = Column(Float, nullable=True)
    pts_std = Column(Float, nullable=True)
    stats_json = Column(Text, nullable=True)  # component stats (pass_yd, ...)
    fetched_at = Column(DateTime, default=utc_now, index=True)


class FantasyRanking(Base):
    __tablename__ = "ff_rankings"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    season = Column(Integer, index=True)
    week = Column(Integer, nullable=True, index=True)  # 0 = season-long
    source = Column(String)  # fantasypros|derived
    scoring = Column(String)  # ppr|half|std
    position = Column(String, index=True)  # QB..DST|FLEX|ALL
    player_id = Column(String, index=True)
    rank = Column(Integer)
    ecr = Column(Float, nullable=True)  # expert consensus (FantasyPros)
    rank_min = Column(Integer, nullable=True)
    rank_max = Column(Integer, nullable=True)
    tier = Column(Integer, nullable=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)


class FantasyGame(Base):
    __tablename__ = "ff_games"

    game_id = Column(String, primary_key=True, index=True)  # nflverse game_id
    season = Column(Integer, index=True)
    week = Column(Integer, index=True)
    game_type = Column(String, nullable=True)  # REG, POST, ...
    kickoff = Column(DateTime, nullable=True)
    home_team = Column(String, nullable=True)
    away_team = Column(String, nullable=True)
    home_score = Column(Integer, nullable=True)
    away_score = Column(Integer, nullable=True)
    odds_event_id = Column(String, nullable=True, index=True)  # The Odds API id
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyPlayerStat(Base):
    __tablename__ = "ff_player_stats"

    # Actuals — upsert (unique per season/week/player), not snapshotted.
    id = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, index=True)
    week = Column(Integer, index=True)
    player_id = Column(String, index=True)
    team = Column(String, nullable=True)
    position = Column(String, nullable=True)
    opponent = Column(String, nullable=True)
    stats_json = Column(Text, nullable=True)
    fantasy_points_ppr = Column(Float, nullable=True)
    fantasy_points_half = Column(Float, nullable=True)
    fantasy_points_std = Column(Float, nullable=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyTrendingSnapshot(Base):
    __tablename__ = "ff_trending_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    kind = Column(String, index=True)  # add|drop
    player_id = Column(String, index=True)
    count = Column(Integer, nullable=True)  # adds/drops in the lookback window
    fetched_at = Column(DateTime, default=utc_now, index=True)


class FantasyOddsSnapshot(Base):
    __tablename__ = "ff_odds_snapshots"

    # Game lines time series. One row per bookmaker/market/outcome per fetch,
    # so line movement is a query ordered by fetched_at.
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)
    event_id = Column(String, index=True)  # The Odds API event id
    game_id = Column(String, nullable=True, index=True)  # matched ff_games
    commence_time = Column(DateTime, nullable=True)
    home_team = Column(String, nullable=True)  # abbr when mapped, else raw
    away_team = Column(String, nullable=True)
    bookmaker = Column(String)
    market = Column(String)  # h2h|spreads|totals
    outcome = Column(String)  # team or Over/Under
    price = Column(Integer, nullable=True)  # American odds
    point = Column(Float, nullable=True)


class FantasyPropSnapshot(Base):
    __tablename__ = "ff_prop_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)
    event_id = Column(String, index=True)
    game_id = Column(String, nullable=True, index=True)
    # player_id is nullable: unmatched names are kept (with the raw name) so
    # no collected data is dropped; an admin view can list the misses.
    player_id = Column(String, nullable=True, index=True)
    player_name_raw = Column(String)
    bookmaker = Column(String)
    market = Column(String)  # player_pass_yds|player_rush_yds|...
    outcome = Column(String)  # Over|Under|Yes
    price = Column(Integer, nullable=True)
    point = Column(Float, nullable=True)


class FantasySeasonPropSnapshot(Base):
    __tablename__ = "ff_season_prop_snapshots"

    # Regular-season player totals are a different market from the weekly
    # event props above. Keeping them separate prevents a season line from
    # being attached to (or hidden behind) a single game's event id.
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)
    season = Column(Integer, index=True)
    player_id = Column(String, nullable=True, index=True)
    player_name_raw = Column(String)
    provider_player_id = Column(String, nullable=True, index=True)
    bookmaker = Column(String)
    market = Column(String, index=True)
    outcome = Column(String)  # Over|Under
    price = Column(Integer, nullable=True)  # normalized American odds
    point = Column(Float, nullable=True)
    # When the provider last moved this quote, as opposed to when we last
    # fetched it. A season-long board can sit untouched for weeks, so the
    # collection time on its own overstates how current the prices are.
    quoted_at = Column(DateTime, nullable=True)


class FantasyFutureSnapshot(Base):
    __tablename__ = "ff_futures_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)
    market_key = Column(String, index=True)  # ..._super_bowl_winner, etc.
    bookmaker = Column(String)
    outcome = Column(String)  # team name
    price = Column(Integer, nullable=True)


class FantasyMeta(Base):
    __tablename__ = "ff_meta"

    # Small key/value store: cached NFL state, per-job next-due schedule,
    # Odds API x-requests-remaining, etc.
    key = Column(String, primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


# ── ESPN league hub (spec 17) ──────────────────────────────────────────
#
# One configured ESPN league, read keyless. These follow the same two shapes
# as the spec 16 tables above, but the split lands differently:
#
#   * Standings and matchups UPSERT. A final score is immutable and the
#     standings are a deterministic reduction of the completed schedule, so
#     any historical view is a recompute, not a lookup — snapshotting them
#     would store one redundant row per team per run forever.
#   * Rosters SNAPSHOT. "Who was on this roster in week 5" cannot be
#     recovered from any ESPN endpoint after the fact, so it has to be
#     captured. A change digest (ff_meta `league:roster_digest:{season}`)
#     skips the write when nothing moved, keeping steady-state growth to one
#     snapshot per real transaction.
#   * Power rankings SNAPSHOT, recomputed for every week on each run, so a
#     corrected or backfilled score fixes history instead of freezing a wrong
#     number in place.
#
# Every key is (season, espn_team_id) rather than a bare team id: ESPN team
# ids are only unique within a season, and this league went 12 teams to 10.


class FantasyLeagueSeason(Base):
    __tablename__ = "ff_league_seasons"
    __table_args__ = (
        UniqueConstraint("espn_league_id", "season", name="uq_ff_league_season"),
    )

    id = Column(Integer, primary_key=True, index=True)
    espn_league_id = Column(String, index=True)
    season = Column(Integer, index=True)
    name = Column(String, nullable=True)
    size = Column(Integer, nullable=True)
    current_matchup_period = Column(Integer, nullable=True)
    current_scoring_period = Column(Integer, nullable=True)
    first_scoring_period = Column(Integer, nullable=True)
    matchup_period_count = Column(Integer, nullable=True)
    regular_season_periods = Column(Integer, nullable=True)
    playoff_team_count = Column(Integer, nullable=True)
    divisions_json = Column(Text, nullable=True)
    lineup_slot_counts_json = Column(Text, nullable=True)
    # ok | unauthorized | error. `unauthorized` is a private season, which is
    # a stable expected state — the UI labels it rather than hiding it.
    status = Column(String, index=True, default="ok")
    last_error = Column(Text, nullable=True)
    run_id = Column(Integer, nullable=True, index=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyLeagueMember(Base):
    __tablename__ = "ff_league_members"
    __table_args__ = (
        UniqueConstraint("season", "member_guid", name="uq_ff_league_member"),
    )

    # ESPN puts ownership GUIDs on the team and the human names here, so this
    # is the crosswalk that turns a team into "whose team". Kept per-season
    # because managers join and leave.
    id = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, index=True)
    member_guid = Column(String, index=True)
    display_name = Column(String, nullable=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    run_id = Column(Integer, nullable=True, index=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyLeagueTeam(Base):
    __tablename__ = "ff_league_teams"
    __table_args__ = (
        UniqueConstraint("season", "espn_team_id", name="uq_ff_league_team"),
        Index("ix_ff_league_teams_season_seed", "season", "playoff_seed"),
    )

    id = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, index=True)
    espn_team_id = Column(Integer, index=True)
    name = Column(String, nullable=True)
    abbrev = Column(String, nullable=True)
    logo_url = Column(String, nullable=True)
    division_id = Column(Integer, nullable=True)
    division_name = Column(String, nullable=True)
    owner_guid = Column(String, nullable=True, index=True)
    owner_name = Column(String, nullable=True)
    playoff_seed = Column(Integer, nullable=True)
    wins = Column(Integer, default=0)
    losses = Column(Integer, default=0)
    ties = Column(Integer, default=0)
    points_for = Column(Float, default=0.0)
    points_against = Column(Float, default=0.0)
    win_pct = Column(Float, default=0.0)
    streak_length = Column(Integer, nullable=True)
    streak_type = Column(String, nullable=True)
    games_back = Column(Float, nullable=True)
    current_projected_rank = Column(Integer, nullable=True)  # ESPN's own
    run_id = Column(Integer, nullable=True, index=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyLeagueMatchup(Base):
    __tablename__ = "ff_league_matchups"
    __table_args__ = (
        UniqueConstraint("season", "espn_matchup_id", name="uq_ff_league_matchup"),
        Index("ix_ff_league_matchups_season_period", "season", "matchup_period"),
    )

    id = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, index=True)
    espn_matchup_id = Column(Integer, index=True)  # stable within a season
    matchup_period = Column(Integer, index=True)
    scoring_period = Column(Integer, nullable=True)
    playoff_tier = Column(String, nullable=True)  # NONE|WINNERS_BRACKET|...
    winner = Column(String, nullable=True)  # HOME|AWAY|TIE|UNDECIDED
    home_team_id = Column(Integer, index=True)
    home_points = Column(Float, nullable=True)
    home_points_by_period_json = Column(Text, nullable=True)
    # A bye has no away side. The row is kept so the scoreboard can show it,
    # but flagged so the ranking math never invents a phantom opponent.
    away_team_id = Column(Integer, nullable=True, index=True)
    away_points = Column(Float, nullable=True)
    away_points_by_period_json = Column(Text, nullable=True)
    is_bye = Column(Boolean, default=False)
    is_complete = Column(Boolean, default=False)
    run_id = Column(Integer, nullable=True, index=True)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class FantasyLeagueRosterEntry(Base):
    __tablename__ = "ff_league_roster_entries"
    __table_args__ = (
        Index("ix_ff_league_roster_run_team", "run_id", "espn_team_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    season = Column(Integer, index=True)
    scoring_period = Column(Integer, index=True)  # 0 in the preseason
    espn_team_id = Column(Integer, index=True)
    espn_player_id = Column(Integer, nullable=True)  # negative for D/ST
    # player_id is nullable for the same reason as ff_prop_snapshots: an
    # unmatched player is kept with its raw name rather than dropped.
    player_id = Column(String, nullable=True, index=True)
    player_name_raw = Column(String, nullable=True)
    lineup_slot_id = Column(Integer, nullable=True)
    lineup_slot = Column(String, nullable=True)  # QB|RB|FLEX|BENCH|IR|...
    position = Column(String, nullable=True)
    pro_team_id = Column(Integer, nullable=True)
    pro_team = Column(String, nullable=True)
    acquisition_type = Column(String, nullable=True)
    injury_status = Column(String, nullable=True)
    fetched_at = Column(DateTime, default=utc_now, index=True)


class FantasyLeaguePowerRanking(Base):
    __tablename__ = "ff_league_power_rankings"
    __table_args__ = (
        Index(
            "ix_ff_league_power_run_ctx", "run_id", "season", "week", "algorithm"
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    season = Column(Integer, index=True)
    week = Column(Integer, index=True)  # cumulative through this matchup period
    algorithm = Column(String, index=True)  # composite|record|consistency|...
    espn_team_id = Column(Integer, index=True)
    rank = Column(Integer)
    score = Column(Float, nullable=True)
    previous_rank = Column(Integer, nullable=True)
    # Materialized within the run (week N vs N-1) so the front end never joins.
    # Positive means the team moved up.
    rank_delta = Column(Integer, nullable=True)
    computed_at = Column(DateTime, default=utc_now, index=True)


class FantasyLeagueTeamOverview(Base):
    __tablename__ = "ff_league_team_overviews"
    __table_args__ = (
        UniqueConstraint(
            "season", "espn_team_id", "week", name="uq_ff_league_team_overview"
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    season = Column(Integer, index=True)
    espn_team_id = Column(Integer, index=True)
    week = Column(Integer, index=True)
    overview_md = Column(Text, nullable=True)
    model = Column(String, nullable=True)
    source = Column(String, nullable=True)  # model|local
    # Hash of the context the overview was written from. Regenerating when
    # this changes invalidates the cache on real movement instead of on a
    # timer that is always either too eager or too stale.
    prompt_digest = Column(String, nullable=True)
    generated_at = Column(DateTime, default=utc_now, index=True)


# ── Fantasy football draft-order game ──────────────────────────────────


class FantasyDraftSession(Base):
    """A live Fourth & Fortune room and its commit–reveal seed."""

    __tablename__ = "ff_draft_sessions"

    id = Column(String, primary_key=True, index=True)
    league_name = Column(String, nullable=False)
    join_code = Column(String, unique=True, index=True, nullable=False)
    master_seed = Column(String, nullable=False)
    seed_hash = Column(String, nullable=False)
    # The committed shuffle rules must survive deployments so an in-progress
    # or completed room always verifies under the rules it started with.
    game_version = Column(
        String,
        default="fourth-and-fortune-v2",
        server_default="fourth-and-fortune-v2",
        nullable=False,
    )
    mode = Column(String, default="league", server_default="league", nullable=False)
    state = Column(String, default="lobby", index=True, nullable=False)
    created_by = Column(String, index=True, nullable=False)
    current_player_id = Column(String, nullable=True, index=True)
    # A turn that has just ended is held on the table long enough for every
    # spectator's poll to see the card that ended it, then released.
    turn_state = Column(String, default="playing", server_default="playing", nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    # When the current manager was put on the clock. The host's skip is gated on
    # this so a rival cannot be written off the instant their turn opens.
    turn_started_at = Column(DateTime, nullable=True)
    last_event_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    revealed_at = Column(DateTime, nullable=True)


class FantasyDraftPlayer(Base):
    __tablename__ = "ff_draft_players"
    __table_args__ = (
        UniqueConstraint("session_id", "username", name="uq_ff_draft_player_account"),
    )

    id = Column(String, primary_key=True, index=True)
    session_id = Column(
        String,
        ForeignKey("ff_draft_sessions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # Normalized account name is the durable identity. display_name preserves
    # the casing chosen during account creation for the live room UI.
    username = Column(String, index=True, nullable=False)
    display_name = Column(String, nullable=False)
    is_bot = Column(Boolean, default=False, server_default=false(), nullable=False)
    turn_position = Column(Integer, nullable=True)
    final_score = Column(Integer, default=0, nullable=False)
    joined_at = Column(DateTime, default=utc_now, nullable=False)


class FantasyDraftRound(Base):
    __tablename__ = "ff_draft_rounds"
    __table_args__ = (
        UniqueConstraint("player_id", "round_number", name="uq_ff_draft_player_round"),
    )

    id = Column(String, primary_key=True, index=True)
    session_id = Column(
        String,
        ForeignKey("ff_draft_sessions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    player_id = Column(
        String,
        ForeignKey("ff_draft_players.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    round_number = Column(Integer, nullable=False)
    cards_json = Column(Text, default="[]", nullable=False)
    score = Column(Integer, default=0, nullable=False)
    busted = Column(Boolean, default=False, nullable=False)
    state = Column(String, default="active", index=True, nullable=False)
    started_at = Column(DateTime, default=utc_now, nullable=False)
    ended_at = Column(DateTime, nullable=True)


class FantasyDraftFlip(Base):
    __tablename__ = "ff_draft_flips"
    __table_args__ = (
        UniqueConstraint("player_id", "deck_index", name="uq_ff_draft_player_deck_index"),
    )

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(
        String,
        ForeignKey("ff_draft_sessions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    player_id = Column(
        String,
        ForeignKey("ff_draft_players.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    round_id = Column(
        String,
        ForeignKey("ff_draft_rounds.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    card = Column(String, nullable=False)
    deck_index = Column(Integer, nullable=False)
    timestamp = Column(DateTime, default=utc_now, nullable=False)


# ── Personal ranking boards (spec 18) ────────────────────────────────────────
# A member's own fantasy rankings. The load-bearing decision is that a board
# stores ONE order, not five: the QB list is the overall list filtered to QBs.
# The product rule is "positional order is authoritative, and an overall drag
# reorders within the position", which means the positional lists carry no
# information the overall list does not already have. Storing a second key per
# position would double every write and turn that rule into something enforced
# rather than something true by construction.


class FantasyRankBoard(Base):
    """One member's ranking board for a (season, scoring, roster) combination."""

    __tablename__ = "ff_rank_boards"
    __table_args__ = (
        UniqueConstraint(
            "username", "season", "scoring", "roster", name="uq_ff_rank_board_owner"
        ),
        Index("ix_ff_rank_boards_public", "published", "season", "scoring", "roster"),
    )

    id = Column(Integer, primary_key=True, index=True)
    # Normalized account name is the durable identity, matching ff_draft_players:
    # a ForeignKey to app_users would exclude the admin, who authenticates from
    # env vars and has no row there.
    username = Column(String, index=True, nullable=False)
    display_name = Column(String, nullable=False)
    season = Column(Integer, index=True, nullable=False)
    scoring = Column(String, nullable=False)
    # "1qb" | "superflex". Deliberately a separate axis from scoring rather than
    # a fourth scoring value: superflex changes replacement level, not how points
    # are awarded, and `scoring` has to stay a real ppr/half/std because
    # normalize_scoring() validates it and the seed passes it straight into
    # fantasy_data.get_rankings(). A string leaves room for "2qb" later.
    roster = Column(String, default="1qb", server_default="1qb", nullable=False)
    title = Column(String, nullable=True)
    # Minted at create time, not at publish, so publishing is a pure boolean flip
    # and re-publishing restores the same link. Opaque so boards are not
    # enumerable.
    share_slug = Column(String, unique=True, index=True, nullable=False)
    published = Column(Boolean, default=False, server_default=false(), nullable=False)
    published_at = Column(DateTime, nullable=True)
    # Provenance of the seed, so a board can say what it was built from.
    seeded_from = Column(String, nullable=True)
    seed_run_id = Column(Integer, nullable=True)
    # Optimistic-concurrency token. Every write carries the revision the client
    # last saw; a mismatch means another tab moved something and the client is
    # told to reload rather than silently interleaving two people's intent.
    revision = Column(Integer, default=1, server_default="1", nullable=False)
    # SQLAlchemy includes the loaded revision in every UPDATE/DELETE predicate
    # and increments it atomically. A read-then-compare in application code is
    # not sufficient: two request sessions can both observe the same revision.
    __mapper_args__ = {"version_id_col": revision}
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class FantasyRankEntry(Base):
    """One player's place on a board."""

    __tablename__ = "ff_rank_entries"
    __table_args__ = (
        UniqueConstraint("board_id", "player_id", name="uq_ff_rank_entry_player"),
        Index("ix_ff_rank_entries_board_key", "board_id", "sort_key"),
        Index("ix_ff_rank_entries_board_pos", "board_id", "position", "sort_key"),
    )

    id = Column(Integer, primary_key=True, index=True)
    board_id = Column(
        Integer,
        ForeignKey("ff_rank_boards.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # References ff_players.player_id but deliberately WITHOUT a ForeignKey.
    # ff_players is a collector-owned snapshot table; a constraint with a cascade
    # would let a scheduled collection run mutate a member's hand-built board.
    # The join happens in Python, and a player who vanishes renders as a tombstone
    # row the owner can remove.
    player_id = Column(String, index=True, nullable=False)
    # Snapshotted at seed/add time. If the catalog reclassifies a player, the
    # board must not silently reshuffle between page loads.
    position = Column(String, index=True, nullable=False)
    # Sparse: seeded at 1000, 2000, ... so a drag writes one row (the midpoint of
    # its new neighbors) instead of renumbering 300. Display rank is never stored
    # — it is derived densely on read.
    sort_key = Column(Float, nullable=False)
    # Where the seed originally put this player overall. Kept so the board can
    # show "you have him 14 spots higher than the consensus did" without
    # recomputing the seed.
    seed_rank = Column(Integer, nullable=True)
    note = Column(String, nullable=True)
    added_at = Column(DateTime, default=utc_now, nullable=False)


class FantasyRankTier(Base):
    """A named cut point in a board's ordering.

    A tier is not an attribute of an entry — it is a divider living in the same
    float key space, so dragging a player past one changes his tier for free and
    there is no membership column to orphan.
    """

    __tablename__ = "ff_rank_tiers"
    __table_args__ = (
        Index("ix_ff_rank_tiers_board_scope", "board_id", "scope", "sort_key"),
    )

    id = Column(Integer, primary_key=True, index=True)
    board_id = Column(
        Integer,
        ForeignKey("ff_rank_boards.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # OVERALL | QB | RB | WR | TE. A QB-scope divider is simply never merged into
    # the overall or RB lists.
    scope = Column(String, nullable=False)
    label = Column(String, nullable=False)
    sort_key = Column(Float, nullable=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
