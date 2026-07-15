"""The Odds API parser tests (network-free)."""
from app.services.fantasy_common import team_abbr
from app.services.fantasy_odds import parse_event_props, parse_futures, parse_game_odds

GAME_ODDS = [
    {
        "id": "evt1",
        "home_team": "Buffalo Bills",
        "away_team": "New York Jets",
        "commence_time": "2026-09-13T17:00:00Z",
        "bookmakers": [
            {
                "key": "draftkings",
                "markets": [
                    {"key": "h2h", "outcomes": [
                        {"name": "Buffalo Bills", "price": -160},
                        {"name": "New York Jets", "price": 140},
                    ]},
                    {"key": "spreads", "outcomes": [
                        {"name": "Buffalo Bills", "price": -110, "point": -3.5},
                        {"name": "New York Jets", "price": -110, "point": 3.5},
                    ]},
                    {"key": "totals", "outcomes": [
                        {"name": "Over", "price": -110, "point": 45.5},
                        {"name": "Under", "price": -110, "point": 45.5},
                    ]},
                ],
            }
        ],
    }
]


def test_team_abbr_maps_full_names_and_passes_through_unknown():
    assert team_abbr("Buffalo Bills") == "BUF"
    assert team_abbr("san francisco 49ers") == "SF"
    assert team_abbr("Over") == "Over"  # unknown passes through
    assert team_abbr(None) is None


def test_parse_game_odds_flattens_and_maps_teams():
    rows = parse_game_odds(GAME_ODDS)
    # 2 h2h + 2 spreads + 2 totals = 6 rows.
    assert len(rows) == 6
    spread_home = next(r for r in rows if r["market"] == "spreads" and r["outcome"] == "BUF")
    assert spread_home["point"] == -3.5
    assert spread_home["home_team"] == "BUF"
    assert spread_home["away_team"] == "NYJ"
    assert spread_home["commence_time"] is not None
    total = next(r for r in rows if r["market"] == "totals" and r["outcome"] == "Over")
    assert total["point"] == 45.5


def test_parse_event_props_uses_description_as_player_and_skips_nameless():
    event = {
        "id": "evt1",
        "bookmakers": [
            {
                "key": "draftkings",
                "markets": [
                    {"key": "player_pass_yds", "outcomes": [
                        {"name": "Over", "description": "Josh Allen", "price": -115, "point": 274.5},
                        {"name": "Under", "description": "Josh Allen", "price": -105, "point": 274.5},
                        {"name": "Over", "price": -110, "point": 1},  # no description -> dropped
                    ]},
                ],
            }
        ],
    }
    rows = parse_event_props(event)
    assert len(rows) == 2
    assert rows[0]["player_name_raw"] == "Josh Allen"
    assert rows[0]["market"] == "player_pass_yds"
    assert rows[0]["outcome"] == "Over"
    assert rows[0]["point"] == 274.5


def test_parse_futures_flattens_outrights():
    events = [
        {
            "bookmakers": [
                {"key": "dk", "markets": [
                    {"key": "outrights", "outcomes": [
                        {"name": "Buffalo Bills", "price": 650},
                        {"name": "Kansas City Chiefs", "price": 500},
                    ]},
                ]},
            ]
        }
    ]
    rows = parse_futures(events)
    assert {r["outcome"] for r in rows} == {"Buffalo Bills", "Kansas City Chiefs"}
    assert next(r for r in rows if r["outcome"] == "Buffalo Bills")["price"] == 650
