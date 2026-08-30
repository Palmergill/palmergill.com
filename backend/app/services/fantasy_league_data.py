"""Read helpers for the ESPN league hub (spec 17).

Plain DB reads, mirroring ``fantasy_data``. Nothing here fetches: the
collector owns every external call, so a page load can never trigger a
network round trip or move a rate limit.

Standings and matchup results are read straight from their upsert tables.
Roster and power-ranking reads resolve "latest" through the run log
(``latest_successful_run``), which is what makes the roster digest's
zero-row skip invisible to callers.
"""
import json
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.database import (
    FantasyLeagueAccountTeam,
    FantasyLeagueMatchup,
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyRanking,
    iso_utc,
)
from app.services import fantasy_data
from app.services.fantasy_collector import latest_successful_run
from app.services.fantasy_league_espn import configured_league_id
from app.services.fantasy_league_rankings import ALGORITHMS
from app.services.fantasy_common import SCORING_POINTS_FIELD, normalize_scoring

logger = logging.getLogger(__name__)

DEFAULT_ALGORITHM = "composite"

# Starters render above the fold in this order; bench and IR sink below it.
SLOT_ORDER = {
    "QB": 0,
    "RB": 1,
    "WR": 2,
    "TE": 3,
    "FLEX": 4,
    "RB/WR": 4,
    "WR/TE": 4,
    "OP": 5,
    "DST": 6,
    "K": 7,
    "BENCH": 90,
    "IR": 95,
}
BENCH_SLOTS = ("BENCH", "IR")


class UnknownSeasonError(Exception):
    """Raised when a caller asks for a season the league has no data for."""


class UnknownTeamError(Exception):
    """Raised when a caller asks for a team id not in the requested season."""


def _season_rows(db: Session) -> List[FantasyLeagueSeason]:
    return (
        db.query(FantasyLeagueSeason)
        .filter(FantasyLeagueSeason.espn_league_id == configured_league_id())
        .order_by(FantasyLeagueSeason.season.desc())
        .all()
    )


def _iso(value) -> Optional[str]:
    # Stored timestamps are naive UTC; iso_utc marks them so the browser does
    # not read them as local time.
    return iso_utc(value) if value else None


def list_seasons(db: Session) -> Dict[str, Any]:
    """Every season we know about, including the ones we cannot read.

    A private season is reported with status 'unauthorized' rather than
    omitted, so the UI can label the gap instead of silently skipping a year.
    """
    rows = _season_rows(db)
    seasons = []
    for row in rows:
        seasons.append(
            {
                "season": row.season,
                "name": row.name,
                "size": row.size,
                "status": row.status,
                "available": row.status == "ok",
                "updated_at": _iso(row.updated_at),
            }
        )
    return {"seasons": seasons, "league_id": configured_league_id()}


def _completed_matchup_count(db: Session, season: int) -> int:
    return (
        db.query(FantasyLeagueMatchup)
        .filter(
            FantasyLeagueMatchup.season == season,
            FantasyLeagueMatchup.is_complete.is_(True),
            FantasyLeagueMatchup.playoff_tier == "NONE",
        )
        .count()
    )


def resolve_default_season(db: Session) -> Dict[str, Any]:
    """Pick the season to land on, and whether it is preseason or live.

    Derived from the data rather than configured, so the page flips itself
    when week 1 scores land instead of needing a manual switch at kickoff:

      * newest readable season with no completed games -> that season, in
        "preseason" mode (rosters are drafted and interesting; standings are
        all zeroes and are not)
      * once any game is complete -> the same season, in "live" mode
      * nothing readable at all -> the newest season that has any data
    """
    rows = [row for row in _season_rows(db) if row.status == "ok"]
    if not rows:
        return {"season": None, "mode": "empty"}

    newest = rows[0]
    if _completed_matchup_count(db, newest.season) > 0:
        return {"season": newest.season, "mode": "live"}

    has_teams = (
        db.query(FantasyLeagueTeam).filter(FantasyLeagueTeam.season == newest.season).count()
    )
    if has_teams:
        return {"season": newest.season, "mode": "preseason"}

    for row in rows[1:]:
        if _completed_matchup_count(db, row.season) > 0:
            return {"season": row.season, "mode": "live"}
    return {"season": newest.season, "mode": "preseason"}


