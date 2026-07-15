"""Fantasy data collection: run-log bookkeeping, upserts, and scheduling.

Each public ``collect_*`` function runs one job end-to-end: it opens a
FantasyCollectionRun row, does its work against an injected source client
(so tests can pass fakes), writes rows, and closes the run with a status.
``run_scheduled`` is the cadence driver the lifespan loop calls; it reads the
cached NFL state and a per-job next-due timestamp stored in ``ff_meta``.

Snapshot jobs (projections, rankings, trending) always append a fresh set of
rows tagged with their run id — never an overwrite — so history accumulates.
Upsert jobs (players, schedule, weekly stats) hold the current best value.
"""
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.database import (
    FantasyCollectionRun,
    FantasyFutureSnapshot,
    FantasyGame,
    FantasyMeta,
    FantasyOddsSnapshot,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyPropSnapshot,
    FantasyRanking,
    FantasyTrendingSnapshot,
    utc_now,
)
from app.services.fantasy_common import (
    FLEX_POSITIONS,
    SCORING_FORMATS,
    SCORING_POINTS_FIELD,
    SKILL_POSITIONS,
    coerce_int,
    normalize_name,
    normalize_position,
)
from app.services.fantasy_nflverse import nflverse_client
from app.services.fantasy_odds import (
    FUTURES_MARKETS,
    GAME_MARKETS,
    PROP_MARKETS,
    odds_client,
    parse_event_props,
    parse_futures,
    parse_game_odds,
)
from app.services.fantasy_sleeper import parse_trending_rows, sleeper_client

logger = logging.getLogger(__name__)

# All jobs a scheduler tick may run, plus their cadence in seconds keyed by
# whether the NFL season is active. rankings is derived from stored
# projections, so it is run right after projections rather than on its own
# timer (see run_scheduled).
JOB_INTERVALS_SECONDS = {
    "state": {"in_season": 3600, "off_season": 3600},
    "players": {"in_season": 24 * 3600, "off_season": 24 * 3600},
    "schedule": {"in_season": 7 * 24 * 3600, "off_season": 7 * 24 * 3600},
    "projections": {"in_season": 12 * 3600, "off_season": 7 * 24 * 3600},
    "weekly_stats": {"in_season": 24 * 3600, "off_season": 30 * 24 * 3600},
    "trending": {"in_season": 24 * 3600, "off_season": 7 * 24 * 3600},
    "odds_lines": {"in_season": 2 * 24 * 3600, "off_season": 7 * 24 * 3600},
    "odds_props": {"in_season": 3 * 24 * 3600, "off_season": 30 * 24 * 3600},
    "odds_futures": {"in_season": 7 * 24 * 3600, "off_season": 7 * 24 * 3600},
}

_STATE_META_KEY = "nfl_state"
_DUE_META_PREFIX = "due:"


# ── meta key/value helpers ──────────────────────────────────────────────


def get_meta(db: Session, key: str) -> Optional[str]:
    row = db.get(FantasyMeta, key)
    return row.value if row else None


def set_meta(db: Session, key: str, value: str) -> None:
    row = db.get(FantasyMeta, key)
    if row is None:
        db.add(FantasyMeta(key=key, value=value))
    else:
        row.value = value
        row.updated_at = utc_now()


def get_cached_state(db: Session) -> Dict[str, Any]:
    raw = get_meta(db, _STATE_META_KEY)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def current_season_week(db: Session) -> Dict[str, Any]:
    """Return {season, week, season_type} from cached state, with fallbacks."""
    state = get_cached_state(db)
    season = coerce_int(state.get("season")) or coerce_int(state.get("league_season"))
    week = coerce_int(state.get("week")) or coerce_int(state.get("display_week")) or 1
    season_type = state.get("season_type") or "regular"
    return {"season": season, "week": week, "season_type": season_type}


def is_in_season(season_type: Optional[str]) -> bool:
    return (season_type or "").lower() in ("regular", "post")


# ── run-log helpers ─────────────────────────────────────────────────────


