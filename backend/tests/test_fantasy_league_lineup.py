"""The start/sit assignment (spec 17 P5).

The interesting claim in ``_optimal_lineup`` is that a greedy fill — narrowest
seat first, best available player — is the *optimum* rather than a decent
approximation. That holds because the eligibility sets are laminar: any two are
nested or disjoint. It is not obvious, and it would fail quietly if someone
added a slot that overlaps two others partially (say a "QB/WR" flex), so it is
pinned here against brute force rather than asserted in a comment.
"""
import json
import random
import pytest

from app.database import FantasyLeagueSeason
from app.services import fantasy_league_data as ld


def candidate(player_id, position, points):
    return {"player_id": player_id, "_position": position, "_points": points}


def brute_force_best(slots, candidates):
    """Highest total over every legal assignment, including partial ones.

    A seat may go unfilled — no eligible player left — so the search has to
    allow skipping one rather than only scoring full lineups.
    """

    def search(seat, used):
        if seat == len(slots):
            return 0.0
        best = search(seat + 1, used)
        for index, player in enumerate(candidates):
            if index in used:
                continue
            if player["_position"] not in ld.SLOT_ELIGIBILITY[slots[seat]]:
                continue
            best = max(best, player["_points"] + search(seat + 1, used | {index}))
        return best

    return search(0, frozenset())


class TestStartingSlots:
    def _season(self, counts):
        return FantasyLeagueSeason(
            season=2026, lineup_slot_counts_json=json.dumps(counts)
        )

    def test_expands_counts_into_one_entry_per_seat(self):
        # ESPN keys by slot id: 0 QB, 2 RB, 4 WR, 6 TE, 23 FLEX, 20 BENCH.
        slots = ld._starting_slots(
            self._season({"0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "20": 7})
        )
        assert slots == ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"]

    def test_superflex_is_a_seat_like_any_other(self):
        slots = ld._starting_slots(self._season({"0": 1, "7": 1, "2": 1}))
        assert slots == ["QB", "RB", "OP"]

    def test_bench_ir_and_unknown_slots_are_not_a_lineup(self):
        assert ld._starting_slots(self._season({"20": 7, "21": 1})) == []
        # 18 is a punter slot; nothing here knows how to fill it.
        assert ld._starting_slots(self._season({"18": 1, "0": 1})) == ["QB"]

    def test_a_league_with_no_stored_settings_has_no_lineup(self):
        assert ld._starting_slots(None) == []
        assert ld._starting_slots(FantasyLeagueSeason(season=2026)) == []
        assert ld._starting_slots(self._season("not-a-dict")) == []


class TestOptimalLineup:
    def test_the_flex_takes_the_best_player_the_narrow_seats_left(self):
        slots = ["QB", "RB", "WR", "FLEX"]
        candidates = [
            candidate("qb1", "QB", 22.0),
            candidate("rb1", "RB", 18.0),
            candidate("rb2", "RB", 15.0),
            candidate("wr1", "WR", 12.0),
        ]
        filled = ld._optimal_lineup(slots, candidates)
        assert [(entry["player_id"], entry["slot"]) for entry in filled] == [
            ("qb1", "QB"),
            ("rb1", "RB"),
            ("wr1", "WR"),
            ("rb2", "FLEX"),
        ]

    def test_a_superflex_seat_takes_a_quarterback_only_when_he_is_worth_it(self):
        slots = ["QB", "OP"]
        strong_backup = ld._optimal_lineup(
            ["QB", "OP"],
            [
                candidate("qb1", "QB", 24.0),
                candidate("qb2", "QB", 19.0),
                candidate("rb1", "RB", 16.0),
            ],
        )
        assert [entry["player_id"] for entry in strong_backup] == ["qb1", "qb2"]

        weak_backup = ld._optimal_lineup(
            slots,
            [
                candidate("qb1", "QB", 24.0),
                candidate("qb2", "QB", 9.0),
                candidate("rb1", "RB", 16.0),
            ],
        )
        assert [entry["player_id"] for entry in weak_backup] == ["qb1", "rb1"]

    def test_a_seat_with_nobody_eligible_is_left_empty(self):
        filled = ld._optimal_lineup(
            ["QB", "TE"], [candidate("qb1", "QB", 20.0)]
        )
        assert [entry["slot"] for entry in filled] == ["QB"]

    @pytest.mark.parametrize("seed", range(25))
    def test_greedy_matches_brute_force(self, seed):
        rng = random.Random(seed)
        pool = ["QB", "RB", "WR", "TE", "FLEX", "OP"]
        slots = [rng.choice(pool) for _ in range(rng.randint(2, 5))]
        candidates = [
            candidate(f"p{index}", rng.choice(["QB", "RB", "WR", "TE"]), rng.randint(0, 30) / 1.0)
            for index in range(rng.randint(2, 7))
        ]
        greedy = sum(entry["_points"] for entry in ld._optimal_lineup(slots, candidates))
        assert greedy == pytest.approx(brute_force_best(slots, candidates))
