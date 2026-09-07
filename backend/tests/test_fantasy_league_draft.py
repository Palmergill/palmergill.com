"""Draft recap maths: replacement level, sub-scores, and the curve.

All network-free and mostly DB-free — the grading logic is pure, so it is
tested directly rather than through a seeded database.
"""
import math

import pytest

from app.services import fantasy_league_draft as fld

# The league's real starting lineup for 2026: QB, 2RB, 2WR, TE, OP (the
# superflex seat), 2 FLEX, K, DST.
SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "OP", "FLEX", "FLEX", "K", "DST"]


def board(**counts):
    """A synthetic projection board: {position: (how many, best player's points)}."""
    points, positions = {}, {}
    for position, (count, top) in counts.items():
        for index in range(count):
            player_id = f"{position}{index}"
            positions[player_id] = position
            points[player_id] = top - index * 5
    return points, positions


# ── replacement level ───────────────────────────────────────────────────


def test_superflex_pushes_quarterback_replacement_far_deeper():
    # The whole reason baselines are derived rather than reused: with an OP
    # seat, 20 of 10 teams' seats can hold a QB, so replacement is the 21st
    # quarterback — not the 13th a one-QB league would use.
    points, positions = board(
        QB=(40, 400), RB=(60, 300), WR=(80, 290), TE=(30, 220), K=(20, 140), DEF=(20, 130)
    )
    levels = fld.replacement_levels(SLOTS, points, positions, teams=10)
    assert levels["QB"] == 300  # QB20, i.e. the 21st quarterback
    assert levels["RB"] == 150
    assert levels["QB"] > levels["RB"]


def test_flex_seats_are_shared_out_by_value_not_split_evenly():
    points, positions = board(
        QB=(40, 400), RB=(60, 300), WR=(80, 290), TE=(30, 220), K=(20, 140), DEF=(20, 130)
    )
    levels = fld.replacement_levels(SLOTS, points, positions, teams=10)
    # RB and WR both eat flex seats, so their replacement levels land close
    # together; TE is scarcer at the top and drains out at a similar depth.
    assert abs(levels["RB"] - levels["WR"]) <= 10


def test_a_position_whose_whole_pool_starts_still_gets_a_level():
    # 8 kickers cannot fill 10 seats; the weakest is the only honest floor,
    # and returning nothing would make his VOR undefined.
    points, positions = board(QB=(40, 400), RB=(60, 300), WR=(80, 290), TE=(30, 220), K=(8, 140))
    levels = fld.replacement_levels(SLOTS, points, positions, teams=10)
    assert levels["K"] == 140 - 7 * 5


def test_without_slot_settings_nobody_is_credited_with_value():
    # No lineup means no seats, so the best player himself becomes the
    # replacement and every VOR comes out at or below zero. Degenerate, but
    # conservative — the alternative is inventing value from a league whose
    # settings were never collected.
    points, positions = board(RB=(5, 100))
    assert fld.replacement_levels([], points, positions, teams=10) == {"RB": 100}


# ── the curve ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "composite,letter",
    [(2.0, "A+"), (1.1, "A"), (0.5, "B+"), (0.0, "B-"), (-0.5, "C"), (-2.0, "F")],
)
def test_the_composite_maps_onto_a_curve(composite, letter):
    assert fld._letter(composite) == letter


def test_identical_teams_all_score_zero_rather_than_dividing_by_zero():
    assert fld._zscores({1: 4.0, 2: 4.0, 3: 4.0}) == {1: 0.0, 2: 0.0, 3: 0.0}


def test_an_empty_league_z_scores_to_nothing():
    assert fld._zscores({}) == {}


# ── pick enrichment ─────────────────────────────────────────────────────


class FakePick:
    def __init__(self, overall, team_id, player_id, keeper=False, auto=0, round_id=1):
        self.overall_pick = overall
        self.round_id = round_id
        self.round_pick = overall
        self.espn_team_id = team_id
        self.player_id = player_id
        self.player_name_raw = f"Player {player_id}"
        self.position = "RB"
        self.pro_team = "DET"
        self.keeper = keeper
        self.auto_draft_type_id = auto


def enrich(picks, adp, total=180):
    return fld._enrich_picks(picks, {}, adp, {"best": {}}, {"DET": 6}, total)


def test_a_player_who_lasted_past_his_adp_scores_as_value():
    # ADP 20, still on the board at 30: he fell ten picks, which is value.
    rows = enrich([FakePick(30, 1, "a")], {"a": {"adp": 20.0, "stdev": 5.0}})
    assert rows[0]["adp_delta"] == 10.0
    assert rows[0]["adp_sigma"] == 2.0