def _start_run(
    db: Session,
    job: str,
    source: Optional[str] = None,
    season: Optional[int] = None,
    week: Optional[int] = None,
) -> FantasyCollectionRun:
    run = FantasyCollectionRun(
        job=job,
        source=source,
        season=season,
        week=week,
        started_at=utc_now(),
        status="running",
        rows_written=0,
        credits_used=0,
    )
    db.add(run)
    db.commit()  # assign run.id so snapshot rows can reference it
    db.refresh(run)
    return run


def _finish_run(
    db: Session,
    run: FantasyCollectionRun,
    status: str,
    rows_written: int = 0,
    detail: Optional[str] = None,
    credits_used: int = 0,
) -> FantasyCollectionRun:
    run.status = status
    run.rows_written = rows_written
    run.credits_used = credits_used
    run.detail = detail
    run.finished_at = utc_now()
    db.commit()
    db.refresh(run)
    return run


def latest_successful_run(
    db: Session,
    job: str,
    season: Optional[int] = None,
    week: Optional[int] = None,
) -> Optional[FantasyCollectionRun]:
    query = db.query(FantasyCollectionRun).filter(
        FantasyCollectionRun.job == job,
        FantasyCollectionRun.status == "success",
    )
    if season is not None:
        query = query.filter(FantasyCollectionRun.season == season)
    if week is not None:
        query = query.filter(FantasyCollectionRun.week == week)
    return query.order_by(FantasyCollectionRun.id.desc()).first()


def monthly_credits_used(db: Session, now: Optional[datetime] = None) -> int:
    """Sum Odds API credits spent so far this calendar month (P3 uses this)."""
    now = now or utc_now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    total = (
        db.query(FantasyCollectionRun)
        .filter(FantasyCollectionRun.started_at >= month_start)
        .with_entities(FantasyCollectionRun.credits_used)
        .all()
    )
    return sum(row[0] or 0 for row in total)


# ── collectors ──────────────────────────────────────────────────────────


def collect_state(db: Session, client=None) -> FantasyCollectionRun:
    client = client or sleeper_client
    run = _start_run(db, "state", "sleeper")
    try:
        state = client.get_state()
    except Exception as exc:
        logger.warning("Sleeper state fetch failed: %s", exc)
        return _finish_run(db, run, "error", detail=str(exc))
    set_meta(db, _STATE_META_KEY, json.dumps(state))
    db.commit()
    return _finish_run(db, run, "success", rows_written=1)


def collect_players(db: Session, client=None) -> FantasyCollectionRun:
    client = client or sleeper_client
    run = _start_run(db, "players", "sleeper")
    try:
        dump = client.get_players()
    except Exception as exc:
        logger.warning("Sleeper players fetch failed: %s", exc)
        return _finish_run(db, run, "error", detail=str(exc))

    existing = {p.player_id: p for p in db.query(FantasyPlayer).all()}
    written = 0
    for pid, raw in dump.items():
        if not isinstance(raw, dict):
            continue
        position = normalize_position(raw.get("position"))
        if position not in SKILL_POSITIONS:
            continue
        full_name = raw.get("full_name") or " ".join(
            part for part in (raw.get("first_name"), raw.get("last_name")) if part
        ) or raw.get("last_name") or str(pid)
        fields = {
            "full_name": full_name,
            "first_name": raw.get("first_name"),
            "last_name": raw.get("last_name"),
            "search_name": normalize_name(full_name),
            "team": raw.get("team"),
            "position": position,
            "status": raw.get("status"),
            "injury_status": raw.get("injury_status"),
            "age": coerce_int(raw.get("age")),
            "years_exp": coerce_int(raw.get("years_exp")),
            "gsis_id": _as_str(raw.get("gsis_id")),
            "espn_id": _as_str(raw.get("espn_id")),
            "yahoo_id": _as_str(raw.get("yahoo_id")),
        }
        player = existing.get(str(pid))
        if player is None:
            db.add(FantasyPlayer(player_id=str(pid), **fields))
        else:
            for key, value in fields.items():
                setattr(player, key, value)
        written += 1

    db.commit()
    return _finish_run(db, run, "success", rows_written=written)