def resolve_played_season(db: Session) -> Optional[int]:
    """Newest readable season that has actually been played.

    The hub deliberately lands on the current season even in the preseason,
    because drafted rosters are worth looking at. Chat has the opposite need:
    "what are the power rankings?" during the preseason should answer from the
    most recent season that has any, not report that none exist while several
    thousand rows sit in the table for last year.
    """
    for row in _season_rows(db):
        if row.status != "ok":
            continue
        if _completed_matchup_count(db, row.season) > 0:
            return row.season
    return None


def _require_season(db: Session, season: Optional[int]) -> int:
    if season is None:
        resolved = resolve_default_season(db)["season"]
        if resolved is None:
            raise UnknownSeasonError("No league data has been collected yet")
        return resolved
    row = (
        db.query(FantasyLeagueSeason)
        .filter(
            FantasyLeagueSeason.espn_league_id == configured_league_id(),
            FantasyLeagueSeason.season == season,
        )
        .first()
    )
    if row is None or row.status != "ok":
        raise UnknownSeasonError(f"No readable data for season {season}")
    return season


def _team_rows(db: Session, season: int) -> List[FantasyLeagueTeam]:
    return (
        db.query(FantasyLeagueTeam)
        .filter(FantasyLeagueTeam.season == season)
        .order_by(FantasyLeagueTeam.espn_team_id)
        .all()
    )


def _team_payload(row: FantasyLeagueTeam) -> Dict[str, Any]:
    games = (row.wins or 0) + (row.losses or 0) + (row.ties or 0)
    return {
        "espn_team_id": row.espn_team_id,
        "name": row.name,
        "abbrev": row.abbrev,
        "logo_url": row.logo_url,
        "division_id": row.division_id,
        "division_name": row.division_name,
        "owner_name": row.owner_name,
        "playoff_seed": row.playoff_seed,
        "waiver_rank": row.waiver_rank,
        "wins": row.wins or 0,
        "losses": row.losses or 0,
        "ties": row.ties or 0,
        "points_for": row.points_for or 0.0,
        "points_against": row.points_against or 0.0,
        "point_differential": (row.points_for or 0.0) - (row.points_against or 0.0),
        "points_per_game": ((row.points_for or 0.0) / games) if games else None,
        "win_pct": row.win_pct or 0.0,
        "streak_length": row.streak_length,
        "streak_type": row.streak_type,
        "games_back": row.games_back,
        "games_played": games,
    }


def get_league_overview(db: Session, season: Optional[int] = None) -> Dict[str, Any]:
    """Header data: which season, what mode, how fresh, what else exists."""
    default = resolve_default_season(db)
    if season is None:
        season = default["season"]
        mode = default["mode"]
    else:
        season = _require_season(db, season)
        mode = "live" if _completed_matchup_count(db, season) else "preseason"

    row = None
    if season is not None:
        row = (
            db.query(FantasyLeagueSeason)
            .filter(
                FantasyLeagueSeason.espn_league_id == configured_league_id(),
                FantasyLeagueSeason.season == season,
            )
            .first()
        )

    sync_run = latest_successful_run(db, "league_sync", season) if season else None
    roster_run = latest_successful_run(db, "league_rosters", season) if season else None

    divisions = []
    if row and row.divisions_json:
        try:
            divisions = json.loads(row.divisions_json) or []
        except json.JSONDecodeError:
            divisions = []

    weeks = sorted(
        {
            value
            for (value,) in db.query(FantasyLeaguePowerRanking.week)
            .filter(FantasyLeaguePowerRanking.season == season)
            .distinct()
            .all()
            if value is not None
        }
    )

    return {
        "season": season,
        "mode": mode,
        "name": row.name if row else None,
        "size": row.size if row else None,
        "current_matchup_period": row.current_matchup_period if row else None,
        "current_scoring_period": row.current_scoring_period if row else None,
        "playoff_team_count": row.playoff_team_count if row else None,
        "divisions": divisions,
        "completed_weeks": weeks,
        "latest_week": weeks[-1] if weeks else None,
        "algorithms": list(ALGORITHMS),
        "seasons": list_seasons(db)["seasons"],
        "freshness": {
            "league_sync": _iso(sync_run.finished_at) if sync_run else None,
            "league_rosters": _iso(roster_run.finished_at) if roster_run else None,
        },
    }


