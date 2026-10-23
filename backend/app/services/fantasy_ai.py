"""Fantasy league team overviews and draft/week recap notes.

Each note is written from a deterministic template over the league's
collected data and cached by a digest of that data, so it is only
rewritten when the underlying facts change.
"""
import hashlib
import json
import logging
from typing import Any, Dict, List, Optional

from app.database import (
    FantasyLeagueDraftNote,
    FantasyLeagueTeamOverview,
    FantasyLeagueWeekNote,
    utc_now,
)
from app.services import fantasy_league_data

logger = logging.getLogger(__name__)


# ── private-league team overviews ──────────────────────────────────────


def _team_overview_context(
    db, season: int, team_id: int, week: Optional[int]
) -> Dict[str, Any]:
    from app.services import fantasy_league_moves

    detail = fantasy_league_data.get_team_detail(db, season, team_id)
    season = detail["season"]
    roster = fantasy_league_data.get_team_roster(db, season, team_id)
    completed = [
        result["week"]
        for result in detail["results"]
        if result.get("week") is not None and result.get("is_complete")
    ]
    # The week only keys the stored overview (one per team per week); the
    # overview itself is about the roster as it stands.
    target_week = int(week) if week is not None else (max(completed) if completed else 0)

    board = fantasy_league_data.get_roster_power(db, season=season)
    power_team = next(
        (t for t in board.get("teams") or [] if t.get("espn_team_id") == team_id), None
    )
    moves = (
        fantasy_league_moves.team_moves(team_id, board, fantasy_league_data.SLOT_ELIGIBILITY)
        if board.get("available")
        else {"pickups": [], "trades": []}
    )
    rooms = fantasy_league_data.get_team_rooms(db, season, team_id)

    entries = []
    for entry in roster["entries"]:
        entries.append(
            {
                "name": entry["name"],
                "slot": entry["lineup_slot"],
                "starter": entry["is_starter"],
                "position": entry["position"],
                "pro_team": entry.get("pro_team"),
                "injury_status": entry["injury_status"],
                "projection": {
                    "scoring": "half",
                    "points": (entry.get("projection") or {}).get("pts_half_ppr"),
                },
                "ranking": entry.get("ranking"),
            }
        )

    return {
        "season": season,
        "week": target_week,
        "team": {
            "team_id": detail["espn_team_id"],
            "name": detail["name"],
            "owner": detail["owner_name"],
            "record": {
                "wins": detail["wins"],
                "losses": detail["losses"],
                "ties": detail["ties"],
            },
            "points_for": detail["points_for"],
            "points_against": detail["points_against"],
            "games_played": detail.get("games_played"),
        },
        "roster_power": (
            {
                "rank": power_team.get("rank"),
                "teams": len(board.get("teams") or []),
                "standings_rank": power_team.get("standings_rank"),
                "expected_points_per_week": power_team.get("expected"),
            }
            if power_team
            else None
        ),
        "need": power_team.get("need") if power_team else None,
        "rooms": [
            {
                "position": room["position"],
                "points_per_game": room["points_per_game"],
                "league_average": room["league_average"],
                "rank": room["rank"],
                "teams": room["teams"],
            }
            for room in rooms.get("rooms") or []
        ],
        "moves": {
            "pickups": moves.get("pickups") or [],
            "trades": moves.get("trades") or [],
        },
        "roster": entries,
    }


