"""End-to-end draft recap: seeded database through to the JSON the page reads.

The unit tests cover the maths; this covers the assembly — the joins, the
season resolution, and the shape the frontend depends on.
"""
import pytest

from app.database import (
    FantasyAdpSnapshot,
    FantasyCollectionRun,
    FantasyLeagueDraftPick,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyPlayer,
    FantasyProjection,
    SessionLocal,
    utc_now,
)
from app.services import fantasy_league_draft as fld

SEASON = 2026
LEAGUE_ID = "225965"
# The league's real 2026 slot counts: QB, 2RB, 2WR, TE, OP, 2FLEX, K, DST,
# 7 bench, 1 IR.
SLOT_COUNTS = (
    '{"0": 1, "2": 2, "4": 2, "6": 1, "7": 1, "16": 1, '
    '"17": 1, "20": 7, "21": 1, "23": 2}'
)

MODELS = (
    FantasyAdpSnapshot,
    FantasyLeagueDraftPick,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyProjection,
    FantasyCollectionRun,
    FantasyPlayer,
)

TEAM_COUNT = 4
ROUNDS = 6
POSITION_CYCLE = ["QB", "RB", "WR", "TE", "RB", "WR"]


@pytest.fixture
def db():
    session = SessionLocal()
    for model in MODELS:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    session.close()