def collect_trending(db: Session, client=None) -> FantasyCollectionRun:
    client = client or sleeper_client
    run = _start_run(db, "trending", "sleeper")
    written = 0
    try:
        for kind in ("add", "drop"):
            rows = parse_trending_rows(client.get_trending(kind))
            for row in rows:
                db.add(
                    FantasyTrendingSnapshot(
                        run_id=run.id,
                        kind=kind,
                        player_id=row["player_id"],
                        count=row["count"],
                        fetched_at=utc_now(),
                    )
                )
                written += 1
    except Exception as exc:
        logger.warning("Sleeper trending fetch failed: %s", exc)
        return _finish_run(db, run, "error", rows_written=written, detail=str(exc))
    db.commit()
    return _finish_run(db, run, "success", rows_written=written)


def collect_projections(
    db: Session, season: int, week: int, client=None
) -> FantasyCollectionRun:
    client = client or sleeper_client
    run = _start_run(db, "projections", "sleeper", season, week)
    try:
        rows = client.get_projections(season, week)
    except Exception as exc:
        logger.warning("Sleeper projections fetch failed (%s wk %s): %s", season, week, exc)
        return _finish_run(db, run, "error", detail=str(exc))

    known = {pid for (pid,) in db.query(FantasyPlayer.player_id).all()}
    written = 0
    for row in rows:
        if row["player_id"] not in known:
            continue
        db.add(
            FantasyProjection(
                run_id=run.id,
                season=season,
                week=week,
                source="sleeper",
                player_id=row["player_id"],
                pts_ppr=row["pts_ppr"],
                pts_half_ppr=row["pts_half_ppr"],
                pts_std=row["pts_std"],
                stats_json=json.dumps(row["stats"]),
                fetched_at=utc_now(),
            )
        )
        written += 1
    db.commit()
    status = "success" if written else "partial"
    detail = None if written else "no projection rows matched known players"
    return _finish_run(db, run, status, rows_written=written, detail=detail)


def build_derived_rankings(db: Session, season: int, week: int) -> FantasyCollectionRun:
    """Derive rankings from the latest projection snapshot for the week.

    Produces one ranking list per scoring format for each position, plus
    FLEX and overall (ALL). This is the fallback that keeps the rankings UI
    alive without the optional FantasyPros key.
    """
    run = _start_run(db, "rankings", "derived", season, week)
    proj_run = latest_successful_run(db, "projections", season, week)
    if proj_run is None:
        return _finish_run(db, run, "partial", detail="no projections snapshot to rank")

    projections = db.query(FantasyProjection).filter(FantasyProjection.run_id == proj_run.id).all()
    positions = {p.player_id: p.position for p in db.query(FantasyPlayer).all()}

    written = 0
    now = utc_now()
    for scoring in SCORING_FORMATS:
        points_field = SCORING_POINTS_FIELD[scoring]
        scored = []
        for proj in projections:
            points = getattr(proj, points_field)
            if points is None:
                continue
            scored.append((proj.player_id, positions.get(proj.player_id), points))

        groups: Dict[str, List] = {"ALL": [], "FLEX": []}
        for pos in SKILL_POSITIONS:
            groups[pos] = []
        for player_id, position, points in scored:
            groups["ALL"].append((player_id, points))
            if position in SKILL_POSITIONS:
                groups[position].append((player_id, points))
            if position in FLEX_POSITIONS:
                groups["FLEX"].append((player_id, points))

        for position, entries in groups.items():
            entries.sort(key=lambda item: item[1], reverse=True)
            for rank, (player_id, points) in enumerate(entries, start=1):
                db.add(
                    FantasyRanking(
                        run_id=run.id,
                        season=season,
                        week=week,
                        source="derived",
                        scoring=scoring,
                        position=position,
                        player_id=player_id,
                        rank=rank,
                        ecr=round(float(points), 2),
                        fetched_at=now,
                    )
                )
                written += 1

    db.commit()
    return _finish_run(db, run, "success", rows_written=written)


