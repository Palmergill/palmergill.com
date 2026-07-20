import pytest

from app.services.fantasy_espn import EspnProjectionError, parse_projection_payload


def test_parse_projection_payload_selects_requested_projection_stat():
    payload = {
        "players": [
            {
                "player": {
                    "id": 3139477,
                    "fullName": "Patrick Mahomes",
                    "defaultPositionId": 1,
                    "stats": [
                        {
                            "seasonId": 2026,
                            "scoringPeriodId": 3,
                            "statSourceId": 1,
                            "statSplitTypeId": 1,
                            "appliedTotal": 24.75,
                        },
                        {
                            "seasonId": 2026,
                            "scoringPeriodId": 3,
                            "statSourceId": 0,
                            "statSplitTypeId": 1,
                            "appliedTotal": 30,
                        },
                    ],
                }
            }
        ]
    }

    rows = parse_projection_payload(payload, 2026, 3)

    assert rows["3139477"] == {
        "name": "Patrick Mahomes",
        "position": "QB",
        "points": 24.75,
    }


def test_parse_projection_payload_rejects_invalid_shape():
    with pytest.raises(EspnProjectionError):
        parse_projection_payload({}, 2026, 0)
