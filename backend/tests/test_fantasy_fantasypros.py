import pytest

from app.services.fantasy_fantasypros import FantasyProsError, parse_projection_rows


def test_parse_projection_rows_normalizes_points_and_positions():
    payload = {
        "players": [
            {
                "fpid": 123,
                "name": "Justin Jefferson",
                "position_id": "WR",
                "team_id": "MIN",
                "stats": {"points": 16, "points_half": 18.5, "points_ppr": 21},
            },
            {
                "name": "Minnesota Vikings",
                "position_id": "DST",
                "team_id": "MIN",
                "stats": {"points": "8.2"},
            },
            {
                "name": "Patrick Mahomes",
                "position_id": "QB",
                "team_id": "KC",
                "stats": {"points": 24.4},
            },
        ]
    }

    rows = parse_projection_rows(payload)

    assert rows[0]["pts_ppr"] == 21.0
    assert rows[0]["pts_half_ppr"] == 18.5
    assert rows[0]["pts_std"] == 16.0
    assert rows[1]["position"] == "DEF"
    assert rows[1]["pts_ppr"] == 8.2
    assert rows[1]["pts_half_ppr"] == 8.2
    assert rows[2]["pts_ppr"] == 24.4
    assert rows[2]["pts_half_ppr"] == 24.4


def test_parse_projection_rows_rejects_invalid_shape_and_drops_bad_rows():
    with pytest.raises(FantasyProsError):
        parse_projection_rows([])
    with pytest.raises(FantasyProsError):
        parse_projection_rows({})
    assert parse_projection_rows({"players": [{"name": "Missing stats"}, "bad"]}) == []
