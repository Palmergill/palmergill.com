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


def test_injured_reserve_counts_for_nothing_whatever_he_has_scored():
    value = _player_value(16.0, 6, 86.4, 6, absence=_absence("NORMAL", "IR"))
    assert value["ppg"] == 0.0
    assert value["absence"] == "long"
    # A manager's IR slot means the same, whatever the feeds say.
    assert _player_value(16.0, 6, 86.4, 6, on_ir=True)["ppg"] == 0.0


def test_actual_scoring_gains_weight_as_games_accumulate():
    # Projected 10 a week, actually scoring 20 a game.
    early = _player_value(10.0, 3, 40.0, 2)
    late = _player_value(10.0, 13, 240.0, 12)
    assert round(early["ppg"], 2) == round(10 + (20 - 10) * 2 / 6, 2)
    assert round(late["ppg"], 2) == round(10 + (20 - 10) * 12 / 16, 2)
    assert late["ppg"] > early["ppg"]
    # No games yet: the current projection alone.
    assert _player_value(10.0, 1, None, 0)["ppg"] == 10.0


def test_out_this_week_counts_at_half_of_his_current_level():
    value = _player_value(12.0, 5, 72.0, 6, out_this_week=True)
    assert value["out"] is True
    assert round(value["ppg"], 2) == round(0.5 * (0.6 * 12.0 + 0.4 * 12.0), 2)


def test_absence_reads_every_feed_and_ignores_espn_normal():
    assert _absence("NORMAL", None) is None
    assert _absence("NORMAL", "Out") == "out"
    assert _absence("INJURY_RESERVE") == "long"
    assert _absence("Questionable") is None