def collect_schedule(db: Session, season: int, client=None) -> FantasyCollectionRun:
    client = client or nflverse_client
    run = _start_run(db, "schedule", "nflverse", season)
    try:
        games = client.get_schedule(season)
    except Exception as exc:
        logger.warning("nflverse schedule fetch failed (%s): %s", season, exc)
        return _finish_run(db, run, "error", detail=str(exc))

    existing = {
        g.game_id: g
        for g in db.query(FantasyGame).filter(FantasyGame.season == season).all()
    }
    written = 0
    for game in games:
        fields = {
            "season": game["season"],
            "week": game["week"],
            "game_type": game["game_type"],
            "kickoff": game["kickoff"],
            "home_team": game["home_team"],
            "away_team": game["away_team"],
            "home_score": game["home_score"],
            "away_score": game["away_score"],
        }
        row = existing.get(game["game_id"])
        if row is None:
            db.add(FantasyGame(game_id=game["game_id"], **fields))
        else:
            for key, value in fields.items():
                setattr(row, key, value)
        written += 1
    db.commit()
    return _finish_run(db, run, "success", rows_written=written)


def collect_weekly_stats(db: Session, season: int, client=None) -> FantasyCollectionRun:
    client = client or nflverse_client
    run = _start_run(db, "weekly_stats", "nflverse", season)
    try:
        rows = client.get_weekly_stats(season)
    except Exception as exc:
        logger.warning("nflverse weekly stats fetch failed (%s): %s", season, exc)
        return _finish_run(db, run, "error", detail=str(exc))

    # Map GSIS ids to canonical Sleeper player_ids; drop rows we can't map.
    gsis_to_player = {
        gsis: pid
        for pid, gsis in db.query(FantasyPlayer.player_id, FantasyPlayer.gsis_id).all()
        if gsis
    }
    existing = {
        (s.week, s.player_id): s
        for s in db.query(FantasyPlayerStat).filter(FantasyPlayerStat.season == season).all()
    }
    written = 0
    for row in rows:
        player_id = gsis_to_player.get(row["gsis_id"])
        if not player_id or row["week"] is None:
            continue
        fields = {
            "team": row["team"],
            "position": row["position"],
            "opponent": row["opponent"],
            "stats_json": json.dumps(row["stats"]),
            "fantasy_points_ppr": row["fantasy_points_ppr"],
            "fantasy_points_half": row["fantasy_points_half"],
            "fantasy_points_std": row["fantasy_points_std"],
        }
        stat = existing.get((row["week"], player_id))
        if stat is None:
            db.add(
                FantasyPlayerStat(
                    season=season, week=row["week"], player_id=player_id, **fields
                )
            )
        else:
            for key, value in fields.items():
                setattr(stat, key, value)
        written += 1
    db.commit()
    return _finish_run(db, run, "success", rows_written=written)


# ── betting (The Odds API) ──────────────────────────────────────────────
#
# Every Odds API call spends from a 500-credit/month free-tier budget. Each
# job checks the month-to-date spend (summed from the run log) against
# ODDS_API_MONTHLY_BUDGET before calling out and records a `skipped` run
# rather than overspending. Without ODDS_API_KEY the jobs skip cleanly, so
# they are safe to leave scheduled until a key is configured.


def odds_monthly_budget() -> int:
    try:
        return int(os.getenv("ODDS_API_MONTHLY_BUDGET", "450"))
    except ValueError:
        return 450


def odds_budget_remaining(db: Session) -> int:
    return odds_monthly_budget() - monthly_credits_used(db)


def _record_remaining(db: Session, client) -> None:
    if getattr(client, "last_remaining", None) is not None:
        set_meta(db, "odds_requests_remaining", str(client.last_remaining))
        db.commit()


