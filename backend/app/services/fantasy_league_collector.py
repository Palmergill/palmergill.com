"""Collection for the ESPN league hub (spec 17).

Three jobs, all season-scoped, following the same run-log contract as
``fantasy_collector``:

  * ``league_sync``     — settings, members, teams/standings, and the schedule
  * ``league_rosters``  — a roster snapshot, skipped when nothing changed
  * ``league_rankings`` — power rankings recomputed for every completed week

A season that is still private raises ``EspnLeagueUnauthorized``. That closes
the run as ``skipped`` rather than ``error``: a private season is a stable,
expected state, and logging it as an error would make the run log look like a
crash loop forever. The season row records ``status='unauthorized'`` so the UI
can label the gap instead of silently omitting it, and every other season in
the same tick collects normally.
"""
import hashlib
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.database import (
    FantasyCollectionRun,
    FantasyLeagueMatchup,
    FantasyLeagueMember,
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyPlayer,
    utc_now,
)
from app.services import fantasy_league_rankings
from app.services.fantasy_collector import finish_run, get_meta, set_meta, start_run
from app.services.fantasy_common import normalize_name
from app.services.fantasy_league_espn import (
    EspnLeagueError,
    EspnLeagueUnauthorized,
    configured_league_id,
    configured_seasons,
    espn_league_client,
    league_collection_enabled,
    parse_members,
    parse_roster_entries,
    parse_schedule,
    parse_settings,
    parse_teams,
)

logger = logging.getLogger(__name__)

ROSTER_DIGEST_META_PREFIX = "league:roster_digest:"

LEAGUE_JOBS = ("league_sync", "league_rosters", "league_rankings")


def _digest_key(season: int) -> str:
    return f"{ROSTER_DIGEST_META_PREFIX}{season}"


def _upsert_season_status(
    db: Session,
    season: int,
    status: str,
    run_id: Optional[int] = None,
    last_error: Optional[str] = None,
    settings: Optional[Dict[str, Any]] = None,
) -> FantasyLeagueSeason:
    league_id = configured_league_id()
    row = (
        db.query(FantasyLeagueSeason)
        .filter(
            FantasyLeagueSeason.espn_league_id == league_id,
            FantasyLeagueSeason.season == season,
        )
        .first()
    )
    if row is None:
        row = FantasyLeagueSeason(espn_league_id=league_id, season=season)
        db.add(row)
    row.status = status
    row.last_error = last_error
    row.run_id = run_id
    if settings:
        for field in (
            "name",
            "size",
            "current_matchup_period",
            "current_scoring_period",
            "first_scoring_period",
            "matchup_period_count",
            "regular_season_periods",
            "playoff_team_count",
            "divisions_json",
            "lineup_slot_counts_json",
        ):
            setattr(row, field, settings.get(field))
    row.updated_at = utc_now()
    db.commit()
    return row


class PlayerCrosswalk:
    """Resolves an ESPN roster entry onto an ff_players row.

    Four lookups, in descending order of confidence. The espn_id column alone
    is not enough: Sleeper's dump leaves it null for a large share of players,
    including current stars (Ja'Marr Chase, Bijan Robinson, Amon-Ra St. Brown
    are all null while Joe Burrow is populated), so an id-only crosswalk
    resolves under half a roster. Name matching — the same approach the
    FantasyPros and props collectors already use — closes the gap.

    Built in memory per run rather than queried per player: ff_players.espn_id
    has no index, and adding one is not safe here (the migration helper can
    only add columns, so a new index=True would silently never exist on the
    deployed database).
    """

    def __init__(self, db: Session):
        self.by_espn_id: Dict[str, str] = {}
        self.by_def_team: Dict[str, str] = {}
        self.by_name_team: Dict[Tuple[str, str], str] = {}
        self.by_name: Dict[str, List[str]] = {}

        for player in db.query(
            FantasyPlayer.player_id,
            FantasyPlayer.espn_id,
            FantasyPlayer.position,
            FantasyPlayer.team,
            FantasyPlayer.search_name,
        ).all():
            player_id, espn_id, position, team, search_name = player
            if espn_id:
                self.by_espn_id[str(espn_id)] = player_id
            # Sleeper keys team defenses by abbreviation and gives them no
            # espn_id, so they need their own lookup.
            if position == "DEF":
                key = team or player_id
                if key:
                    self.by_def_team[str(key).upper()] = player_id
            if search_name:
                if team:
                    self.by_name_team[(search_name, team)] = player_id
                self.by_name.setdefault(search_name, []).append(player_id)

    def resolve(self, entry: Dict[str, Any]) -> Optional[str]:
        if entry.get("dst_team"):
            return self.by_def_team.get(entry["dst_team"].upper())

        espn_id = entry.get("espn_id")
        if espn_id and espn_id in self.by_espn_id:
            return self.by_espn_id[espn_id]

        search_name = normalize_name(entry.get("player_name_raw") or "")
        if not search_name:
            return None
        team = entry.get("pro_team")
        if team:
            matched = self.by_name_team.get((search_name, team))
            if matched:
                return matched
        # Fall back to name alone, but only when it is unambiguous — two
        # players sharing a name is exactly when a wrong guess is worst.
        candidates = self.by_name.get(search_name) or []
        return candidates[0] if len(candidates) == 1 else None