def get_standings(db: Session, season: Optional[int] = None) -> Dict[str, Any]:
    """Teams grouped by division, ordered the way ESPN seeds them."""
    season = _require_season(db, season)
    teams = [_team_payload(row) for row in _team_rows(db, season)]

    # Seed 0 means "not seeded yet" in the preseason, so fall back to record.
    def sort_key(team):
        seed = team["playoff_seed"] or 0
        return (
            0 if seed else 1,
            seed,
            -team["win_pct"],
            -team["points_for"],
            team["espn_team_id"],
        )

    teams.sort(key=sort_key)

    divisions: Dict[Any, Dict[str, Any]] = {}
    for team in teams:
        key = team["division_id"]
        divisions.setdefault(
            key,
            {"division_id": key, "division_name": team["division_name"], "teams": []},
        )["teams"].append(team)

    return {
        "season": season,
        "teams": teams,
        "divisions": sorted(
            divisions.values(), key=lambda d: (d["division_id"] is None, d["division_id"])
        ),
    }


def get_power_rankings(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    algorithm: str = DEFAULT_ALGORITHM,
) -> Dict[str, Any]:
    season = _require_season(db, season)
    if algorithm not in ALGORITHMS:
        algorithm = DEFAULT_ALGORITHM

    run = latest_successful_run(db, "league_rankings", season)
    if run is None:
        return {
            "season": season,
            "week": None,
            "algorithm": algorithm,
            "available_weeks": [],
            "rankings": [],
        }

    weeks = sorted(
        {
            value
            for (value,) in db.query(FantasyLeaguePowerRanking.week)
            .filter(
                FantasyLeaguePowerRanking.run_id == run.id,
                FantasyLeaguePowerRanking.season == season,
            )
            .distinct()
            .all()
            if value is not None
        }
    )
    if not weeks:
        return {
            "season": season,
            "week": None,
            "algorithm": algorithm,
            "available_weeks": [],
            "rankings": [],
        }

    target = week if week in weeks else weeks[-1]
    rows = (
        db.query(FantasyLeaguePowerRanking)
        .filter(
            FantasyLeaguePowerRanking.run_id == run.id,
            FantasyLeaguePowerRanking.season == season,
            FantasyLeaguePowerRanking.week == target,
            FantasyLeaguePowerRanking.algorithm == algorithm,
        )
        .order_by(FantasyLeaguePowerRanking.rank)
        .all()
    )

    teams = {row.espn_team_id: _team_payload(row) for row in _team_rows(db, season)}
    history = _power_history(db, run.id, season, algorithm)

    rankings = []
    for row in rows:
        team = teams.get(row.espn_team_id, {})
        rankings.append(
            {
                "rank": row.rank,
                "score": row.score,
                "previous_rank": row.previous_rank,
                "rank_delta": row.rank_delta,
                "espn_team_id": row.espn_team_id,
                "name": team.get("name"),
                "abbrev": team.get("abbrev"),
                "owner_name": team.get("owner_name"),
                "logo_url": team.get("logo_url"),
                "wins": team.get("wins"),
                "losses": team.get("losses"),
                "ties": team.get("ties"),
                "points_for": team.get("points_for"),
                "history": history.get(row.espn_team_id, []),
            }
        )

    return {
        "season": season,
        "week": target,
        "algorithm": algorithm,
        "available_weeks": weeks,
        "rankings": rankings,
    }