def _match_event_to_game(db, home, away, commence, season):
    """Match an Odds API event to an ff_games row by teams + kickoff date."""
    query = db.query(FantasyGame).filter(
        FantasyGame.home_team == home, FantasyGame.away_team == away
    )
    if season:
        query = query.filter(FantasyGame.season == season)
    candidates = query.all()
    if not candidates:
        return None
    if commence:
        best, best_diff = None, None
        for game in candidates:
            if game.kickoff is None:
                continue
            diff = abs((game.kickoff - commence).total_seconds())
            if best_diff is None or diff < best_diff:
                best, best_diff = game, diff
        # Accept only if within a 3-day window of the scheduled kickoff.
        if best is not None and (best_diff is None or best_diff <= 3 * 86400):
            return best
    return candidates[0]


def _prop_player_map(db, *teams) -> Dict[str, str]:
    """Normalized-name -> player_id for players on the given teams."""
    team_list = [t for t in teams if t]
    query = db.query(FantasyPlayer.player_id, FantasyPlayer.search_name)
    if team_list:
        query = query.filter(FantasyPlayer.team.in_(team_list))
    return {name: pid for pid, name in query.all() if name}


def collect_odds_lines(db: Session, client=None, markets=GAME_MARKETS) -> FantasyCollectionRun:
    client = client or odds_client
    run = _start_run(db, "odds_lines", "the-odds-api")
    if not client.configured:
        return _finish_run(db, run, "skipped", detail="ODDS_API_KEY not set")
    cost = client.game_odds_cost(markets)
    if cost > odds_budget_remaining(db):
        return _finish_run(db, run, "skipped", detail="monthly Odds API budget exhausted")
    try:
        rows = parse_game_odds(client.get_game_odds(markets))
    except Exception as exc:
        logger.warning("Odds lines fetch failed: %s", exc)
        return _finish_run(db, run, "error", detail=str(exc))

    season = current_season_week(db)["season"]
    now = utc_now()
    matched: Dict[str, Any] = {}
    written = 0
    for row in rows:
        event_id = row["event_id"]
        if event_id not in matched:
            game = _match_event_to_game(db, row["home_team"], row["away_team"], row["commence_time"], season)
            matched[event_id] = game
            if game is not None:
                game.odds_event_id = event_id
        game = matched[event_id]
        db.add(
            FantasyOddsSnapshot(
                run_id=run.id,
                fetched_at=now,
                event_id=event_id,
                game_id=game.game_id if game else None,
                commence_time=row["commence_time"],
                home_team=row["home_team"],
                away_team=row["away_team"],
                bookmaker=row["bookmaker"],
                market=row["market"],
                outcome=row["outcome"],
                price=row["price"],
                point=row["point"],
            )
        )
        written += 1
    db.commit()
    _record_remaining(db, client)
    return _finish_run(db, run, "success", rows_written=written, credits_used=cost)


def select_featured_events(db: Session, limit: int) -> List[Dict[str, Any]]:
    """Pick featured games from the latest lines snapshot: closest spreads
    first (the games props are most interesting for)."""
    run = latest_successful_run(db, "odds_lines")
    if run is None:
        return []
    rows = db.query(FantasyOddsSnapshot).filter(FantasyOddsSnapshot.run_id == run.id).all()
    events: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        entry = events.setdefault(
            row.event_id,
            {"event_id": row.event_id, "game_id": row.game_id, "home": row.home_team, "away": row.away_team, "spread": None},
        )
        if row.market == "spreads" and row.point is not None:
            magnitude = abs(row.point)
            if entry["spread"] is None or magnitude < entry["spread"]:
                entry["spread"] = magnitude
    ordered = sorted(
        events.values(),
        key=lambda e: (e["spread"] is None, e["spread"] if e["spread"] is not None else 1e9),
    )
    return ordered[:limit]