def seed(db, *, with_adp=True):
    db.add(
        FantasyLeagueSeason(
            espn_league_id=LEAGUE_ID,
            season=SEASON,
            name="The League",
            size=TEAM_COUNT,
            lineup_slot_counts_json=SLOT_COUNTS,
            status="ok",
        )
    )
    for team_id in range(1, TEAM_COUNT + 1):
        db.add(
            FantasyLeagueTeam(
                season=SEASON,
                espn_team_id=team_id,
                name=f"Team {team_id}",
                owner_name=f"Owner {team_id}",
            )
        )

    run = FantasyCollectionRun(
        job="projections",
        source="sleeper",
        season=SEASON,
        week=0,
        status="success",
        started_at=utc_now(),
        finished_at=utc_now(),
        rows_written=1,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    total = TEAM_COUNT * ROUNDS
    for index in range(total):
        overall = index + 1
        position = POSITION_CYCLE[index % len(POSITION_CYCLE)]
        player_id = f"p{overall}"
        db.add(
            FantasyPlayer(
                player_id=player_id,
                full_name=f"Player {overall}",
                search_name=f"player {overall}",
                position=position,
                team="DET" if overall % 2 else "KC",
                age=24 + (overall % 8),
                years_exp=overall % 4,
            )
        )
        db.add(
            FantasyProjection(
                run_id=run.id,
                season=SEASON,
                week=0,
                source="sleeper",
                player_id=player_id,
                pts_ppr=300.0 - overall * 5,
                pts_half_ppr=290.0 - overall * 5,
                pts_std=280.0 - overall * 5,
            )
        )
        if with_adp:
            db.add(
                FantasyAdpSnapshot(
                    run_id=1,
                    season=SEASON,
                    format="2qb",
                    teams=TEAM_COUNT,
                    rounds=ROUNDS,
                    player_id=player_id,
                    player_name_raw=f"Player {overall}",
                    position=position,
                    team="DET",
                    # Every player's ADP is his pick, except one deliberate
                    # reach and one deliberate steal.
                    adp=float(overall) + (8.0 if overall == 5 else 0.0) - (
                        6.0 if overall == 9 else 0.0
                    ),
                    adp_stdev=2.0,
                    times_drafted=500,
                    total_drafts=7208,
                    source_start_date="2026-08-06",
                    source_end_date="2026-09-05",
                )
            )

        # Snake order, which is what makes slot-adjusted value meaningful.
        round_index = index // TEAM_COUNT
        seat = index % TEAM_COUNT
        team_id = (seat if round_index % 2 == 0 else TEAM_COUNT - 1 - seat) + 1
        db.add(
            FantasyLeagueDraftPick(
                espn_league_id=LEAGUE_ID,
                season=SEASON,
                overall_pick=overall,
                round_id=round_index + 1,
                round_pick=seat + 1,
                espn_team_id=team_id,
                espn_player_id=1000 + overall,
                player_id=player_id,
                player_name_raw=f"Player {overall}",
                position=position,
                pro_team="DET" if overall % 2 else "KC",
                keeper=False,
                auto_draft_type_id=1 if overall == 12 else 0,
            )
        )
    db.commit()


def test_a_league_with_no_picks_reports_status_without_pretending_to_grade(db):
    seed(db)
    db.query(FantasyLeagueDraftPick).delete()
    db.commit()

    recap = fld.get_draft_recap(db, SEASON)
    assert recap["picks"] == []
    assert recap["grades"] == []
    assert recap["accolades"] == []
    # The method block still renders, so the page can explain itself before
    # there is anything to explain.
    assert recap["method"]["weights"] == fld.GRADE_WEIGHTS


def test_the_recap_grades_every_team_that_drafted(db):
    seed(db)
    recap = fld.get_draft_recap(db, SEASON)
    assert len(recap["grades"]) == TEAM_COUNT
    assert {row["espn_team_id"] for row in recap["grades"]} == {1, 2, 3, 4}
    assert all(row["grade"] for row in recap["grades"])


def test_grades_are_ordered_best_first(db):
    seed(db)
    composites = [row["composite"] for row in fld.get_draft_recap(db, SEASON)["grades"]]
    assert composites == sorted(composites, reverse=True)


def test_every_component_is_reported_with_its_weight_so_the_letter_is_auditable(db):
    seed(db)
    components = fld.get_draft_recap(db, SEASON)["grades"][0]["components"]
    assert set(components) == set(fld.GRADE_WEIGHTS)
    for key, component in components.items():
        assert component["weight"] == fld.GRADE_WEIGHTS[key]
        assert component["raw"] is not None
        assert component["z"] is not None


def test_the_deliberate_reach_and_steal_win_their_awards(db):
    seed(db)
    awards = {a["key"]: a for a in fld.get_draft_recap(db, SEASON)["accolades"]}
    # Pick 5's ADP is 13, so taking him at 5 is a reach of eight picks.
    # Pick 9's ADP is 3, so he lasted six picks past it: a steal.
    assert awards["biggest_reach"]["winner"]["overall_pick"] == 5
    assert awards["steal_of_the_draft"]["winner"]["overall_pick"] == 9


def test_the_adp_board_describes_the_sample_it_came_from(db):
    seed(db)
    source = fld.get_draft_recap(db, SEASON)["adp_source"]
    assert source["format"] == "2qb"
    assert source["total_drafts"] == 7208
    assert source["start_date"] == "2026-08-06"


def test_a_draft_with_no_adp_collected_still_grades_on_everything_else(db):
    # The ADP job could be deployed after a draft. Losing one sub-score must
    # not take the page down with it.
    seed(db, with_adp=False)
    recap = fld.get_draft_recap(db, SEASON)
    assert recap["adp_source"] is None
    assert len(recap["grades"]) == TEAM_COUNT
    assert all(row["unranked_picks"] == ROUNDS for row in recap["grades"])
    assert all(row["components"]["adp_value"]["raw"] == 0 for row in recap["grades"])
    assert all(pick["adp_sigma"] is None for pick in recap["picks"])


def test_replacement_levels_are_published_so_vor_can_be_checked(db):
    seed(db)
    levels = fld.get_draft_recap(db, SEASON)["method"]["replacement_points"]
    assert "QB" in levels
    assert fld.get_draft_recap(db, SEASON)["method"]["starting_slots"].count("FLEX") == 2


def test_the_superflex_seat_is_read_off_the_leagues_own_settings(db):
    seed(db)
    assert "OP" in fld.get_draft_recap(db, SEASON)["method"]["starting_slots"]


def test_the_autopicked_manager_is_called_out(db):
    seed(db)
    awards = {a["key"]: a for a in fld.get_draft_recap(db, SEASON)["accolades"]}
    assert awards["autopick"]["winner"]["value"] == 1


def test_the_superflex_board_is_not_overwritten_by_the_half_ppr_one(db):
    # One collector run writes every format under a single run id. Filtering
    # on the run alone pulled both boards and let half-PPR overwrite superflex
    # player for player, which quietly mis-graded every quarterback.
    seed(db)
    for row in db.query(FantasyAdpSnapshot).all():
        db.add(
            FantasyAdpSnapshot(
                run_id=row.run_id,
                season=row.season,
                format="half_ppr",
                teams=row.teams,
                player_id=row.player_id,
                player_name_raw=row.player_name_raw,
                position=row.position,
                # Deliberately nothing like the superflex value.
                adp=row.adp + 100.0,
                adp_stdev=row.adp_stdev,
            )
        )
    db.commit()

    recap = fld.get_draft_recap(db, SEASON)
    assert recap["adp_source"]["format"] == "2qb"
    first = next(row for row in recap["picks"] if row["overall_pick"] == 1)
    assert first["adp"] == 1.0