def _local_team_overview(context: Dict[str, Any]) -> str:
    team = context["team"]
    record = team["record"]
    power = context.get("roster_power") or {}
    need = context.get("need") or {}
    rooms = [room for room in context.get("rooms") or [] if room.get("rank")]
    injured = [
        entry for entry in context["roster"]
        if entry.get("starter")
        and entry.get("injury_status")
        and str(entry["injury_status"]).upper() not in ("ACTIVE", "NORMAL")
    ]

    summary = (
        f"**{team['name']}** is {record['wins']}-{record['losses']}-{record['ties']}"
    )
    if power.get("rank"):
        summary += (
            f", #{power['rank']} of {power['teams']} on roster power "
            f"({power['expected_points_per_week']:.1f} projected points a week)"
        )
    lines = ["**The team**", summary + "."]
    if rooms:
        best = min(rooms, key=lambda room: room["rank"])
        worst = max(rooms, key=lambda room: room["rank"])
        lines.append(
            f"Strongest room: {best['position']} (#{best['rank']} of {best['teams']}). "
            f"Thinnest: {worst['position']} (#{worst['rank']} of {worst['teams']})."
        )
    if need:
        lines.append(
            f"Weakest seat: {need['seat']}, {need.get('name') or 'a waiver-level player'} "
            f"at {need['ppg']:.1f} a game against a league average of {need['league_average']:.1f}."
        )
    if injured:
        labels = ", ".join(f"{e['name']} ({e['injury_status']})" for e in injured[:4])
        lines.append(f"Injured starters: {labels}.")

    lines += ["", "**Moves to consider**"]
    moves = context.get("moves") or {}
    for pickup in moves.get("pickups") or []:
        add = pickup["add"]
        drop = pickup.get("drop")
        drop_text = f", dropping {drop['name']}" if drop else ""
        lines.append(
            f"- Pick up {add['name']} ({add['position']}, {add['ppg']:.1f} a game){drop_text}: "
            f"+{pickup['gain']:.1f} a week."
        )
    for trade in moves.get("trades") or []:
        give = " and ".join(p["name"] for p in trade["give"])
        get = " and ".join(p["name"] for p in trade["get"])
        cut = trade.get("my_drop")
        cut_text = f", cutting {cut['name']}" if cut else ""
        lines.append(
            f"- Offer {give} to {trade['partner']['name']} for {get}{cut_text}: "
            f"+{trade['my_gain']:.1f} a week for you, +{trade['their_gain']:.1f} for them."
        )
    if not (moves.get("pickups") or moves.get("trades")):
        watch = f" Keep an eye on {need['seat']}." if need else ""
        lines.append(f"- No obvious upgrade on paper right now.{watch}")
    return "\n".join(lines)


def _team_overview_payload(
    row: FantasyLeagueTeamOverview, cache_hit: bool, warnings: Optional[List[str]] = None
) -> Dict[str, Any]:
    return {
        "season": row.season,
        "espn_team_id": row.espn_team_id,
        "week": row.week,
        "overview_md": row.overview_md,
        "model": row.model,
        "source": row.source,
        "generated_at": row.generated_at.isoformat() if row.generated_at else None,
        "cache_hit": cache_hit,
        "warnings": warnings or [],
    }


def _overview_row(db, season: int, team_id: int, week: int):
    return (
        db.query(FantasyLeagueTeamOverview)
        .filter(
            FantasyLeagueTeamOverview.season == season,
            FantasyLeagueTeamOverview.espn_team_id == team_id,
            FantasyLeagueTeamOverview.week == week,
        )
        .first()
    )


def _overview_digest(context: Dict[str, Any]) -> tuple[str, str]:
    """Return (canonical JSON, sha256) of a note's factual context."""
    canonical = json.dumps(context, sort_keys=True, separators=(",", ":"), default=str)
    return canonical, hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _is_fresh(row, digest: str) -> bool:
    """Whether a stored overview can be served without regenerating."""
    return row is not None and row.prompt_digest == digest


def _latest_overview_row(db, season: int, team_id: int, week: int):
    return (
        db.query(FantasyLeagueTeamOverview)
        .filter(
            FantasyLeagueTeamOverview.season == season,
            FantasyLeagueTeamOverview.espn_team_id == team_id,
            FantasyLeagueTeamOverview.week <= week,
        )
        .order_by(FantasyLeagueTeamOverview.week.desc())
        .first()
    )


def read_team_overview(
    db, season: int, team_id: int, week: Optional[int]
) -> Dict[str, Any]:
    """Return the newest stored overview, or a `missing` placeholder.

    Never generates. Overviews are written once a week by the scheduler
    (``generate_weekly_overviews``, Tuesday morning), so between Monday
    night's final whistle and Tuesday's run the page keeps showing the last
    one written rather than going blank.
    """
    context = _team_overview_context(db, season, team_id, week)
    row = _latest_overview_row(db, context["season"], team_id, context["week"])
    if row is None:
        return {
            "season": context["season"],
            "espn_team_id": team_id,
            "week": context["week"],
            "overview_md": None,
            "model": None,
            "source": None,
            "generated_at": None,
            "cache_hit": False,
            "status": "missing",
            "warnings": [],
        }
    payload = _team_overview_payload(row, cache_hit=True)
    payload["status"] = "current"
    return payload