def collect_odds_props(db: Session, client=None, limit=None, markets=PROP_MARKETS) -> FantasyCollectionRun:
    client = client or odds_client
    if limit is None:
        limit = int(os.getenv("FANTASY_FEATURED_GAMES", "4"))
    run = _start_run(db, "odds_props", "the-odds-api")
    if not client.configured:
        return _finish_run(db, run, "skipped", detail="ODDS_API_KEY not set")

    featured = select_featured_events(db, limit)
    if not featured:
        return _finish_run(db, run, "partial", detail="no featured games (run odds_lines first)")

    per_event = client.event_props_cost(markets)
    affordable = odds_budget_remaining(db) // per_event if per_event else 0
    if affordable <= 0:
        return _finish_run(db, run, "skipped", detail="monthly Odds API budget exhausted")
    featured = featured[:affordable]

    now = utc_now()
    written, credits = 0, 0
    for feat in featured:
        try:
            payload = client.get_event_props(feat["event_id"], markets)
        except Exception as exc:
            logger.warning("Odds props fetch failed for %s: %s", feat["event_id"], exc)
            continue
        credits += per_event
        name_map = _prop_player_map(db, feat["home"], feat["away"])
        for prop in parse_event_props(payload):
            player_id = name_map.get(normalize_name(prop["player_name_raw"]))
            db.add(
                FantasyPropSnapshot(
                    run_id=run.id,
                    fetched_at=now,
                    event_id=feat["event_id"],
                    game_id=feat["game_id"],
                    player_id=player_id,
                    player_name_raw=prop["player_name_raw"],
                    bookmaker=prop["bookmaker"],
                    market=prop["market"],
                    outcome=prop["outcome"],
                    price=prop["price"],
                    point=prop["point"],
                )
            )
            written += 1
    db.commit()
    _record_remaining(db, client)
    status = "success" if credits else "error"
    detail = None if credits else "all featured prop fetches failed"
    return _finish_run(db, run, status, rows_written=written, detail=detail, credits_used=credits)


def collect_odds_futures(db: Session, client=None, markets=FUTURES_MARKETS) -> FantasyCollectionRun:
    client = client or odds_client
    run = _start_run(db, "odds_futures", "the-odds-api")
    if not client.configured:
        return _finish_run(db, run, "skipped", detail="ODDS_API_KEY not set")

    per_call = client.futures_cost()
    remaining = odds_budget_remaining(db)
    now = utc_now()
    written, credits = 0, 0
    for market_key in markets:
        if credits + per_call > remaining:
            break
        try:
            payload = client.get_futures(market_key)
        except Exception as exc:
            logger.warning("Odds futures fetch failed for %s: %s", market_key, exc)
            continue
        credits += per_call
        for future in parse_futures(payload):
            db.add(
                FantasyFutureSnapshot(
                    run_id=run.id,
                    fetched_at=now,
                    market_key=market_key,
                    bookmaker=future["bookmaker"],
                    outcome=future["outcome"],
                    price=future["price"],
                )
            )
            written += 1
    db.commit()
    _record_remaining(db, client)
    if credits == 0:
        return _finish_run(db, run, "skipped", detail="monthly Odds API budget exhausted")
    return _finish_run(db, run, "success", rows_written=written, credits_used=credits)


# ── scheduling ──────────────────────────────────────────────────────────


def _job_due(db: Session, job: str, now: datetime) -> bool:
    raw = get_meta(db, f"{_DUE_META_PREFIX}{job}")
    if not raw:
        return True
    try:
        return datetime.fromisoformat(raw) <= now
    except ValueError:
        return True


def _mark_next_due(db: Session, job: str, now: datetime, in_season: bool) -> None:
    cadence = JOB_INTERVALS_SECONDS.get(job)
    if not cadence:
        return
    seconds = cadence["in_season" if in_season else "off_season"]
    set_meta(db, f"{_DUE_META_PREFIX}{job}", (now + timedelta(seconds=seconds)).isoformat())
    db.commit()