def _roster_digest(entries: List[Dict[str, Any]]) -> str:
    """Stable hash of league-wide roster composition.

    Ignores everything volatile (injury status, fetch time) so the digest only
    moves on an actual add, drop, trade, or lineup change.
    """
    shape = sorted(
        (
            entry.get("espn_team_id") or 0,
            entry.get("espn_player_id") or 0,
            entry.get("lineup_slot_id") or -1,
        )
        for entry in entries
    )
    return hashlib.sha256(json.dumps(shape).encode("utf-8")).hexdigest()


# ── jobs ────────────────────────────────────────────────────────────────


def collect_league_sync(db: Session, season: int, client=None) -> FantasyCollectionRun:
    """Settings, members, teams/standings, and the full schedule."""
    client = client or espn_league_client
    run = start_run(db, "league_sync", "espn", season=season)
    try:
        league_payload = client.get_league(season)
        schedule_payload = client.get_schedule(season)
    except EspnLeagueUnauthorized as exc:
        logger.info("ESPN league season %s is not public: %s", season, exc)
        _upsert_season_status(db, season, "unauthorized", run.id, str(exc))
        return finish_run(db, run, "skipped", detail=str(exc))
    except EspnLeagueError as exc:
        logger.warning("ESPN league sync failed for %s: %s", season, exc)
        _upsert_season_status(db, season, "error", run.id, str(exc))
        return finish_run(db, run, "error", detail=str(exc))

    try:
        settings = parse_settings(league_payload, season)
        members = parse_members(league_payload)
        members_by_guid = {
            row["member_guid"]: row["display_name"] for row in members
        }
        teams = parse_teams(league_payload, members_by_guid)
        matchups = parse_schedule(schedule_payload)
    except EspnLeagueError as exc:
        logger.warning("ESPN league parse failed for %s: %s", season, exc)
        _upsert_season_status(db, season, "error", run.id, str(exc))
        return finish_run(db, run, "error", detail=str(exc))

    written = 0

    existing_members = {
        row.member_guid: row
        for row in db.query(FantasyLeagueMember)
        .filter(FantasyLeagueMember.season == season)
        .all()
    }
    for member in members:
        row = existing_members.get(member["member_guid"])
        if row is None:
            db.add(
                FantasyLeagueMember(season=season, run_id=run.id, **member)
            )
        else:
            for field, value in member.items():
                setattr(row, field, value)
            row.run_id = run.id
        written += 1

    existing_teams = {
        row.espn_team_id: row
        for row in db.query(FantasyLeagueTeam)
        .filter(FantasyLeagueTeam.season == season)
        .all()
    }
    for team in teams:
        row = existing_teams.get(team["espn_team_id"])
        if row is None:
            db.add(FantasyLeagueTeam(season=season, run_id=run.id, **team))
        else:
            for field, value in team.items():
                setattr(row, field, value)
            row.run_id = run.id
        written += 1

    existing_matchups = {
        row.espn_matchup_id: row
        for row in db.query(FantasyLeagueMatchup)
        .filter(FantasyLeagueMatchup.season == season)
        .all()
    }
    for matchup in matchups:
        row = existing_matchups.get(matchup["espn_matchup_id"])
        if row is None:
            db.add(FantasyLeagueMatchup(season=season, run_id=run.id, **matchup))
        else:
            for field, value in matchup.items():
                setattr(row, field, value)
            row.run_id = run.id
        written += 1

    db.commit()
    _upsert_season_status(db, season, "ok", run.id, None, settings)
    return finish_run(db, run, "success", rows_written=written)


