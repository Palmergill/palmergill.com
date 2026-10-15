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


from app.services.fantasy_league_data import _absence, _player_value


def test_injured_reserve_counts_for_nothing_whatever_the_preseason_number():
    # 245 preseason points is 14.4 a game; IR with no weekly projection.
    value = _player_value(245.0, None, False, False, absence=_absence("NORMAL", "IR"), week_covered=True)
    assert value["ppg"] == 0.0
    assert value["absence"] == "long"
    # A manager's IR slot means the same, whatever the feeds say.
    assert _player_value(245.0, 16.0, False, True)["ppg"] == 0.0


def test_missing_from_a_projected_week_counts_as_out_not_as_full_value():
    value = _player_value(245.0, None, False, False, week_covered=True)
    assert value["out"] is True
    assert round(value["ppg"], 2) == round(0.5 * 245.0 / 17, 2)
    # On a bye, a missing week is expected and costs nothing.
    assert _player_value(245.0, None, True, False, week_covered=True)["out"] is False


def test_absence_reads_every_feed_and_ignores_espn_normal():
    assert _absence("NORMAL", None) is None
    assert _absence("NORMAL", "Out") == "out"
    assert _absence("INJURY_RESERVE") == "long"
    assert _absence("Questionable") is None