def run_scheduled(db: Session, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Run whichever jobs are due. Returns a summary per job that ran."""
    now = now or utc_now()
    summaries: List[Dict[str, Any]] = []

    # State first — it seeds season/week/season_type for everything else.
    if _job_due(db, "state", now):
        run = collect_state(db)
        summaries.append(_summary(run))
        _mark_next_due(db, "state", now, in_season=True)

    ctx = current_season_week(db)
    season, week, season_type = ctx["season"], ctx["week"], ctx["season_type"]
    in_season = is_in_season(season_type)

    if _job_due(db, "players", now):
        summaries.append(_summary(collect_players(db)))
        _mark_next_due(db, "players", now, in_season)

    if season and _job_due(db, "schedule", now):
        summaries.append(_summary(collect_schedule(db, season)))
        _mark_next_due(db, "schedule", now, in_season)

    if season and _job_due(db, "weekly_stats", now):
        summaries.append(_summary(collect_weekly_stats(db, season)))
        _mark_next_due(db, "weekly_stats", now, in_season)

    if _job_due(db, "trending", now):
        summaries.append(_summary(collect_trending(db)))
        _mark_next_due(db, "trending", now, in_season)

    if season and week and _job_due(db, "projections", now):
        proj_run = collect_projections(db, season, week)
        summaries.append(_summary(proj_run))
        _mark_next_due(db, "projections", now, in_season)
        # Rankings are derived from the snapshot we just took.
        summaries.append(_summary(build_derived_rankings(db, season, week)))

    # Betting jobs. They self-skip when ODDS_API_KEY is unset or the monthly
    # budget is spent. Futures are live year-round; lines/props only in-season
    # (there are no games to price in the offseason).
    if _job_due(db, "odds_futures", now):
        summaries.append(_summary(collect_odds_futures(db)))
        _mark_next_due(db, "odds_futures", now, in_season)
    if in_season and _job_due(db, "odds_lines", now):
        summaries.append(_summary(collect_odds_lines(db)))
        _mark_next_due(db, "odds_lines", now, in_season)
    if in_season and _job_due(db, "odds_props", now):
        summaries.append(_summary(collect_odds_props(db)))
        _mark_next_due(db, "odds_props", now, in_season)

    return summaries


def run_job(db: Session, job: str) -> FantasyCollectionRun:
    """Run a single named job on demand (admin refresh). Uses current state."""
    ctx = current_season_week(db)
    season, week = ctx["season"], ctx["week"]
    if job == "state":
        return collect_state(db)
    if job == "players":
        return collect_players(db)
    if job == "trending":
        return collect_trending(db)
    if job == "schedule":
        if not season:
            raise ValueError("no season known — run the state job first")
        return collect_schedule(db, season)
    if job == "weekly_stats":
        if not season:
            raise ValueError("no season known — run the state job first")
        return collect_weekly_stats(db, season)
    if job == "projections":
        if not (season and week):
            raise ValueError("no season/week known — run the state job first")
        return collect_projections(db, season, week)
    if job == "rankings":
        if not (season and week):
            raise ValueError("no season/week known — run the state job first")
        return build_derived_rankings(db, season, week)
    if job == "odds_lines":
        return collect_odds_lines(db)
    if job == "odds_props":
        return collect_odds_props(db)
    if job == "odds_futures":
        return collect_odds_futures(db)
    raise ValueError(f"unknown job: {job}")


REFRESHABLE_JOBS = (
    "state",
    "players",
    "trending",
    "schedule",
    "weekly_stats",
    "projections",
    "rankings",
    "odds_lines",
    "odds_props",
    "odds_futures",
)


def backfill_season(
    db: Session, season: int, weeks: Optional[Iterable[int]] = None
) -> List[Dict[str, Any]]:
    """One-time historical load: schedule + weekly actuals + per-week
    projections/rankings for a completed season (used for the 2025 offseason
    backfill so the app has real data before Week 1)."""
    weeks = list(weeks) if weeks is not None else list(range(1, 19))
    summaries = [_summary(collect_schedule(db, season)), _summary(collect_weekly_stats(db, season))]
    for week in weeks:
        summaries.append(_summary(collect_projections(db, season, week)))
        summaries.append(_summary(build_derived_rankings(db, season, week)))
    return summaries


def _summary(run: FantasyCollectionRun) -> Dict[str, Any]:
    return {
        "job": run.job,
        "season": run.season,
        "week": run.week,
        "status": run.status,
        "rows_written": run.rows_written,
        "detail": run.detail,
    }


def _as_str(value) -> Optional[str]:
    if value is None or value == "":
        return None
    return str(value)