def generate_team_overview(
    db, season: int, team_id: int, week: Optional[int], force: bool = False
) -> Dict[str, Any]:
    """Generate or reuse a team overview keyed by its factual context."""
    context = _team_overview_context(db, season, team_id, week)
    _, digest = _overview_digest(context)
    row = _overview_row(db, context["season"], team_id, context["week"])
    if _is_fresh(row, digest) and not force:
        payload = _team_overview_payload(row, cache_hit=True)
        payload["status"] = "current"
        return payload

    overview = _local_team_overview(context)

    if row is None:
        row = FantasyLeagueTeamOverview(
            season=context["season"],
            espn_team_id=team_id,
            week=context["week"],
        )
        db.add(row)
    row.overview_md = overview
    row.model = None
    row.source = "local"
    row.prompt_digest = digest
    row.generated_at = utc_now()
    db.commit()
    db.refresh(row)
    payload = _team_overview_payload(row, cache_hit=False)
    payload["status"] = "current"
    return payload


def generate_weekly_overviews(db, season: int, week: int) -> Dict[int, str]:
    """Write every team's recap-and-look-ahead for one completed week.

    The only writer of team overviews: the scheduler calls it on Tuesday
    morning, once Monday night's game has settled the week. Returns each
    team's source. One team failing does not stop the
    rest.
    """
    written: Dict[int, str] = {}
    for team in fantasy_league_data._team_rows(db, season):
        try:
            payload = generate_team_overview(db, season, team.espn_team_id, week)
        except Exception:  # noqa: BLE001 — one team must not sink the league
            logger.exception("Weekly overview failed for team %s", team.espn_team_id)
            db.rollback()
            continue
        written[team.espn_team_id] = payload["source"]
    return written


# ── draft recap notes ──────────────────────────────────────────────────


class UnknownDraftTeamError(Exception):
    """Raised when a team did not draft in the requested season."""


def _draft_note_context(db, season: int, team_id: int) -> Dict[str, Any]:
    from app.services import fantasy_league_draft

    recap = fantasy_league_draft.get_draft_recap(db, season)
    grade = next(
        (row for row in recap["grades"] if row["espn_team_id"] == team_id), None
    )
    if grade is None:
        raise UnknownDraftTeamError(f"No drafted team {team_id} in {season}.")

    picks = [
        {
            "overall_pick": row["overall_pick"],
            "round": row["round"],
            "player": row["player"]["name"],
            "position": row["player"]["position"],
            "pro_team": row["player"]["pro_team"],
            "adp": row["adp"],
            "adp_sigma": row["adp_sigma"],
        }
        for row in recap["picks"]
        if row["espn_team_id"] == team_id
    ]

    return {
        "season": recap["season"],
        "team": {
            "team_id": team_id,
            "name": grade["team"],
            "owner": grade["owner"],
        },
        "grade": grade["grade"],
        "components": grade["components"],
        "construction_notes": grade["construction_notes"],
        "best_pick": grade["best_pick"],
        "worst_pick": grade["worst_pick"],
        "starters": grade["starters"],
        "picks": picks,
        # Accolades give the note its material — a blurb built only from
        # sub-scores reads like a spreadsheet.
        "accolades": [
            {"label": award["label"], "value": award["winner"].get("display")}
            for award in recap["accolades"]
            if award["winner"].get("espn_team_id") == team_id
        ],
    }


def _local_draft_note(context: Dict[str, Any]) -> str:
    """The note, written deterministically from the gathered facts."""
    team = context["team"]["name"] or "This team"
    parts = [f"{team} graded out at {context['grade']}."]

    best = context.get("best_pick")
    if best and best.get("adp_sigma") is not None:
        parts.append(
            f"Best value was {best['player']['name']} at pick "
            f"{best['overall_pick']}, {abs(best['adp_sigma']):.1f} standard "
            "deviations later than the room usually takes him."
        )
    worst = context.get("worst_pick")
    if worst and worst.get("adp_sigma") is not None and worst["adp_sigma"] < 0:
        parts.append(
            f"The reach was {worst['player']['name']} at "
            f"{worst['overall_pick']}."
        )
    if context.get("accolades"):
        labels = ", ".join(award["label"] for award in context["accolades"])
        parts.append(f"Won {labels}.")
    if context.get("construction_notes"):
        parts.append(context["construction_notes"][0].capitalize() + ".")
    return " ".join(parts)


def _draft_note_payload(
    row: FantasyLeagueDraftNote, cache_hit: bool, warnings: Optional[List[str]] = None
) -> Dict[str, Any]:
    return {
        "season": row.season,
        "espn_team_id": row.espn_team_id,
        "note_md": row.note_md,
        "model": row.model,
        "source": row.source,
        "generated_at": row.generated_at.isoformat() if row.generated_at else None,
        "cache_hit": cache_hit,
        "warnings": warnings or [],
    }


