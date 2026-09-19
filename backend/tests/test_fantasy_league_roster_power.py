"""Roster power: lineup-aware team strength and per-player value."""
import random

import pytest

from app.services import fantasy_league_roster_power as rp
from app.services.fantasy_league_data import SLOT_ELIGIBILITY, _player_value

# The 2026 league: one QB, a superflex (OP), two flexes.
SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "OP", "DST", "K"]


def player(key, position, ppg, **extra):
    return {"key": key, "name": key, "position": position, "ppg": ppg, **extra}


def roster_with_qbs(*qb_values):
    return [
        *(player(f"QB{i}", "QB", value) for i, value in enumerate(qb_values, 1)),
        player("RB1", "RB", 15), player("RB2", "RB", 12), player("RB3", "RB", 10),
        player("WR1", "WR", 14), player("WR2", "WR", 12), player("WR3", "WR", 9),
        player("TE1", "TE", 8), player("DEF1", "DEF", 6), player("K1", "K", 8),
    ]


WAIVERS = {
    "QB": player("wQB", "QB", 11, replacement=True),
    "RB": player("wRB", "RB", 5, replacement=True),
    "WR": player("wWR", "WR", 6, replacement=True),
    "TE": player("wTE", "TE", 5, replacement=True),
    "DEF": player("wDEF", "DEF", 5, replacement=True),
    "K": player("wK", "K", 7, replacement=True),
}


def test_the_league_slots_are_laminar_so_the_fast_solver_applies():
    assert rp.is_laminar(SLOTS, SLOT_ELIGIBILITY)
    assert not rp.is_laminar(["RB/WR", "WR/TE"], SLOT_ELIGIBILITY)


@pytest.mark.parametrize("seed", range(40))
def test_greedy_lineup_matches_the_exact_solver(seed):
    rng = random.Random(seed)
    positions = ["QB", "RB", "WR", "TE", "DEF", "K"]
    pool = [
        player(f"p{i}", rng.choice(positions), round(rng.uniform(0, 25), 1))
        for i in range(rng.randint(4, 20))
    ]
    greedy = rp._greedy_lineup(SLOTS, pool, SLOT_ELIGIBILITY)
    exact = rp._exact_lineup(SLOTS, pool, SLOT_ELIGIBILITY)
    assert sum(p["ppg"] for _, p in greedy) == pytest.approx(sum(p["ppg"] for _, p in exact))


def test_a_third_quarterback_is_insurance_and_a_fifth_is_worth_nothing():
    """Two QBs start (QB + OP). The third covers absences; past that, nothing."""
    teams = rp.rank_rosters(
        SLOTS, {1: roster_with_qbs(20, 18, 16, 15, 14)}, WAIVERS, SLOT_ELIGIBILITY
    )
    value = {p["key"]: p["marginal"] for p in teams[0]["players"]}
    assert value["QB1"] > value["QB3"] > 0
    assert value["QB4"] == pytest.approx(0.0, abs=0.01)
    assert value["QB5"] == pytest.approx(0.0, abs=0.01)
    # Good enough to start elsewhere, useless here: that is surplus.
    # Jointly: QB3 and QB4 each look free while the other covers, but only
    # two of the three backups can go without costing anything.
    assert {p["key"] for p in teams[0]["surplus"]} == {"QB4", "QB5"}


def test_stacking_one_position_ranks_below_a_balanced_roster():
    stacked = roster_with_qbs(20, 19, 18, 17, 16)
    balanced = roster_with_qbs(20, 17) + [player("RB4", "RB", 14), player("WR4", "WR", 13)]
    teams = rp.rank_rosters(
        SLOTS, {"stacked": stacked, "balanced": balanced}, WAIVERS, SLOT_ELIGIBILITY
    )
    assert [team["team_id"] for team in teams] == ["balanced", "stacked"]


def test_an_empty_seat_is_filled_from_waivers_and_called_out_as_the_need():
    thin = roster_with_qbs(20)  # nobody for the OP seat but a waiver QB
    full = roster_with_qbs(20, 17)
    teams = rp.rank_rosters(SLOTS, {"thin": thin, "full": full}, WAIVERS, SLOT_ELIGIBILITY)
    by_id = {team["team_id"]: team for team in teams}
    assert [p["key"] for p in by_id["thin"]["waiver_starters"]] == ["wQB"]
    assert by_id["thin"]["need"]["slot"] == "OP"
    assert by_id["thin"]["need"]["seat"] == "OP"
    assert by_id["thin"]["need"]["from_waivers"] is True
    assert by_id["full"]["need"] is None or by_id["full"]["need"]["slot"] != "OP"


def test_absences_cost_a_roster_with_no_bench_more():
    shallow = roster_with_qbs(20, 17)
    deep = shallow + [player("RB4", "RB", 9), player("WR4", "WR", 8)]
    teams = rp.rank_rosters(SLOTS, {"deep": deep, "shallow": shallow}, WAIVERS, SLOT_ELIGIBILITY)
    by_id = {team["team_id"]: team for team in teams}
    assert by_id["deep"]["lineup_points"] == by_id["shallow"]["lineup_points"]
    assert by_id["shallow"]["absence_cost"] > by_id["deep"]["absence_cost"]


def test_replacement_level_skips_rostered_players():
    pool = [player("a", "QB", 20), player("b", "QB", 12), player("c", "RB", 8)]
    level = rp.replacement_level(pool, {"a"})
    assert level["QB"]["key"] == "b" and level["QB"]["replacement"] is True
    assert level["RB"]["key"] == "c"


def test_player_value_blends_season_and_week_and_discounts_absences():
    assert _player_value(170.0, 14.0, False, False)["ppg"] == pytest.approx(12.0)
    # A bye week says nothing about the player.
    assert _player_value(170.0, 0.0, True, False)["ppg"] == pytest.approx(10.0)
    # Projected for zero while playing: out, at half value.
    out = _player_value(170.0, 0.0, False, False)
    assert out["out"] is True and out["ppg"] == pytest.approx(5.0)
    assert _player_value(170.0, 14.0, False, True)["ppg"] == pytest.approx(5.0)
    assert _player_value(None, None, False, False)["projected"] is False


def test_a_need_in_a_multi_seat_slot_names_the_seat():
    """A thin second running back is an RB2 problem, not an RB1 one."""
    strong = roster_with_qbs(20, 17)
    thin = [p for p in roster_with_qbs(20, 17) if p["key"] != "RB2"] + [player("RBx", "RB", 7)]
    teams = rp.rank_rosters(SLOTS, {"strong": strong, "thin": thin}, WAIVERS, SLOT_ELIGIBILITY)
    need = {team["team_id"]: team for team in teams}["thin"]["need"]
    assert need["seat"] == "RB2"
