"""ESPN league parser tests.

Every case is network-free and runs against fixtures that mirror the real
payload shapes (captured from league 225965, seasons 2024 and 2026).
"""
import json

import pytest

from app.services.fantasy_common import NFL_TEAM_ABBR
from app.services.fantasy_league_espn import (
    ESPN_LINEUP_SLOTS,
    ESPN_PRO_TEAM_ABBR,
    EspnLeagueError,
    configured_seasons,
    espn_player_key,
    parse_members,
    parse_roster_entries,
    parse_schedule,
    parse_settings,
    parse_teams,
)

# ESPN's real lineupSlotCounts for this league (2026).
LINEUP_SLOT_COUNTS = {
    "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 2
}

LEAGUE_PAYLOAD = {
    "scoringPeriodId": 0,
    "status": {"currentMatchupPeriod": 1, "firstScoringPeriod": 1},
    "settings": {
        "name": "The League",
        "size": 10,
        "scheduleSettings": {
            "matchupPeriodCount": 14,
            "playoffTeamCount": 6,
            "divisions": [{"id": 0, "name": "East"}, {"id": 1, "name": "West"}],
        },
        "rosterSettings": {"lineupSlotCounts": LINEUP_SLOT_COUNTS},
    },
    "members": [
        {
            "id": "{GUID-A}",
            "displayName": "Palmer Gill",
            "firstName": "Palmer",
            "lastName": "Gill",
        },
        {
            "id": "{GUID-B}",
            "displayName": "151jamesp",
            "firstName": "Parker",
            "lastName": "S",
        },
    ],
    "teams": [
        {
            "id": 1,
            "name": "4th and 20",
            "abbrev": "Palm",
            "logo": "https://example.invalid/helmet.svg",
            "divisionId": 1,
            "owners": ["{GUID-A}"],
            "playoffSeed": 3,
            "currentProjectedRank": 4,
            "record": {
                "overall": {
                    "wins": 6,
                    "losses": 8,
                    "ties": 0,
                    "pointsFor": 1538.78,
                    "pointsAgainst": 1519.3,
                    "percentage": 0.4285,
                    "streakLength": 1,
                    "streakType": "LOSS",
                    "gamesBack": 4.0,
                }
            },
            "roster": {
                "entries": [
                    {
                        "playerId": 4374302,
                        "lineupSlotId": 4,
                        "acquisitionType": "DRAFT",
                        "injuryStatus": "ACTIVE",
                        "playerPoolEntry": {
                            "player": {
                                "id": 4374302,
                                "fullName": "Amon-Ra St. Brown",
                                "defaultPositionId": 3,
                                "proTeamId": 8,
                            }
                        },
                    },
                    {
                        "playerId": -16007,
                        "lineupSlotId": 16,
                        "acquisitionType": "DRAFT",
                        "playerPoolEntry": {
                            "player": {
                                "id": -16007,
                                "fullName": "Broncos D/ST",
                                "defaultPositionId": 16,
                                "proTeamId": 7,
                            }
                        },
                    },
                    {
                        "playerId": 999001,
                        "lineupSlotId": 20,
                        "playerPoolEntry": {
                            "player": {
                                "id": 999001,
                                "fullName": "Washington Defender",
                                "defaultPositionId": 2,
                                "proTeamId": 28,
                            }
                        },
                    },
                ]
            },
        },
        {
            # Owner GUID that has no matching member row.
            "id": 2,
            "name": "Orphan Squad",
            "abbrev": "ORP",
            "divisionId": 0,
            "owners": ["{GUID-MISSING}"],
            "record": {"overall": {"wins": 0, "losses": 0, "ties": 0}},
        },
    ],
}

SCHEDULE_PAYLOAD = {
    "schedule": [
        {
            "id": 1,
            "matchupPeriodId": 1,
            "winner": "AWAY",
            "playoffTierType": "NONE",
            "home": {
                "teamId": 9,
                "totalPoints": 115.38,
                "pointsByScoringPeriod": {"1": 115.38},
            },
            "away": {
                "teamId": 7,
                "totalPoints": 125.28,
                "pointsByScoringPeriod": {"1": 125.28},
            },
        },
        {
            # A real bye: no away side at all.
            "id": 85,
            "matchupPeriodId": 15,
            "winner": "UNDECIDED",
            "playoffTierType": "WINNERS_BRACKET",
            "home": {
                "teamId": 16,
                "totalPoints": 0.0,
                "pointsByScoringPeriod": {"15": 0.0},
            },
        },
    ]
}


def test_parse_settings_reads_league_shape():
    settings = parse_settings(LEAGUE_PAYLOAD, 2026)
    assert settings["name"] == "The League"
    assert settings["size"] == 10
    assert settings["current_scoring_period"] == 0
    assert settings["current_matchup_period"] == 1
    assert settings["playoff_team_count"] == 6
    assert json.loads(settings["lineup_slot_counts_json"]) == LINEUP_SLOT_COUNTS