def _power_history(
    db: Session, run_id: int, season: int, algorithm: str
) -> Dict[int, List[Dict[str, Any]]]:
    """Per-team rank by week, for the movement sparkline."""
    rows = (
        db.query(FantasyLeaguePowerRanking)
        .filter(
            FantasyLeaguePowerRanking.run_id == run_id,
            FantasyLeaguePowerRanking.season == season,
            FantasyLeaguePowerRanking.algorithm == algorithm,
        )
        .order_by(FantasyLeaguePowerRanking.week)
        .all()
    )
    history: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        history.setdefault(row.espn_team_id, []).append(
            {"week": row.week, "rank": row.rank, "score": row.score}
        )
    return history


def get_scoreboard(
    db: Session, season: Optional[int] = None, week: Optional[int] = None
) -> Dict[str, Any]:
    season = _require_season(db, season)
    teams = {row.espn_team_id: _team_payload(row) for row in _team_rows(db, season)}

    all_weeks = sorted(
        {
            value
            for (value,) in db.query(FantasyLeagueMatchup.matchup_period)
            .filter(FantasyLeagueMatchup.season == season)
            .distinct()
            .all()
            if value is not None
        }
    )
    if not all_weeks:
        return {"season": season, "week": None, "available_weeks": [], "matchups": []}

    if week not in all_weeks:
        # Default to the newest week that has actually been played, so the
        # scoreboard opens on results rather than an empty future slate.
        played = [
            value
            for (value,) in db.query(FantasyLeagueMatchup.matchup_period)
            .filter(
                FantasyLeagueMatchup.season == season,
                FantasyLeagueMatchup.is_complete.is_(True),
            )
            .distinct()
            .all()
            if value is not None
        ]
        week = max(played) if played else all_weeks[0]

    rows = (
        db.query(FantasyLeagueMatchup)
        .filter(
            FantasyLeagueMatchup.season == season,
            FantasyLeagueMatchup.matchup_period == week,
        )
        .order_by(FantasyLeagueMatchup.espn_matchup_id)
        .all()
    )

    matchups = []
    for row in rows:
        home = teams.get(row.home_team_id, {})
        away = teams.get(row.away_team_id, {}) if row.away_team_id else None
        matchups.append(
            {
                "espn_matchup_id": row.espn_matchup_id,
                "matchup_period": row.matchup_period,
                "playoff_tier": row.playoff_tier,
                "winner": row.winner,
                "is_bye": bool(row.is_bye),
                "is_complete": bool(row.is_complete),
                "home": {
                    "espn_team_id": row.home_team_id,
                    "name": home.get("name"),
                    "abbrev": home.get("abbrev"),
                    "owner_name": home.get("owner_name"),
                    "logo_url": home.get("logo_url"),
                    "points": row.home_points,
                },
                "away": (
                    {
                        "espn_team_id": row.away_team_id,
                        "name": away.get("name") if away else None,
                        "abbrev": away.get("abbrev") if away else None,
                        "owner_name": away.get("owner_name") if away else None,
                        "logo_url": away.get("logo_url") if away else None,
                        "points": row.away_points,
                    }
                    if row.away_team_id
                    else None
                ),
            }
        )

    return {
        "season": season,
        "week": week,
        "available_weeks": all_weeks,
        "matchups": matchups,
    }


def _require_team(db: Session, season: int, team_id: int) -> FantasyLeagueTeam:
    row = (
        db.query(FantasyLeagueTeam)
        .filter(
            FantasyLeagueTeam.season == season,
            FantasyLeagueTeam.espn_team_id == team_id,
        )
        .first()
    )
    if row is None:
        raise UnknownTeamError(f"No team {team_id} in season {season}")
    return row