def _draft_note_row(db, season: int, team_id: int):
    return (
        db.query(FantasyLeagueDraftNote)
        .filter(
            FantasyLeagueDraftNote.season == season,
            FantasyLeagueDraftNote.espn_team_id == team_id,
        )
        .first()
    )


def read_draft_note(db, season: int, team_id: int) -> Dict[str, Any]:
    """Return a stored note, or a `missing` placeholder. Never generates."""
    context = _draft_note_context(db, season, team_id)
    _, digest = _overview_digest(context)
    row = _draft_note_row(db, context["season"], team_id)
    if row is None:
        return {
            "season": context["season"],
            "espn_team_id": team_id,
            "note_md": None,
            "model": None,
            "source": None,
            "generated_at": None,
            "cache_hit": False,
            "status": "missing",
            "warnings": [],
        }
    payload = _draft_note_payload(row, cache_hit=True)
    payload["status"] = "current" if _is_fresh(row, digest) else "stale"
    return payload


def generate_draft_note(
    db, season: int, team_id: int
) -> Dict[str, Any]:
    """Generate or reuse one team's draft recap, keyed by its facts."""
    context = _draft_note_context(db, season, team_id)
    _, digest = _overview_digest(context)
    row = _draft_note_row(db, context["season"], team_id)
    if _is_fresh(row, digest):
        payload = _draft_note_payload(row, cache_hit=True)
        payload["status"] = "current"
        return payload

    note = _local_draft_note(context)

    if row is None:
        row = FantasyLeagueDraftNote(season=context["season"], espn_team_id=team_id)
        db.add(row)
    row.note_md = note
    row.model = None
    row.source = "local"
    row.prompt_digest = digest
    row.generated_at = utc_now()
    db.commit()
    db.refresh(row)
    payload = _draft_note_payload(row, cache_hit=False)
    payload["status"] = "current"
    return payload


def generate_missing_draft_notes(db, season: int) -> Dict[int, str]:
    """Write a draft recap for every drafted team that has none yet.

    The only writer of draft recaps: the scheduler calls it on Tuesdays. A
    draft happens once, so a team that already has a recap keeps it even if
    the ADP board later nudges its grade. Returns each written team's source.
    """
    from app.services import fantasy_league_draft

    recap = fantasy_league_draft.get_draft_recap(db, season)
    written: Dict[int, str] = {}
    for grade in recap["grades"]:
        team_id = grade["espn_team_id"]
        if _draft_note_row(db, season, team_id) is not None:
            continue
        try:
            payload = generate_draft_note(db, season, team_id)
        except Exception:  # noqa: BLE001 — one team must not sink the league
            logger.exception("Draft recap failed for team %s", team_id)
            db.rollback()
            continue
        written[team_id] = payload["source"]
    return written


# ── weekly recap notes ─────────────────────────────────────────────────


class UnknownWeekTeamError(Exception):
    """Raised when a team has no result in the requested week."""


def _week_note_context(db, season: int, week: Optional[int], team_id: int) -> Dict[str, Any]:
    from app.services import fantasy_league_week

    recap = fantasy_league_week.get_week_recap(db, season, week)
    row = next(
        (entry for entry in recap["grades"] if entry["espn_team_id"] == team_id), None
    )
    if row is None:
        raise UnknownWeekTeamError(
            f"No result for team {team_id} in week {recap.get('week')} of {season}."
        )

    return {
        "season": recap["season"],
        "week": recap["week"],
        "team": {"team_id": team_id, "name": row["team"], "owner": row["owner"]},
        "grade": row["grade"],
        "components": row["components"],
        "result": row["result"],
        "points": row["points"],
        "opponent": row["opponent"],
        "margin": row["margin"],
        "all_play": row["all_play"],
        "projected": row["projected"],
        "vs_projection": row["vs_projection"],
        "optimal": row["optimal"],
        "efficiency": row["efficiency"],
        "points_left": row["points_left"],
        "best_starter": row["best_starter"],
        "worst_starter": row["worst_starter"],
        "bench_hero": row["bench_hero"],
        "should_have_started": row["should_have_started"],
        # Accolades give the note its material — a blurb built only from
        # sub-scores reads like a spreadsheet.
        "accolades": [
            {"label": award["label"], "value": award["winner"].get("display")}
            for award in recap["accolades"]
            if award["winner"].get("espn_team_id") == team_id
        ],
    }


