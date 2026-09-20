"""The season list, and the champion it carries.

A year in this league's history is worth a row because of who won it. The
derivation is deliberately narrow — the last decided WINNERS_BRACKET game —
and the assertions below are mostly about when it declines to answer, since
a list that promoted a semi-final winner to champion would be worse than one
that said nothing.
"""
import pytest

from app.database import (
    FantasyLeagueMatchup,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    SessionLocal,
)
from app.services import fantasy_league_data as D
from app.services.fantasy_league_espn import configured_league_id

MODELS = (FantasyLeagueMatchup, FantasyLeagueTeam, FantasyLeagueSeason)


@pytest.fixture
def db():
    session = SessionLocal()
    for model in MODELS:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    for model in MODELS:
        session.query(model).delete()
    session.commit()
    session.close()


def add_season(db, season, status="ok", size=4):
    db.add(
        FantasyLeagueSeason(
            espn_league_id=configured_league_id(),
            season=season,
            name="Sunday Money",
            size=size,
            status=status,
        )
    )


def add_teams(db, season):
    for team_id, name in ((1, "Alpha"), (2, "Bravo"), (3, "Charlie"), (4, "Delta")):
        db.add(
            FantasyLeagueTeam(
                season=season,
                espn_team_id=team_id,
                name=name,
                owner_name=f"Owner {team_id}",
                wins=team_id,
                losses=4 - team_id,
                ties=0,
                points_for=100.0 * team_id,
            )
        )


def add_matchup(db, season, period, home, away, winner, tier="WINNERS_BRACKET",
                complete=True, home_points=110.0, away_points=100.0):
    db.add(
        FantasyLeagueMatchup(
            season=season,
            espn_matchup_id=period * 100 + home,
            matchup_period=period,
            playoff_tier=tier,
            winner=winner,
            home_team_id=home,
            home_points=home_points,
            away_team_id=away,
            away_points=away_points,
            is_complete=complete,
        )
    )


def seasons_by_year(db):
    return {entry["season"]: entry for entry in D.list_seasons(db)["seasons"]}


def test_the_champion_is_the_last_decided_bracket_game(db):
    add_season(db, 2024)
    add_teams(db, 2024)
    # A semi-final in period 15 and the final in 16. The later game wins.
    add_matchup(db, 2024, 15, home=1, away=4, winner="HOME")
    add_matchup(db, 2024, 16, home=2, away=1, winner="AWAY", home_points=98.0,
                away_points=121.5)
    db.commit()

    champion = seasons_by_year(db)[2024]["champion"]
    assert champion["espn_team_id"] == 1
    assert champion["name"] == "Alpha"
    assert champion["runner_up"] == "Bravo"
    # The score reads winner-first whichever side of the matchup won.
    assert champion["final_score"] == {"winner": 121.5, "runner_up": 98.0}


def test_the_winner_side_is_read_correctly_when_home_wins(db):
    add_season(db, 2023)
    add_teams(db, 2023)
    add_matchup(db, 2023, 16, home=3, away=2, winner="HOME", home_points=140.0,
                away_points=131.0)
    db.commit()

    champion = seasons_by_year(db)[2023]["champion"]
    assert champion["name"] == "Charlie"
    assert champion["runner_up"] == "Bravo"
    assert champion["final_score"] == {"winner": 140.0, "runner_up": 131.0}


def test_the_champion_carries_the_record_the_row_prints(db):
    add_season(db, 2022)
    add_teams(db, 2022)
    add_matchup(db, 2022, 16, home=4, away=1, winner="HOME")
    db.commit()

    champion = seasons_by_year(db)[2022]["champion"]
    assert (champion["wins"], champion["losses"], champion["ties"]) == (4, 0, 0)
    assert champion["points_for"] == 400.0
    assert champion["owner_name"] == "Owner 4"


def test_a_season_still_being_played_has_no_champion(db):
    add_season(db, 2026)
    add_teams(db, 2026)
    add_matchup(db, 2026, 16, home=1, away=2, winner="UNDECIDED", complete=False)
    db.commit()

    assert seasons_by_year(db)[2026]["champion"] is None


def test_a_regular_season_game_never_stands_in_for_a_final(db):
    add_season(db, 2021)
    add_teams(db, 2021)
    # Week 14 is the highest period, but it is not a bracket game.
    add_matchup(db, 2021, 14, home=1, away=2, winner="HOME", tier="NONE")
    db.commit()

    assert seasons_by_year(db)[2021]["champion"] is None


def test_a_losers_bracket_game_is_not_the_final(db):
    add_season(db, 2020)
    add_teams(db, 2020)
    add_matchup(db, 2020, 16, home=1, away=2, winner="HOME", tier="LOSERS_CONSOLATION_LADDER")
    db.commit()

    assert seasons_by_year(db)[2020]["champion"] is None


def test_a_tied_final_declines_to_name_a_champion(db):
    add_season(db, 2019)
    add_teams(db, 2019)
    add_matchup(db, 2019, 16, home=1, away=2, winner="TIE")
    db.commit()

    assert seasons_by_year(db)[2019]["champion"] is None


def test_a_private_season_is_listed_without_being_read(db):
    add_season(db, 2018, status="unauthorized")
    add_teams(db, 2018)
    add_matchup(db, 2018, 16, home=1, away=2, winner="HOME")
    db.commit()

    entry = seasons_by_year(db)[2018]
    assert entry["available"] is False
    assert entry["status"] == "unauthorized"
    # The gap is labelled, not silently filled in from rows we should not read.
    assert entry["champion"] is None


def test_every_season_carries_the_key_whether_or_not_it_has_a_champion(db):
    add_season(db, 2024)
    add_season(db, 2026)
    add_teams(db, 2024)
    add_matchup(db, 2024, 16, home=1, away=2, winner="HOME")
    db.commit()

    seasons = D.list_seasons(db)["seasons"]
    assert [entry["season"] for entry in seasons] == [2026, 2024]
    assert all("champion" in entry for entry in seasons)
