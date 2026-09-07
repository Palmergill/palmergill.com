"""Accolade tests.

These are the claims that get argued about, so the cases here are the ones a
naive implementation gets wrong: an award handed to a team that scored zero,
a team ranked last for a coverage gap rather than for its draft, and missing
ages quietly dragging a mean around.
"""
from app.services import fantasy_league_draft as fld

SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "OP", "FLEX", "FLEX", "K", "DST"]
TEAMS = {1: {"name": "Alpha"}, 2: {"name": "Bravo"}, 3: {"name": "Charlie"}}


def pick(
    team_id,
    overall,
    position="RB",
    *,
    name=None,
    pro_team="DET",
    age=25,
    years_exp=3,
    bye=6,
    sigma=0.0,
    stdev=2.0,
    ranked=True,
    sample=500,
    autopicked=False,
    keeper=False,
    points=None,
):
    return {
        "overall_pick": overall,
        "round": (overall - 1) // 3 + 1,
        "espn_team_id": team_id,
        "keeper": keeper,
        "autopicked": autopicked,
        "player": {
            "player_id": f"p{overall}",
            "name": name or f"Player {overall}",
            "position": position,
            "pro_team": pro_team,
            "age": age,
            "years_exp": years_exp,
            "bye": bye,
        },
        "adp": float(overall) + sigma * stdev,
        "adp_stdev": stdev,
        "adp_ranked": ranked,
        "adp_sample": sample,
        "adp_delta": sigma * stdev,
        "adp_sigma": sigma,
        "points": points or {},
    }


def starter(row, slot="RB"):
    return {
        "player_id": row["player"]["player_id"],
        "name": row["player"]["name"],
        "_position": row["player"]["position"],
        "_points": 100.0,
        "_pick": row,
        "slot": slot,
    }


def run(rosters, starters=None):
    starters = starters or {
        team_id: [starter(row) for row in roster] for team_id, roster in rosters.items()
    }
    flat = sorted(
        (row for roster in rosters.values() for row in roster),
        key=lambda row: row["overall_pick"],
    )
    awards = fld._accolades(rosters, starters, TEAMS, flat, SLOTS)
    return {award["key"]: award for award in awards}


def test_every_award_names_a_runner_up_so_it_is_never_a_bare_assertion():
    rosters = {
        1: [pick(1, 1, years_exp=0), pick(1, 4, years_exp=0)],
        2: [pick(2, 2, years_exp=0)],
        3: [pick(3, 3)],
    }
    award = run(rosters)["rookie_fever"]
    assert award["winner"]["team"] == "Alpha"
    assert award["runner_up"]["team"] == "Bravo"
    assert len(award["standings"]) == 3


def test_an_award_nobody_earned_is_omitted_rather_than_given_to_a_zero():
    # "Nobody drafted a rookie" is a fact about the draft, not a trophy.
    rosters = {1: [pick(1, 1)], 2: [pick(2, 2)], 3: [pick(3, 3)]}
    assert "rookie_fever" not in run(rosters)
    assert "autopick" not in run(rosters)
    assert "handcuff_hoarder" not in run(rosters)


def test_the_autopick_award_goes_to_whoever_was_away_from_their_keyboard():
    rosters = {
        1: [pick(1, 1, autopicked=True), pick(1, 4, autopicked=True)],
        2: [pick(2, 2, autopicked=True)],
        3: [pick(3, 3)],
    }
    assert run(rosters)["autopick"]["winner"]["team"] == "Alpha"


def test_a_thinly_priced_roster_is_unrankable_for_vegas_not_ranked_last():
    # The market prices a few hundred players. A roster it barely covers would
    # finish last for a reason that has nothing to do with how it was drafted.
    rosters = {
        1: [pick(1, n, points={"vegas": 200.0}) for n in (1, 4, 7, 10, 13)],
        2: [pick(2, n, points={"vegas": 100.0}) for n in (2, 5, 8, 11, 14)],
        3: [pick(3, n, points={} if n > 3 else {"vegas": 90.0}) for n in (3, 6, 9, 12, 15)],
    }
    award = run(rosters)["vegas_favourite"]
    assert award["winner"]["team"] == "Alpha"
    assert [row["team"] for row in award["unrankable"]] == ["Charlie"]
    assert "too few starters priced" in award["note"]
    assert 3 not in [row["espn_team_id"] for row in award["standings"]]