def get_team_detail(
    db: Session, season: Optional[int], team_id: int
) -> Dict[str, Any]:
    """One team: record, every result, and its power-rank history."""
    season = _require_season(db, season)
    row = _require_team(db, season, team_id)
    teams = {t.espn_team_id: _team_payload(t) for t in _team_rows(db, season)}

    matchups = (
        db.query(FantasyLeagueMatchup)
        .filter(
            FantasyLeagueMatchup.season == season,
            (FantasyLeagueMatchup.home_team_id == team_id)
            | (FantasyLeagueMatchup.away_team_id == team_id),
        )
        .order_by(FantasyLeagueMatchup.matchup_period)
        .all()
    )

    results = []
    for matchup in matchups:
        is_home = matchup.home_team_id == team_id
        points = matchup.home_points if is_home else matchup.away_points
        opponent_id = matchup.away_team_id if is_home else matchup.home_team_id
        opponent_points = matchup.away_points if is_home else matchup.home_points
        outcome = None
        if matchup.is_complete and not matchup.is_bye:
            if matchup.winner == "TIE":
                outcome = "T"
            else:
                won = (matchup.winner == "HOME") == is_home
                outcome = "W" if won else "L"
        results.append(
            {
                "week": matchup.matchup_period,
                "playoff_tier": matchup.playoff_tier,
                "is_bye": bool(matchup.is_bye),
                "is_complete": bool(matchup.is_complete),
                "outcome": outcome,
                "points": points,
                "opponent_points": opponent_points,
                "margin": (
                    (points - opponent_points)
                    if points is not None and opponent_points is not None
                    else None
                ),
                "opponent": (
                    {
                        "espn_team_id": opponent_id,
                        "name": teams.get(opponent_id, {}).get("name"),
                        "abbrev": teams.get(opponent_id, {}).get("abbrev"),
                    }
                    if opponent_id
                    else None
                ),
            }
        )

    run = latest_successful_run(db, "league_rankings", season)
    history = []
    if run is not None:
        history = _power_history(db, run.id, season, DEFAULT_ALGORITHM).get(team_id, [])

    payload = _team_payload(row)
    payload.update({"season": season, "results": results, "power_history": history})
    return payload


