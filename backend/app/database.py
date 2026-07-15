from sqlalchemy import create_engine, Column, String, Float, Date, DateTime, Integer, LargeBinary, Boolean, Text
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
    week = Column(Integer, index=True)
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
    week = Column(Integer, nullable=True, index=True)  # NULL = seasonal
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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