def test_a_player_taken_before_his_adp_scores_as_a_reach():
    # ADP 30, taken at 20: ten picks early, which is a reach.
    rows = enrich([FakePick(20, 1, "a")], {"a": {"adp": 30.0, "stdev": 5.0}})
    assert rows[0]["adp_delta"] == -10.0
    assert rows[0]["adp_sigma"] == -2.0


def test_a_tiny_spread_cannot_turn_rounding_noise_into_a_headline():
    # Without the floor a stdev of 0.1 would report a two-pick difference as
    # a twenty-sigma reach, which would win every award forever.
    rows = enrich([FakePick(8, 1, "a")], {"a": {"adp": 10.0, "stdev": 0.1}})
    assert rows[0]["adp_sigma"] == -2.0


def test_the_stdev_floor_grows_with_the_pick_number():
    # A late-rounder whose sample says his spread is under a pick is a sample
    # artifact, not a precise consensus. ADP 140 floors at 7.0, so a 21-pick
    # reach reads as -3 sigma rather than -21.
    rows = enrich([FakePick(119, 1, "a")], {"a": {"adp": 140.0, "stdev": 0.5}})
    assert rows[0]["adp_sigma"] == -3.0


def test_a_player_no_adp_board_listed_is_padded_rather_than_dropped():
    rows = enrich([FakePick(150, 1, "a")], {}, total=180)
    assert rows[0]["adp_ranked"] is False
    # Treated as going one past the end of the draft: taking him at 150 is a
    # small reach against that padding, not free value.
    assert rows[0]["adp_delta"] == -31.0


def test_an_autopicked_selection_is_flagged():
    rows = enrich([FakePick(1, 1, "a", auto=1)], {})
    assert rows[0]["autopicked"] is True


# ── roster construction ─────────────────────────────────────────────────


def roster_row(position, overall=1, round_id=1, bye=None, pro_team="DET", **extra):
    row = {
        "overall_pick": overall,
        "round": round_id,
        "espn_team_id": 1,
        "keeper": False,
        "autopicked": False,
        "player": {
            "player_id": f"p{overall}",
            "name": f"Player {overall}",
            "position": position,
            "pro_team": pro_team,
            "age": 25,
            "years_exp": 3,
            "bye": bye,
        },
        "adp": 10.0,
        "adp_stdev": 2.0,
        "adp_ranked": True,
        "adp_delta": 0.0,
        "adp_sigma": 0.0,
        "points": {},
    }
    row["player"].update(extra.pop("player", {}))
    row.update(extra)
    return row


def starter(row, slot="RB"):
    return {
        "player_id": row["player"]["player_id"],
        "name": row["player"]["name"],
        "_position": row["player"]["position"],
        "_points": 100.0,
        "_pick": row,
        "slot": slot,
    }


def test_one_quarterback_in_a_superflex_league_is_penalised():
    roster = [roster_row("QB"), roster_row("RB", 2)]
    score, notes = fld._construction_score(roster, [], SLOTS, total_rounds=18)
    assert any("one QB" in note for note in notes)
    assert score < 0


def test_two_quarterbacks_in_a_superflex_league_are_not_penalised_for_it():
    roster = [roster_row("QB"), roster_row("QB", 2)]
    _score, notes = fld._construction_score(roster, [], SLOTS, total_rounds=18)
    assert not any("one QB" in note for note in notes)


def test_an_early_kicker_costs_the_grade():
    roster = [roster_row("K", overall=60, round_id=6)]
    score, notes = fld._construction_score(roster, [], SLOTS, total_rounds=18)
    assert any("K/DST" in note for note in notes)
    assert score < 0


def test_a_kicker_in_the_last_round_is_free():
    roster = [roster_row("K", overall=180, round_id=18)]
    _score, notes = fld._construction_score(roster, [], SLOTS, total_rounds=18)
    assert not any("K/DST" in note for note in notes)


def test_stacked_starter_byes_are_penalised_only_once_they_hurt():
    three = [starter(roster_row("RB", i, bye=6)) for i in range(3)]
    _score, notes = fld._construction_score([], three, SLOTS, total_rounds=18)
    assert not any("bye" in note for note in notes)

    five = [starter(roster_row("RB", i, bye=6)) for i in range(5)]
    score, notes = fld._construction_score([], five, SLOTS, total_rounds=18)
    assert any("bye" in note for note in notes)
    assert score < 0


def test_a_lineup_it_cannot_fill_is_the_heaviest_penalty():
    score, notes = fld._construction_score([roster_row("RB")], [], SLOTS, total_rounds=18)
    assert any("starting slot" in note for note in notes)
    assert score <= -8 * len(SLOTS)