def _local_week_note(context: Dict[str, Any]) -> str:
    """The note, written deterministically from the gathered facts."""
    team = context["team"]["name"] or "This team"
    opponent = context.get("opponent") or {}
    verb = {"win": "beat", "loss": "lost to", "tie": "tied"}.get(context.get("result"))
    if verb and opponent.get("name") and context.get("points") is not None:
        parts = [
            f"{team} {verb} {opponent['name']} "
            f"{context['points']:g}–{opponent['points']:g}, and graded out at "
            f"{context['grade']}."
        ]
    else:
        parts = [f"{team} scored {context.get('points')} and graded out at {context['grade']}."]

    best = context.get("best_starter")
    if best and best.get("points") is not None:
        parts.append(f"{best['name']} led the lineup with {best['points']:g}.")
    left = context.get("points_left")
    if left:
        bench = context.get("bench_hero")
        tail = f", starting with {bench['name']} ({bench['points']:g})" if bench else ""
        parts.append(f"{left:g} points stayed on the bench{tail}.")
    if context.get("accolades"):
        labels = ", ".join(award["label"] for award in context["accolades"])
        parts.append(f"Won {labels}.")
    return " ".join(parts)


def _week_note_payload(
    row: FantasyLeagueWeekNote, cache_hit: bool, warnings: Optional[List[str]] = None
) -> Dict[str, Any]:
    return {
        "season": row.season,
        "week": row.week,
        "espn_team_id": row.espn_team_id,
        "note_md": row.note_md,
        "model": row.model,
        "source": row.source,
        "generated_at": row.generated_at.isoformat() if row.generated_at else None,
        "cache_hit": cache_hit,
        "warnings": warnings or [],
    }


def _week_note_row(db, season: int, week: int, team_id: int):
    return (
        db.query(FantasyLeagueWeekNote)
        .filter(
            FantasyLeagueWeekNote.season == season,
            FantasyLeagueWeekNote.week == week,
            FantasyLeagueWeekNote.espn_team_id == team_id,
        )
        .first()
    )


def read_week_note(
    db, season: int, week: Optional[int], team_id: int
) -> Dict[str, Any]:
    """Return a stored note, or a `missing` placeholder. Never generates."""
    context = _week_note_context(db, season, week, team_id)
    _, digest = _overview_digest(context)
    row = _week_note_row(db, context["season"], context["week"], team_id)
    if row is None:
        return {
            "season": context["season"],
            "week": context["week"],
            "espn_team_id": team_id,
            "note_md": None,
            "model": None,
            "source": None,
            "generated_at": None,
            "cache_hit": False,
            "status": "missing",
            "warnings": [],
        }
    payload = _week_note_payload(row, cache_hit=True)
    payload["status"] = "current" if _is_fresh(row, digest) else "stale"
    return payload


def generate_week_note(
    db, season: int, week: Optional[int], team_id: int
) -> Dict[str, Any]:
    """Generate or reuse one team's weekly recap, keyed by its facts."""
    context = _week_note_context(db, season, week, team_id)
    _, digest = _overview_digest(context)
    row = _week_note_row(db, context["season"], context["week"], team_id)
    if _is_fresh(row, digest):
        payload = _week_note_payload(row, cache_hit=True)
        payload["status"] = "current"
        return payload

    note = _local_week_note(context)

    if row is None:
        row = FantasyLeagueWeekNote(
            season=context["season"], week=context["week"], espn_team_id=team_id
        )
        db.add(row)
    row.note_md = note
    row.model = None
    row.source = "local"
    row.prompt_digest = digest
    row.generated_at = utc_now()
    db.commit()
    db.refresh(row)
    payload = _week_note_payload(row, cache_hit=False)
    payload["status"] = "current"
    return payload


def generate_week_notes(db, season: int, week: int) -> Dict[int, str]:
    """Write every team's recap of one completed week.

    The only writer of weekly recaps: the scheduler calls it on Tuesday
    morning, once Monday night's game has settled the week. Returns each
    team's source. A team with no result that week is skipped, and one team
    failing does not stop the rest.
    """
    from app.services import fantasy_league_data

    written: Dict[int, str] = {}
    for team in fantasy_league_data._team_rows(db, season):
        try:
            payload = generate_week_note(db, season, week, team.espn_team_id)
        except UnknownWeekTeamError:
            continue
        except Exception:  # noqa: BLE001 — one team must not sink the league
            logger.exception("Weekly recap failed for team %s", team.espn_team_id)
            db.rollback()
            continue
        written[team.espn_team_id] = payload["source"]
    return written
