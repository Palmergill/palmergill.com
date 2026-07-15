"""nflverse CSV parsing tests (the piece the collector fakes bypass)."""
from app.services.fantasy_nflverse import parse_games_csv, parse_weekly_stats_csv

GAMES_CSV = """game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_score,home_score
2025_01_BUF_NYJ,2025,REG,1,2025-09-07,13:00,BUF,NYJ,20,17
2024_01_KC_BAL,2024,REG,1,2024-09-05,20:20,KC,BAL,27,20
"""

WEEKLY_CSV = """player_id,player_name,position,recent_team,season,week,opponent_team,receptions,receiving_yards,receiving_tds,fantasy_points,fantasy_points_ppr
00-0036322,J.Jefferson,WR,MIN,2025,1,GB,10,150,1,20.0,30.0
,No.Id,WR,MIN,2025,1,GB,1,10,0,1.0,2.0
"""


def test_parse_games_csv_filters_season_and_parses_kickoff():
    games = parse_games_csv(GAMES_CSV, season=2025)
    assert len(games) == 1
    game = games[0]
    assert game["game_id"] == "2025_01_BUF_NYJ"
    assert game["home_team"] == "NYJ"
    assert game["home_score"] == 17
    assert game["kickoff"] is not None
    assert game["kickoff"].year == 2025 and game["kickoff"].hour == 13


def test_parse_weekly_stats_derives_half_ppr_and_skips_idless_rows():
    rows = parse_weekly_stats_csv(WEEKLY_CSV)
    assert len(rows) == 1  # the row without a player_id is dropped
    row = rows[0]
    assert row["gsis_id"] == "00-0036322"
    assert row["fantasy_points_std"] == 20.0
    # half-ppr = std + 0.5 * receptions = 20 + 5 = 25
    assert row["fantasy_points_half"] == 25.0
    assert row["stats"]["receptions"] == 10.0