def collect_league_rosters(db: Session, season: int, client=None) -> FantasyCollectionRun:
    """Snapshot every roster, unless nothing has changed since the last run."""
    client = client or espn_league_client
    run = start_run(db, "league_rosters", "espn", season=season)
    try:
        payload = client.get_league(season)
        entries = parse_roster_entries(payload)
        settings = parse_settings(payload, season)
    except EspnLeagueUnauthorized as exc:
        logger.info("ESPN league season %s is not public: %s", season, exc)
        return finish_run(db, run, "skipped", detail=str(exc))
    except EspnLeagueError as exc:
        logger.warning("ESPN roster fetch failed for %s: %s", season, exc)
        return finish_run(db, run, "error", detail=str(exc))

    digest = _roster_digest(entries)
    if get_meta(db, _digest_key(season)) == digest:
        # Nothing moved. Writing zero rows and closing as "skipped" keeps
        # latest_successful_run pointing at the last snapshot that has rows,
        # so reads need no special case.
        return finish_run(
            db, run, "skipped", detail="Rosters unchanged since the last snapshot"
        )

    crosswalk = PlayerCrosswalk(db)
    scoring_period = settings.get("current_scoring_period") or 0
    written = 0
    unmatched = 0
    for entry in entries:
        player_id = crosswalk.resolve(entry)
        if player_id is None:
            unmatched += 1
        db.add(
            FantasyLeagueRosterEntry(
                run_id=run.id,
                season=season,
                scoring_period=scoring_period,
                espn_team_id=entry["espn_team_id"],
                espn_player_id=entry.get("espn_player_id"),
                player_id=player_id,
                player_name_raw=entry.get("player_name_raw"),
                lineup_slot_id=entry.get("lineup_slot_id"),
                lineup_slot=entry.get("lineup_slot"),
                position=entry.get("position"),
                pro_team_id=entry.get("pro_team_id"),
                pro_team=entry.get("pro_team"),
                acquisition_type=entry.get("acquisition_type"),
                injury_status=entry.get("injury_status"),
            )
        )
        written += 1

    set_meta(db, _digest_key(season), digest)
    db.commit()
    detail = f"{unmatched} unmatched player(s)" if unmatched else None
    return finish_run(db, run, "success", rows_written=written, detail=detail)


def build_league_power_rankings(db: Session, season: int) -> FantasyCollectionRun:
    """Recompute power rankings for every completed week from stored data."""
    run = start_run(db, "league_rankings", "derived", season=season)

    teams = [
        {"espn_team_id": row.espn_team_id, "name": row.name}
        for row in db.query(FantasyLeagueTeam)
        .filter(FantasyLeagueTeam.season == season)
        .all()
    ]
    if not teams:
        return finish_run(db, run, "skipped", detail="No league teams stored yet")

    matchups = [
        {
            "matchup_period": row.matchup_period,
            "playoff_tier": row.playoff_tier,
            "winner": row.winner,
            "home_team_id": row.home_team_id,
            "home_points": row.home_points,
            "away_team_id": row.away_team_id,
            "away_points": row.away_points,
            "is_bye": row.is_bye,
            "is_complete": row.is_complete,
        }
        for row in db.query(FantasyLeagueMatchup)
        .filter(FantasyLeagueMatchup.season == season)
        .all()
    ]

    rows = fantasy_league_rankings.rank_history(teams, matchups)
    if not rows:
        return finish_run(db, run, "skipped", detail="No completed games yet")

    for row in rows:
        db.add(
            FantasyLeaguePowerRanking(
                run_id=run.id,
                season=season,
                week=row["week"],
                algorithm=row["algorithm"],
                espn_team_id=row["espn_team_id"],
                rank=row["rank"],
                score=row["score"],
                previous_rank=row["previous_rank"],
                rank_delta=row["rank_delta"],
            )
        )
    db.commit()
    return finish_run(db, run, "success", rows_written=len(rows))


def collect_season(db: Session, season: int, client=None) -> List[FantasyCollectionRun]:
    """Full refresh for one season: sync, then rosters and rankings.

    Rosters and rankings only run when the sync succeeded — there is no point
    snapshotting or recomputing against a season we could not read.
    """
    runs = [collect_league_sync(db, season, client)]
    if runs[0].status == "success":
        runs.append(collect_league_rosters(db, season, client))
        runs.append(build_league_power_rankings(db, season))
    return runs


def current_league_season(db: Session) -> Optional[int]:
    """The newest configured season, which is the one still being played."""
    seasons = configured_seasons()
    return max(seasons) if seasons else None


def league_seasons() -> List[int]:
    """Seasons the scheduler should collect — empty when the league is off."""
    if not league_collection_enabled():
        return []
    return configured_seasons()
