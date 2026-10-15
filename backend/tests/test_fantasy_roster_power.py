from app.services import fantasy_league_roster_power as roster_power

ELIGIBILITY = {
    "QB": frozenset({"QB"}),
    "RB": frozenset({"RB"}),
    "DST": frozenset({"DEF"}),
}
SLOTS = ["QB", "RB", "DST"]


def player(key, position, ppg):
    return {"key": key, "position": position, "ppg": ppg, "name": key}


def test_lineups_use_only_the_roster_and_leave_unfillable_seats_empty():
    rosters = {
        1: [player("qb", "QB", 20.0), player("rb", "RB", 12.0), player("rb2", "RB", 8.0)],
        2: [player("qb-b", "QB", 18.0), player("rb-b", "RB", 11.0), player("def-b", "DEF", 6.0)],
    }
    # A strong free agent at every position, none of whom may start.
    replacements = {
        "QB": {**player("fa-qb", "QB", 30.0), "replacement": True},
        "RB": {**player("fa-rb", "RB", 25.0), "replacement": True},
        "DEF": {**player("fa-def", "DEF", 9.0), "replacement": True},
    }

    teams = roster_power.rank_rosters(SLOTS, rosters, replacements, ELIGIBILITY)
    team = next(t for t in teams if t["team_id"] == 1)

    assert team["lineup_points"] == 32.0
    assert team["empty_slots"] == ["DST"]
    # Losing the QB leaves the seat empty; losing the RB brings in rb2.
    assert team["absence_cost"] == roster_power.ABSENCE_RATE * (20.0 + 4.0)
    assert team["need"]["empty"] is True
    assert team["need"]["seat"] == "DST"
    assert all(not p.get("replacement") for p in team["players"])