def test_the_three_scorers_are_ranked_independently_of_each_other():
    # ESPN's favourite roster being Vegas's least favourite is the single most
    # interesting thing this page can say, so the boards must not share one.
    rosters = {
        1: [pick(1, 1, points={"vegas": 300.0, "espn": 100.0, "sleeper": 100.0})],
        2: [pick(2, 2, points={"vegas": 100.0, "espn": 300.0, "sleeper": 100.0})],
        3: [pick(3, 3, points={"vegas": 100.0, "espn": 100.0, "sleeper": 300.0})],
    }
    awards = run(rosters)
    assert awards["vegas_favourite"]["winner"]["team"] == "Alpha"
    assert awards["espn_favourite"]["winner"]["team"] == "Bravo"
    assert awards["sleeper_favourite"]["winner"]["team"] == "Charlie"


def test_the_biggest_reach_and_the_steal_are_opposite_ends_of_one_scale():
    rosters = {
        1: [pick(1, 1, name="Reached For", sigma=-3.0)],
        2: [pick(2, 2, name="Fell Far", sigma=4.0)],
        3: [pick(3, 3)],
    }
    awards = run(rosters)
    assert awards["biggest_reach"]["winner"]["player"] == "Reached For"
    assert awards["steal_of_the_draft"]["winner"]["player"] == "Fell Far"


def test_a_pick_the_adp_board_never_listed_cannot_win_a_reach_award():
    # Padding an unlisted player to one past the last pick is fine for a team
    # total, but it is not evidence about a single selection.
    rosters = {
        1: [pick(1, 1, name="Unlisted", sigma=-9.0, ranked=False)],
        2: [pick(2, 2, name="Real Reach", sigma=-2.0)],
        3: [pick(3, 3)],
    }
    assert run(rosters)["biggest_reach"]["winner"]["player"] == "Real Reach"


def test_reading_the_sheet_and_going_your_own_way_are_mirror_awards():
    rosters = {
        1: [pick(1, 1, sigma=0.05), pick(1, 4, sigma=-0.05)],
        2: [pick(2, 2, sigma=3.0), pick(2, 5, sigma=-3.0)],
        3: [pick(3, 3, sigma=1.0), pick(3, 6, sigma=-1.0)],
    }
    awards = run(rosters)
    assert awards["most_adp_obedient"]["winner"]["team"] == "Alpha"
    assert awards["most_contrarian"]["winner"]["team"] == "Bravo"


def test_keepers_are_left_out_of_how_closely_a_manager_read_the_board():
    rosters = {
        1: [pick(1, 1, sigma=0.1), pick(1, 4, sigma=9.0, keeper=True)],
        2: [pick(2, 2, sigma=1.0)],
        3: [pick(3, 3, sigma=2.0)],
    }
    assert run(rosters)["most_adp_obedient"]["winner"]["team"] == "Alpha"


def test_the_homer_award_counts_the_biggest_single_team_stack():
    rosters = {
        1: [pick(1, n, pro_team="DET") for n in (1, 4, 7)],
        2: [pick(2, 2, pro_team="KC"), pick(2, 5, pro_team="SF")],
        3: [pick(3, 3, pro_team="BUF")],
    }
    assert run(rosters)["homer"]["winner"]["team"] == "Alpha"
    assert run(rosters)["homer"]["winner"]["value"] == 3


def test_handcuff_hoarding_counts_pairs_not_players():
    rosters = {
        1: [pick(1, 1, "RB", pro_team="DET"), pick(1, 4, "RB", pro_team="DET")],
        2: [pick(2, 2, "WR", pro_team="KC"), pick(2, 5, "WR", pro_team="KC")],
        3: [pick(3, 3, "RB", pro_team="BUF")],
    }
    award = run(rosters)["handcuff_hoarder"]
    assert award["winner"]["team"] == "Alpha"
    assert award["winner"]["value"] == 1  # two backs is one handcuff


def test_missing_ages_are_left_out_of_the_mean_rather_than_read_as_zero():
    rosters = {
        1: [pick(1, 1, age=30), pick(1, 4, age=None)],
        2: [pick(2, 2, age=24)],
        3: [pick(3, 3, age=26)],
    }
    awards = run(rosters)
    assert awards["oldest_roster"]["winner"]["team"] == "Alpha"
    assert awards["oldest_roster"]["winner"]["value"] == 30.0
    assert awards["youngest_roster"]["winner"]["team"] == "Bravo"


