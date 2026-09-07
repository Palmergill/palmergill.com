"""ADP client tests: parsing only, no network.

The fixture mirrors a real Fantasy Football Calculator response captured on
2026-09-07 for the 10-team 2QB board, including the two spellings that trip up
a naive parser: kickers arrive as "PK", and the board labels itself "2 QB"
with a space while the format key we store is "2qb".
"""
import pytest

from app.services.fantasy_adp import ADP_FORMATS, AdpError, parse_adp

FFC_PAYLOAD = {
    "status": "Success",
    "meta": {
        "type": "2 QB",
        "teams": 10,
        "rounds": 15,
        "total_drafts": 7208,
        "start_date": "2026-08-06",
        "end_date": "2026-09-05",
    },
    "players": [
        {
            "player_id": 5672,
            "name": "Jahmyr Gibbs",
            "position": "RB",
            "team": "DET",
            "adp": 1.7,
            "adp_formatted": "1.02",
            "times_drafted": 1179,
            "high": 1,
            "low": 4,
            "stdev": 0.8,
            "bye": 6,
        },
        {
            "player_id": 9001,
            "name": "Brandon Aubrey",
            "position": "PK",
            "team": "DAL",
            "adp": 140.2,
            "times_drafted": 900,
            "high": 120,
            "low": 150,
            "stdev": 6.1,
            "bye": 10,
        },
        {
            "player_id": 9002,
            "name": "Denver Broncos",
            "position": "DEF",
            "team": "DEN",
            "adp": 138.0,
            "times_drafted": 810,
            "high": 118,
            "low": 150,
            "stdev": 7.4,
            "bye": 12,
        },
    ],
}


_DEFAULT = object()


def parse(payload=_DEFAULT, fmt="2qb"):
    # Sentinel rather than `or`: several cases below pass a *falsy* payload
    # (an empty list) on purpose, and `payload or FFC_PAYLOAD` would quietly
    # substitute the good one and pass for the wrong reason.
    if payload is _DEFAULT:
        payload = FFC_PAYLOAD
    return parse_adp(payload, fmt=fmt, teams=10, season=2026)


def test_meta_describes_the_sample_the_board_was_built_from():
    # A recap that grades a draft against ADP has to be able to say which ADP
    # it means, so the draft count and window travel with the board.
    meta = parse()["meta"]
    assert meta["format"] == "2qb"
    assert meta["total_drafts"] == 7208
    assert meta["start_date"] == "2026-08-06"
    assert meta["end_date"] == "2026-09-05"
    assert meta["teams"] == 10
    assert meta["rounds"] == 15


def test_the_stored_format_key_wins_over_ffcs_own_label():
    meta = parse()["meta"]
    assert meta["format"] == "2qb"  # not "2 QB"
    assert meta["source_label"] == "2 QB"


def test_kickers_are_renamed_to_the_sites_position_spelling():
    by_name = {p["name"]: p for p in parse()["players"]}
    assert by_name["Brandon Aubrey"]["position"] == "K"


def test_defenses_keep_the_spelling_the_site_already_uses():
    by_name = {p["name"]: p for p in parse()["players"]}
    assert by_name["Denver Broncos"]["position"] == "DEF"


def test_the_spread_fields_survive_because_reach_is_measured_in_them():
    gibbs = parse()["players"][0]
    assert gibbs["adp"] == 1.7
    assert gibbs["adp_stdev"] == 0.8
    assert gibbs["adp_high"] == 1
    assert gibbs["adp_low"] == 4
    assert gibbs["times_drafted"] == 1179
    assert gibbs["bye"] == 6


def test_a_row_without_a_mean_pick_is_dropped_rather_than_stored_unusable():
    payload = dict(FFC_PAYLOAD)
    payload["players"] = FFC_PAYLOAD["players"] + [
        {"player_id": 3, "name": "No Adp Guy", "position": "WR", "team": "SF"}
    ]
    names = [p["name"] for p in parse(payload)["players"]]
    assert "No Adp Guy" not in names
    assert len(names) == 3


def test_a_row_without_a_name_cannot_be_joined_and_is_dropped():
    payload = dict(FFC_PAYLOAD)
    payload["players"] = FFC_PAYLOAD["players"] + [{"player_id": 4, "adp": 50.0}]
    assert len(parse(payload)["players"]) == 3


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"status": "Success"},
        {"status": "Success", "players": "nope"},
        {"status": "Error", "players": []},
    ],
)
def test_a_malformed_board_raises_rather_than_returning_an_empty_one(payload):
    # Silently returning nothing would look identical to "nobody is drafting",
    # which is a claim this parser must never make on its own.
    with pytest.raises(AdpError):
        parse(payload)


def test_a_board_with_no_usable_rows_raises():
    with pytest.raises(AdpError):
        parse({"status": "Success", "meta": {}, "players": []})


def test_every_declared_format_maps_to_an_ffc_path_segment():
    assert ADP_FORMATS["2qb"] == "2qb"
    assert ADP_FORMATS["half_ppr"] == "half-ppr"
