"""Suggested moves for one team: waiver pickups and trade ideas.

Everything here reads the roster-power board (``get_roster_power``), so a
suggestion is priced in the same unit as the power rankings: projected points
per game for the rest of the season. Nothing touches a database.

Every move is priced the same way: rebuild the best legal lineup with the
move made, and compare it with the best lineup the roster fields today. That
is what a move is worth, and it settles the cases a position-by-position
comparison gets wrong — a quarterback who would push a superflex starter to
the bench, or a defense that only beats the one already rostered by a point.

* **Pickups.** The best unrostered player at each position, when adding him
  lifts the lineup by at least ``MIN_PICKUP_GAIN``. The drop is the player he
  displaces when they share a position (a defense for a defense), otherwise
  the weakest player left on the bench.
* **Trades.** One-for-one swaps close to even on projected points, where
  *both* lineups come out ahead. A trade only one side wins is not an idea,
  it is a request.

These are starting points for a conversation, and the page says so. They know
nothing about a manager's attachment to a player or about keeper rules.
"""
from typing import Any, Dict, List, Optional, Sequence

from app.services.fantasy_league_roster_power import best_lineup, normalize_position

# A pickup has to lift the lineup by at least this many points a week, or a
# waiver claim is churn.
MIN_PICKUP_GAIN = 1.0
# Each side of a trade has to gain at least this much.
MIN_TRADE_GAIN = 0.5
# A swap further apart than this on projected points is lopsided on paper.
FAIR_BAND = 3.0
MAX_PICKUPS = 3
MAX_TRADES = 3


def _player(player: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if player is None:
        return None
    return {
        "player_id": player.get("player_id"),
        "name": player.get("name"),
        "position": normalize_position(player.get("position")),
        "pro_team": player.get("pro_team"),
        "ppg": player.get("ppg"),
    }


def _lineup_input(players: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Board players in the shape ``best_lineup`` reads."""
    out = []
    for index, player in enumerate(players):
        out.append(
            {
                **player,
                "key": player.get("player_id") or f"row:{index}:{player.get('name')}",
                "position": normalize_position(player.get("position")),
                "ppg": float(player.get("ppg") or 0.0),
            }
        )
    return out


def _lineup(slots, players, eligibility):
    points, filled = best_lineup(slots, players, eligibility)
    return points, {player["key"] for _slot, player in filled}, filled


def suggest_pickups(
    team: Dict[str, Any],
    replacements: Dict[str, Dict[str, Any]],
    slots: Sequence[str],
    eligibility: Dict[str, frozenset],
) -> List[Dict[str, Any]]:
    """Free agents who lift the best lineup, biggest lift first."""
    roster = _lineup_input(team.get("players") or [])
    base, base_keys, _ = _lineup(slots, roster, eligibility)
    pickups = []
    for free_agent in replacements.values():
        if not free_agent.get("name"):
            continue
        candidate = _lineup_input([free_agent])[0]
        candidate["key"] = f"fa:{candidate['key']}"
        points, keys, filled = _lineup(slots, roster + [candidate], eligibility)
        gain = points - base
        if gain < MIN_PICKUP_GAIN:
            continue
        slot = next((s for s, p in filled if p["key"] == candidate["key"]), None)
        displaced = [p for p in roster if p["key"] in base_keys and p["key"] not in keys]
        same = [p for p in displaced if p["position"] == candidate["position"]]
        bench = [p for p in roster if p["key"] not in keys and not p.get("out")]
        if same:
            drop = same[0]
        elif bench:
            drop = min(bench, key=lambda p: p["ppg"])
        else:
            drop = None
        pickups.append(
            {
                "add": _player(candidate),
                "slot": slot,
                "replaces": _player(displaced[0]) if displaced else None,
                "gain": round(gain, 1),
                "drop": _player(drop),
            }
        )
    pickups.sort(key=lambda move: -move["gain"])
    return pickups[:MAX_PICKUPS]


def suggest_trades(
    team: Dict[str, Any],
    teams: List[Dict[str, Any]],
    slots: Sequence[str],
    eligibility: Dict[str, frozenset],
) -> List[Dict[str, Any]]:
    """Near-even one-for-one swaps that lift both lineups; one per partner."""
    mine = _lineup_input(team.get("players") or [])
    my_base, _, _ = _lineup(slots, mine, eligibility)
    ideas = []
    for partner in teams:
        if partner.get("espn_team_id") == team.get("espn_team_id"):
            continue
        theirs = _lineup_input(partner.get("players") or [])
        their_base, _, _ = _lineup(slots, theirs, eligibility)
        best = None
        for give in mine:
            if give["ppg"] <= 0 or give.get("out"):
                continue
            for get in theirs:
                if get["ppg"] <= 0 or get.get("out"):
                    continue
                if abs(get["ppg"] - give["ppg"]) > FAIR_BAND:
                    continue
                my_after = [p for p in mine if p is not give] + [get]
                my_gain = _lineup(slots, my_after, eligibility)[0] - my_base
                if my_gain < MIN_TRADE_GAIN:
                    continue
                their_after = [p for p in theirs if p is not get] + [give]
                their_gain = _lineup(slots, their_after, eligibility)[0] - their_base
                if their_gain < MIN_TRADE_GAIN:
                    continue
                # The biggest combined lift, then the closest to even.
                key = (-(my_gain + their_gain), abs(get["ppg"] - give["ppg"]))
                if best is None or key < best[0]:
                    best = (key, give, get, my_gain, their_gain)
        if best is None:
            continue
        _key, give, get, my_gain, their_gain = best
        ideas.append(
            {
                "partner": {
                    "espn_team_id": partner.get("espn_team_id"),
                    "name": partner.get("name"),
                    "abbrev": partner.get("abbrev"),
                    "owner_name": partner.get("owner_name"),
                },
                "give": _player(give),
                "get": _player(get),
                "my_gain": round(my_gain, 1),
                "their_gain": round(their_gain, 1),
            }
        )
    ideas.sort(key=lambda idea: -(idea["my_gain"] + idea["their_gain"]))
    return ideas[:MAX_TRADES]


def team_moves(
    team_id: int,
    board: Dict[str, Any],
    eligibility: Dict[str, frozenset],
) -> Dict[str, Any]:
    """Pickups and trade ideas for one team off a roster-power board."""
    teams = board.get("teams") or []
    team = next((t for t in teams if t.get("espn_team_id") == team_id), None)
    if team is None:
        return {"available": False, "unavailable_reason": "team_not_on_board"}
    return {
        "available": True,
        "unavailable_reason": None,
        "need": team.get("need"),
        "surplus": [_player(p) for p in team.get("surplus") or []],
        "pickups": suggest_pickups(
            team, board.get("replacements") or {}, board.get("slots") or [], eligibility
        ),
        "trades": suggest_trades(team, teams, board.get("slots") or [], eligibility),
    }
