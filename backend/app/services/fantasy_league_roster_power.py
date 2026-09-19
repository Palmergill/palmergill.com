"""Roster power: how strong a team is, judged by who is on it.

The results-based power rankings in ``fantasy_league_rankings`` read the
scoreboard. This reads the rosters, and the question it answers is the one a
trade conversation actually turns on: how many points a week can this roster
be expected to put in a legal lineup, for the rest of the season?

Three ideas carry it, and each is small enough to explain on the page:

* A player is worth his projected points per game.
* A team is worth the best legal lineup it can field under this league's own
  slots — so a fifth quarterback in a league that starts at most two adds
  nothing, however good he is.
* Starters miss games. When one does, the next-best eligible player takes his
  seat: from the bench, or from waivers when the bench has no one better.
  That is the only thing depth is worth, which is where diminishing returns
  come from without anyone having to write a rule for them.

A player's value *to a team* is then how much the team's expected points drop
without him. A good player a team cannot use scores near zero — that gap
between what a player is worth and what he is worth *here* is what the page
calls surplus.

Everything here is pure: rosters, slots and per-game values go in, numbers
come out. The database joins live in ``fantasy_league_data``.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# How often a starter is unavailable in a given week: one bye in a 17-game
# season (~6%) plus a typical injury rate for fantasy starters (~9%). One
# number for every position keeps the model explainable; running backs miss
# more than kickers, and a later version could say so.
ABSENCE_RATE = 0.15

# A player out this week, or parked on IR, counts at this share of his
# season-long value. The feed cannot tell a one-week absence from a
# season-ending one, and either extreme would be confidently wrong.
OUT_DISCOUNT = 0.5

# A player adds less than this many points a week to his own team…
SURPLUS_MARGINAL = 0.5
# …while projecting at least this far above what waivers offer at his
# position: good enough to matter somewhere else.
SURPLUS_OVER_REPLACEMENT = 2.0

DEF_ALIASES = frozenset({"DEF", "DST", "D/ST"})


def normalize_position(position: Optional[str]) -> str:
    value = (position or "").upper()
    return "DEF" if value in DEF_ALIASES else value


def _eligible(slot: str, position: str, eligibility: Dict[str, frozenset]) -> bool:
    allowed = eligibility.get(slot) or frozenset()
    if position == "DEF":
        return bool(allowed & DEF_ALIASES)
    return position in allowed


def is_laminar(slots: Sequence[str], eligibility: Dict[str, frozenset]) -> bool:
    """True when every pair of slot types is either nested or disjoint.

    QB ⊂ OP and RB ⊂ FLEX ⊂ OP are nested; RB/WR against WR/TE overlap
    without nesting. Only laminar leagues can use the greedy solver.
    """
    sets = [frozenset(eligibility.get(slot) or ()) for slot in set(slots)]
    for index, left in enumerate(sets):
        for right in sets[index + 1:]:
            shared = left & right
            if shared and shared != left and shared != right:
                return False
    return True


def _greedy_lineup(
    slots: Sequence[str],
    players: Sequence[Dict[str, Any]],
    eligibility: Dict[str, frozenset],
) -> List[Tuple[str, Dict[str, Any]]]:
    """Exact for laminar slot sets.

    Players go in best-first, each into the narrowest open seat he fits. With
    nested eligibility, the narrow seat is the one no later player could have
    used more flexibly, so no earlier choice ever needs undoing.
    """
    capacity: Dict[str, int] = {}
    for slot in slots:
        capacity[slot] = capacity.get(slot, 0) + 1
    by_width = sorted(capacity, key=lambda slot: (len(eligibility.get(slot) or ()), slot))

    filled: List[Tuple[str, Dict[str, Any]]] = []
    for player in sorted(players, key=lambda p: (-p["ppg"], str(p.get("key")))):
        if player["ppg"] <= 0:
            break
        for slot in by_width:
            if capacity[slot] and _eligible(slot, player["position"], eligibility):
                capacity[slot] -= 1
                filled.append((slot, player))
                break
    return filled


def _exact_lineup(
    slots: Sequence[str],
    players: Sequence[Dict[str, Any]],
    eligibility: Dict[str, frozenset],
) -> List[Tuple[str, Dict[str, Any]]]:
    """Seat-mask dynamic program, for leagues with overlapping flex slots.

    Slower than the greedy path, so only players who could plausibly start
    are considered: for each position, no more than the number of seats that
    position can occupy.
    """
    seats = list(slots)
    reach: Dict[str, int] = {}
    ranked = sorted(players, key=lambda p: (-p["ppg"], str(p.get("key"))))
    shortlist = []
    for player in ranked:
        if player["ppg"] <= 0:
            continue
        limit = sum(1 for slot in seats if _eligible(slot, player["position"], eligibility))
        if reach.get(player["position"], 0) < limit:
            reach[player["position"]] = reach.get(player["position"], 0) + 1
            shortlist.append(player)

    states: Dict[int, Tuple[float, Tuple[Tuple[int, int], ...]]] = {0: (0.0, ())}
    for player_index, player in enumerate(shortlist):
        for mask, (points, assigned) in list(states.items()):
            for seat_index, slot in enumerate(seats):
                bit = 1 << seat_index
                if mask & bit or not _eligible(slot, player["position"], eligibility):
                    continue
                proposal = (points + player["ppg"], assigned + ((seat_index, player_index),))
                current = states.get(mask | bit)
                if current is None or proposal[0] > current[0]:
                    states[mask | bit] = proposal
    _, (_, assigned) = max(states.items(), key=lambda item: item[1][0])
    return [(seats[seat], shortlist[index]) for seat, index in assigned]


def best_lineup(
    slots: Sequence[str],
    players: Sequence[Dict[str, Any]],
    eligibility: Dict[str, frozenset],
) -> Tuple[float, List[Tuple[str, Dict[str, Any]]]]:
    """The highest-scoring legal lineup: (points, [(slot, player), ...])."""
    solver = _greedy_lineup if is_laminar(slots, eligibility) else _exact_lineup
    filled = solver(slots, players, eligibility)
    return sum(player["ppg"] for _, player in filled), filled


def expected_points(
    slots: Sequence[str],
    roster: Sequence[Dict[str, Any]],
    replacements: Sequence[Dict[str, Any]],
    eligibility: Dict[str, frozenset],
    absence_rate: float = ABSENCE_RATE,
) -> Dict[str, Any]:
    """Expected weekly points once starters' absences are covered.

    Each rostered starter is out ``absence_rate`` of the time, one at a time;
    what that costs is the drop to the best lineup without him. Waiver
    replacements sit in the pool throughout, so a thin roster is judged
    against what anyone could pick up rather than against an empty seat.
    """
    pool = list(roster) + list(replacements)
    full, lineup = best_lineup(slots, pool, eligibility)
    exposure = 0.0
    losses: Dict[Any, float] = {}
    for _slot, starter in lineup:
        if starter.get("replacement"):
            continue
        without = [player for player in pool if player is not starter]
        points, _ = best_lineup(slots, without, eligibility)
        losses[starter["key"]] = full - points
        exposure += full - points
    return {
        "lineup_points": full,
        "absence_cost": absence_rate * exposure,
        "expected": full - absence_rate * exposure,
        "lineup": lineup,
        "losses": losses,
    }


def replacement_level(
    pool: Iterable[Dict[str, Any]], rostered: Iterable[Any]
) -> Dict[str, Dict[str, Any]]:
    """The best unrostered player at each position — what waivers offer."""
    taken = set(rostered)
    best: Dict[str, Dict[str, Any]] = {}
    for player in pool:
        if player["key"] in taken or player["ppg"] <= 0:
            continue
        current = best.get(player["position"])
        if current is None or player["ppg"] > current["ppg"]:
            best[player["position"]] = {**player, "replacement": True}
    return best


def rank_rosters(
    slots: Sequence[str],
    rosters: Dict[Any, List[Dict[str, Any]]],
    replacements: Dict[str, Dict[str, Any]],
    eligibility: Dict[str, frozenset],
    absence_rate: float = ABSENCE_RATE,
) -> List[Dict[str, Any]]:
    """Every team's roster strength, strongest first, with per-player value.

    Players arrive as {"key", "position", "ppg", ...}; whatever else they
    carry (name, team, injury) rides along untouched.
    """
    waiver = list(replacements.values())
    teams = []
    for team_id, roster in rosters.items():
        base = expected_points(slots, roster, waiver, eligibility, absence_rate)
        starter_slot = {player["key"]: slot for slot, player in base["lineup"]}
        players = []
        for player in roster:
            without = [other for other in roster if other is not player]
            reduced = expected_points(slots, without, waiver, eligibility, absence_rate)
            floor = replacements.get(player["position"])
            players.append(
                {
                    **player,
                    "slot": starter_slot.get(player["key"]),
                    "marginal": base["expected"] - reduced["expected"],
                    "over_replacement": player["ppg"] - (floor["ppg"] if floor else 0.0),
                }
            )
        players.sort(key=lambda p: (p["slot"] is None, -p["marginal"], -p["ppg"]))
        spare = {
            player["key"]
            for player in surplus(slots, roster, replacements, eligibility, absence_rate)
        }
        teams.append(
            {
                "team_id": team_id,
                "expected": base["expected"],
                "lineup_points": base["lineup_points"],
                "absence_cost": base["absence_cost"],
                "waiver_starters": [
                    {"slot": slot, **player}
                    for slot, player in base["lineup"]
                    if player.get("replacement")
                ],
                "players": players,
                "surplus": [player for player in players if player["key"] in spare],
            }
        )

    teams.sort(key=lambda team: -team["expected"])
    for index, team in enumerate(teams, start=1):
        team["rank"] = index
    _annotate_needs(teams)
    return teams


def surplus(
    slots: Sequence[str],
    roster: Sequence[Dict[str, Any]],
    replacements: Dict[str, Dict[str, Any]],
    eligibility: Dict[str, frozenset],
    absence_rate: float = ABSENCE_RATE,
) -> List[Dict[str, Any]]:
    """Players worth more to someone else than to this roster — jointly.

    Taken one at a time, and recomputed after each. Two redundant backups
    each look free on their own, because the other covers for him; trading
    both would not be. So the most expendable goes first, and the next is
    judged on the roster without him.
    """
    waiver = list(replacements.values())
    remaining = list(roster)
    chosen: List[Dict[str, Any]] = []
    while True:
        base = expected_points(slots, remaining, waiver, eligibility, absence_rate)["expected"]
        best = None
        for player in remaining:
            floor = replacements.get(player["position"])
            if player["ppg"] - (floor["ppg"] if floor else 0.0) < SURPLUS_OVER_REPLACEMENT:
                continue
            without = [other for other in remaining if other is not player]
            cost = base - expected_points(slots, without, waiver, eligibility, absence_rate)["expected"]
            if cost < SURPLUS_MARGINAL and (best is None or cost < best[0]):
                best = (cost, player)
        if best is None:
            return chosen
        chosen.append(best[1])
        remaining = [other for other in remaining if other is not best[1]]


def _annotate_needs(teams: List[Dict[str, Any]]) -> None:
    """Mark each team's weakest starter against the league at that seat.

    Compared slot by slot (the second RB against other teams' second RBs), so
    a team is not told it needs a QB because QBs score more than kickers.
    """
    by_seat: Dict[Tuple[str, int], List[float]] = {}
    seats_for: Dict[Any, List[Tuple[Tuple[str, int], Dict[str, Any]]]] = {}
    for team in teams:
        starters = [p for p in team["players"] if p["slot"]] + [
            {**p, "name": p.get("name")} for p in team["waiver_starters"]
        ]
        order: Dict[str, int] = {}
        seats = []
        for player in sorted(starters, key=lambda p: -p["ppg"]):
            slot = player["slot"]
            order[slot] = order.get(slot, 0) + 1
            seat = (slot, order[slot])
            by_seat.setdefault(seat, []).append(player["ppg"])
            seats.append((seat, player))
        seats_for[team["team_id"]] = seats

    # "RB2" when a slot has more than one seat, plain "TE" when it has one, so
    # the page can say which seat is thin rather than naming a player as if
    # he were the problem.
    seats_per_slot: Dict[str, int] = {}
    for slot, index in by_seat:
        seats_per_slot[slot] = max(seats_per_slot.get(slot, 0), index)

    for team in teams:
        worst = None
        for seat, player in seats_for[team["team_id"]]:
            values = by_seat[seat]
            average = sum(values) / len(values)
            gap = player["ppg"] - average
            if worst is None or gap < worst["gap"]:
                worst = {
                    "slot": seat[0],
                    "seat": f"{seat[0]}{seat[1]}" if seats_per_slot[seat[0]] > 1 else seat[0],
                    "name": player.get("name"),
                    "position": player["position"],
                    "ppg": player["ppg"],
                    "league_average": average,
                    "gap": gap,
                    "from_waivers": bool(player.get("replacement")),
                }
        team["need"] = worst if worst and worst["gap"] < 0 else None