def test_a_roster_with_no_ages_at_all_simply_does_not_place():
    rosters = {
        1: [pick(1, 1, age=None)],
        2: [pick(2, 2, age=24)],
        3: [pick(3, 3, age=26)],
    }
    standings = run(rosters)["youngest_roster"]["standings"]
    assert 1 not in [row["espn_team_id"] for row in standings]


def test_the_superflex_denier_award_names_teams_that_never_took_a_second_qb():
    rosters = {
        1: [pick(1, 1, "QB"), pick(1, 4, "QB")],
        2: [pick(2, 2, "QB"), pick(2, 20, "QB")],
        3: [pick(3, 3, "QB")],
    }
    award = run(rosters)["superflex_denier"]
    assert award["winner"]["team"] == "Bravo"  # waited until pick 20
    assert "never took a second QB" in award["note"]
    assert [row["team"] for row in award["unrankable"]] == ["Charlie"]


def test_the_superflex_award_does_not_appear_in_a_one_quarterback_league():
    rosters = {1: [pick(1, 1, "QB")], 2: [pick(2, 2, "QB")], 3: [pick(3, 3, "QB")]}
    single_qb = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"]
    starters = {t: [starter(r) for r in roster] for t, roster in rosters.items()}
    flat = sorted(
        (r for roster in rosters.values() for r in roster),
        key=lambda r: r["overall_pick"],
    )
    keys = {a["key"] for a in fld._accolades(rosters, starters, TEAMS, flat, single_qb)}
    assert "superflex_denier" not in keys


def test_the_kicker_award_goes_to_the_earliest_pick_not_the_latest():
    rosters = {
        1: [pick(1, 40, "K")],
        2: [pick(2, 20, "DEF")],
        3: [pick(3, 60, "K")],
    }
    assert run(rosters)["kicker_enthusiast"]["winner"]["team"] == "Bravo"


def test_bye_chaos_counts_starters_sharing_one_week():
    rosters = {
        1: [pick(1, n, bye=6) for n in (1, 4, 7)],
        2: [pick(2, 2, bye=6), pick(2, 5, bye=9)],
        3: [pick(3, 3, bye=11)],
    }
    award = run(rosters)["bye_chaos"]
    assert award["winner"]["team"] == "Alpha"
    assert award["winner"]["value"] == 3


def test_ties_still_produce_a_deterministic_winner_and_name_the_other_team():
    rosters = {
        1: [pick(1, 1, years_exp=0)],
        2: [pick(2, 2, years_exp=0)],
        3: [pick(3, 3)],
    }
    award = run(rosters)["rookie_fever"]
    assert {award["winner"]["team"], award["runner_up"]["team"]} == {"Alpha", "Bravo"}
    assert award["winner"]["value"] == award["runner_up"]["value"] == 1


# ── callouts ────────────────────────────────────────────────────────────


def test_a_positional_run_is_reported_once_not_once_per_window():
    picks = [pick(1, n, "QB") for n in range(1, 6)] + [pick(2, n, "RB") for n in range(6, 12)]
    runs = fld._callouts(picks, TEAMS, SLOTS)["positional_runs"]
    quarterback_runs = [row for row in runs if row["position"] == "QB"]
    assert len(quarterback_runs) == 1


def test_a_quiet_board_reports_no_runs():
    picks = [
        pick(1, 1, "QB"),
        pick(2, 2, "RB"),
        pick(3, 3, "WR"),
        pick(1, 4, "TE"),
        pick(2, 5, "K"),
    ]
    assert fld._callouts(picks, TEAMS, SLOTS)["positional_runs"] == []


def test_the_first_quarterback_off_the_board_is_named():
    picks = [pick(1, 1, "RB"), pick(2, 2, "QB", name="First QB"), pick(3, 3, "QB")]
    callouts = fld._callouts(picks, TEAMS, SLOTS)
    assert callouts["first_qb"]["player"] == "First QB"
    assert callouts["first_qb"]["overall_pick"] == 2
    assert callouts["qb_count"] == 2


def test_a_draft_with_no_quarterbacks_says_so_rather_than_crashing():
    callouts = fld._callouts([pick(1, 1, "RB")], TEAMS, SLOTS)
    assert callouts["first_qb"] is None
    assert callouts["qb_count"] == 0