def get_team_roster(
    db: Session, season: Optional[int], team_id: int
) -> Dict[str, Any]:
    """A team's latest roster, joined to the site's own player data.

    This is the join the whole feature exists for: the roster arrives from
    ESPN, but the projections, rankings, injury status and recent actuals
    attached to each player are the ones the dashboard already collects.
    Entries whose player could not be crosswalked still render, from their
    raw ESPN name.
    """
    season = _require_season(db, season)
    _require_team(db, season, team_id)

    run = latest_successful_run(db, "league_rosters", season)
    if run is None:
        return {"season": season, "espn_team_id": team_id, "as_of": None, "entries": []}

    rows = (
        db.query(FantasyLeagueRosterEntry)
        .filter(
            FantasyLeagueRosterEntry.run_id == run.id,
            FantasyLeagueRosterEntry.espn_team_id == team_id,
        )
        .all()
    )

    player_ids = [row.player_id for row in rows if row.player_id]
    players = {}
    if player_ids:
        players = {
            player.player_id: player
            for player in db.query(FantasyPlayer)
            .filter(FantasyPlayer.player_id.in_(player_ids))
            .all()
        }

    # League seasons and the dashboard's current projection season are
    # intentionally independent. A 2024 league roster is still useful with
    # the newest 2026 projections, rankings, props and actuals attached.
    context = fantasy_data.default_context(db)
    projection_map, projection_as_of = fantasy_data._consensus_projection_map(
        db, context.get("season"), context.get("week")
    )

    ranking_run = latest_successful_run(
        db, "rankings", context.get("season"), context.get("week")
    ) or latest_successful_run(db, "rankings")
    ranking_by_player: Dict[str, FantasyRanking] = {}
    if ranking_run is not None and player_ids:
        ranking_rows = (
            db.query(FantasyRanking)
            .filter(
                FantasyRanking.run_id == ranking_run.id,
                FantasyRanking.player_id.in_(player_ids),
                FantasyRanking.scoring == "ppr",
            )
            .order_by(FantasyRanking.rank.asc())
            .all()
        )
        for ranking in ranking_rows:
            player = players.get(ranking.player_id)
            expected_position = "DEF" if player and player.position in ("DEF", "DST") else (
                player.position if player else None
            )
            current = ranking_by_player.get(ranking.player_id)
            if current is None or ranking.position == expected_position:
                ranking_by_player[ranking.player_id] = ranking

    actuals_by_player: Dict[str, List[Dict[str, Any]]] = {}
    if player_ids:
        # Only the newest few weeks per player are shown, so bound the scan by
        # season instead of pulling every stat line ever recorded and throwing
        # most of them away in Python. Two seasons covers "last 3 games" even
        # across an offseason boundary.
        newest_stat_season = (
            db.query(FantasyPlayerStat.season)
            .order_by(FantasyPlayerStat.season.desc())
            .limit(1)
            .scalar()
        )
        stat_query = db.query(FantasyPlayerStat).filter(
            FantasyPlayerStat.player_id.in_(player_ids)
        )
        if newest_stat_season is not None:
            stat_query = stat_query.filter(
                FantasyPlayerStat.season >= newest_stat_season - 1
            )
        stat_rows = stat_query.order_by(
            FantasyPlayerStat.player_id,
            FantasyPlayerStat.season.desc(),
            FantasyPlayerStat.week.desc(),
        ).all()
        for stat in stat_rows:
            recent = actuals_by_player.setdefault(stat.player_id, [])
            if len(recent) < 3:
                recent.append(
                    {
                        "season": stat.season,
                        "week": stat.week,
                        "opponent": stat.opponent,
                        "fantasy_points_ppr": stat.fantasy_points_ppr,
                        "fantasy_points_half": stat.fantasy_points_half,
                        "fantasy_points_std": stat.fantasy_points_std,
                    }
                )

    entries = []
    for row in rows:
        player = players.get(row.player_id) if row.player_id else None
        ranking = ranking_by_player.get(row.player_id) if row.player_id else None
        entries.append(
            {
                "player_id": row.player_id,
                "name": (player.full_name if player else None) or row.player_name_raw,
                "matched": player is not None,
                "position": row.position,
                "lineup_slot": row.lineup_slot,
                "lineup_slot_id": row.lineup_slot_id,
                "is_starter": row.lineup_slot not in BENCH_SLOTS,
                "pro_team": row.pro_team or (player.team if player else None),
                "injury_status": row.injury_status
                or (player.injury_status if player else None),
                "acquisition_type": row.acquisition_type,
                "projection": projection_map.get(row.player_id) if row.player_id else None,
                "ranking": (
                    {
                        "rank": ranking.rank,
                        "position": ranking.position,
                        "scoring": ranking.scoring,
                        "source": ranking_run.source,
                        "season": ranking.season,
                        "week": ranking.week,
                        "tier": ranking.tier,
                        "ecr": ranking.ecr,
                    }
                    if ranking is not None
                    else None
                ),
                "props": fantasy_data._player_props(db, row.player_id)
                if player is not None
                else [],
                "recent_actuals": actuals_by_player.get(row.player_id, [])
                if row.player_id
                else [],
            }
        )

    entries.sort(
        key=lambda entry: (
            SLOT_ORDER.get(entry["lineup_slot"], 50),
            entry["lineup_slot_id"] if entry["lineup_slot_id"] is not None else 99,
            entry["name"] or "",
        )
    )

    return {
        "season": season,
        "espn_team_id": team_id,
        "as_of": _iso(run.finished_at),
        "player_data": {
            "season": context.get("season"),
            "week": context.get("week"),
            "projection_as_of": _iso(projection_as_of),
            "ranking_as_of": _iso(ranking_run.finished_at) if ranking_run else None,
        },
        "entries": entries,
        "unmatched": sum(1 for entry in entries if not entry["matched"]),
    }


