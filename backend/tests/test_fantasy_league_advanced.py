from app.services.fantasy_league_advanced import ledger_rows, median_records
from app.services.fantasy_league_rankings import build_team_metrics


def _metrics():
    teams = [
        {"espn_team_id": team_id, "name": f"Team {team_id}"}
        for team_id in range(1, 5)
    ]
    matchups = [
        {
            "matchup_period": 1,
            "playoff_tier": "NONE",
            "home_team_id": 1,
            "home_points": 130.0,
            "away_team_id": 2,
            "away_points": 110.0,
            "is_bye": False,
            "is_complete": True,
        },
        {
            "matchup_period": 1,
            "playoff_tier": "NONE",
            "home_team_id": 3,
            "home_points": 100.0,
            "away_team_id": 4,
            "away_points": 90.0,
            "is_bye": False,
            "is_complete": True,
        },
    ]
    return build_team_metrics(teams, matchups)


def test_median_record_adds_one_top_half_result_to_scheduled_result():
    records = median_records(_metrics())

    assert records[1] == {"wins": 2, "losses": 0, "ties": 0, "games": 2, "win_pct": 1.0}
    assert records[2] == {"wins": 1, "losses": 1, "ties": 0, "games": 2, "win_pct": 0.5}
    assert records[3] == {"wins": 1, "losses": 1, "ties": 0, "games": 2, "win_pct": 0.5}
    assert records[4] == {"wins": 0, "losses": 2, "ties": 0, "games": 2, "win_pct": 0.0}


def test_median_record_is_included_in_ledger_rows():
    rows = ledger_rows(_metrics(), [], playoff_team_count=2, simulations=10)

    assert rows[1]["median_record"]["wins"] == 2
    assert rows[4]["median_record"]["losses"] == 2


def test_exact_median_score_adds_a_tie():
    metrics = _metrics()
    metrics[2].weekly[0] = (1, 100.0)
    metrics[3].weekly[0] = (1, 100.0)

    records = median_records(metrics)

    assert records[2] == {"wins": 0, "losses": 1, "ties": 1, "games": 2, "win_pct": 0.25}
    assert records[3] == {"wins": 1, "losses": 0, "ties": 1, "games": 2, "win_pct": 0.75}