def test_parse_members_returns_guid_keyed_names():
    members = parse_members(LEAGUE_PAYLOAD)
    assert {m["member_guid"] for m in members} == {"{GUID-A}", "{GUID-B}"}
    assert members[0]["display_name"] == "Palmer Gill"


def test_parse_teams_joins_owner_guid_to_member_name():
    members_by_guid = {m["member_guid"]: m["display_name"] for m in parse_members(LEAGUE_PAYLOAD)}
    teams = parse_teams(LEAGUE_PAYLOAD, members_by_guid)
    first = teams[0]
    assert first["espn_team_id"] == 1
    assert first["owner_name"] == "Palmer Gill"
    assert first["division_name"] == "West"
    assert first["wins"] == 6 and first["losses"] == 8
    assert first["points_for"] == pytest.approx(1538.78)
    assert first["streak_type"] == "LOSS"


def test_parse_teams_tolerates_unmatched_owner_guid():
    """A GUID with no member row must not fail the parse for everyone else."""
    teams = parse_teams(LEAGUE_PAYLOAD, {"{GUID-A}": "Palmer Gill"})
    orphan = next(team for team in teams if team["espn_team_id"] == 2)
    assert orphan["owner_guid"] == "{GUID-MISSING}"
    assert orphan["owner_name"] is None


def test_parse_teams_without_members_still_parses():
    teams = parse_teams(LEAGUE_PAYLOAD)
    assert len(teams) == 2
    assert all(team["owner_name"] is None for team in teams)


def test_parse_schedule_flags_bye_and_completion():
    rows = parse_schedule(SCHEDULE_PAYLOAD)
    game, bye = rows[0], rows[1]

    assert game["is_bye"] is False
    assert game["is_complete"] is True
    assert game["home_team_id"] == 9 and game["away_team_id"] == 7
    assert game["home_points"] == pytest.approx(115.38)
    assert game["scoring_period"] == 1
    assert game["playoff_tier"] == "NONE"

    assert bye["is_bye"] is True
    assert bye["away_team_id"] is None
    assert bye["away_points"] is None
    assert bye["is_complete"] is False
    assert bye["playoff_tier"] == "WINNERS_BRACKET"


def test_parse_roster_entries_resolves_slots_and_positions():
    entries = parse_roster_entries(LEAGUE_PAYLOAD)
    by_name = {entry["player_name_raw"]: entry for entry in entries}

    skill = by_name["Amon-Ra St. Brown"]
    assert skill["espn_id"] == "4374302"
    assert skill["dst_team"] is None
    assert skill["position"] == "WR"
    assert skill["lineup_slot"] == "WR"
    assert skill["pro_team"] == "DET"

    defense = by_name["Broncos D/ST"]
    assert defense["espn_id"] is None
    assert defense["dst_team"] == "DEN"
    assert defense["lineup_slot"] == "DST"

    bench = by_name["Washington Defender"]
    assert bench["lineup_slot"] == "BENCH"
    # ESPN spells this WSH; we must emit the site's spelling.
    assert bench["pro_team"] == "WAS"


def test_espn_player_key_maps_defense_by_pro_team():
    """D/ST ids are synthetic (-16000 - proTeamId), so they cross over by team."""
    espn_id, dst = espn_player_key(
        {"id": -16007, "defaultPositionId": 16, "proTeamId": 7}
    )
    assert espn_id is None and dst == "DEN"

    espn_id, dst = espn_player_key(
        {"id": 4374302, "defaultPositionId": 3, "proTeamId": 8}
    )
    assert espn_id == "4374302" and dst is None


def test_pro_team_map_matches_site_abbreviations():
    """Guards the WSH/WAS trap: ESPN and the site disagree on Washington."""
    assert len(ESPN_PRO_TEAM_ABBR) == 32
    site_abbrevs = set(NFL_TEAM_ABBR.values())
    assert set(ESPN_PRO_TEAM_ABBR.values()) == site_abbrevs
    assert ESPN_PRO_TEAM_ABBR[28] == "WAS"


def test_lineup_slots_cover_every_slot_the_league_uses():
    for raw_slot in LINEUP_SLOT_COUNTS:
        assert int(raw_slot) in ESPN_LINEUP_SLOTS


def test_malformed_payloads_raise():
    with pytest.raises(EspnLeagueError):
        parse_teams({"settings": {}}, {})
    with pytest.raises(EspnLeagueError):
        parse_schedule({})
    with pytest.raises(EspnLeagueError):
        parse_settings({"teams": []}, 2026)
    with pytest.raises(EspnLeagueError):
        parse_settings(["not-an-object"], 2026)


def test_configured_seasons_parses_env(monkeypatch):
    monkeypatch.setenv("ESPN_LEAGUE_SEASONS", "2026, 2024,2023")
    assert configured_seasons() == [2023, 2024, 2026]

    monkeypatch.setenv("ESPN_LEAGUE_SEASONS", "")
    assert configured_seasons() == [2023, 2024, 2025, 2026]