def get_member_snapshot(
    db: Session,
    username: str,
    season: Optional[int] = None,
    week: Optional[int] = None,
    scoring: str = "std",
) -> Dict[str, Any]:
    """Team picker and the signed-in member's compact weekly snapshot."""
    season = _require_season(db, season)
    scoring = normalize_scoring(scoring)
    teams = [_team_payload(row) for row in _team_rows(db, season)]
    selection = (
        db.query(FantasyLeagueAccountTeam)
        .filter(
            FantasyLeagueAccountTeam.username == username,
            FantasyLeagueAccountTeam.season == season,
        )
        .first()
    )
    selected_id = selection.espn_team_id if selection else None
    if selected_id is None or not any(
        team["espn_team_id"] == selected_id for team in teams
    ):
        return {
            "season": season,
            "week": week,
            "scoring": scoring,
            "status": "unconfigured",
            "selected_team_id": None,
            "teams": teams,
            "snapshot": None,
        }

    detail = get_team_detail(db, season, selected_id)
    roster = get_team_roster(db, season, selected_id)
    available_weeks = [result["week"] for result in detail["results"]]
    if week not in available_weeks:
        incomplete = [
            result["week"] for result in detail["results"] if not result["is_complete"]
        ]
        week = min(incomplete) if incomplete else (max(available_weeks) if available_weeks else None)
    matchup = next((result for result in detail["results"] if result["week"] == week), None)

    scoring_field = SCORING_POINTS_FIELD[scoring]
    starter_values = [
        entry["projection"].get(scoring_field)
        for entry in roster["entries"]
        if entry["is_starter"] and entry.get("projection")
        and entry["projection"].get(scoring_field) is not None
    ]
    rankings = get_power_rankings(
        db, season=season, week=week, algorithm=DEFAULT_ALGORITHM
    ).get("rankings", [])
    rank = next(
        (entry["rank"] for entry in rankings if entry["espn_team_id"] == selected_id),
        None,
    )
    selected_team = next(team for team in teams if team["espn_team_id"] == selected_id)
    return {
        "season": season,
        "week": week,
        "scoring": scoring,
        "status": "configured",
        "selected_team_id": selected_id,
        "teams": teams,
        "snapshot": {
            "team": selected_team,
            "record": {
                "wins": detail["wins"],
                "losses": detail["losses"],
                "ties": detail["ties"],
            },
            "opponent": matchup.get("opponent") if matchup else None,
            "is_bye": matchup.get("is_bye") if matchup else False,
            "power_rank": rank,
            "waiver_rank": selected_team.get("waiver_rank"),
            "starter_projection": round(sum(starter_values), 1) if starter_values else None,
            "projection_as_of": roster.get("player_data", {}).get("projection_as_of"),
        },
    }


def select_member_team(
    db: Session,
    username: str,
    season: int,
    espn_team_id: int,
    scoring: str = "std",
) -> Dict[str, Any]:
    """Persist one ESPN team per account and season, then return its snapshot."""
    season = _require_season(db, season)
    _require_team(db, season, espn_team_id)
    selection = (
        db.query(FantasyLeagueAccountTeam)
        .filter(
            FantasyLeagueAccountTeam.username == username,
            FantasyLeagueAccountTeam.season == season,
        )
        .first()
    )
    if selection is None:
        selection = FantasyLeagueAccountTeam(
            username=username, season=season, espn_team_id=espn_team_id
        )
        db.add(selection)
    else:
        selection.espn_team_id = espn_team_id
    db.commit()
    return get_member_snapshot(db, username, season=season, scoring=scoring)
