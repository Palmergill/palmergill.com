"""Suggested pickups and trades, priced by rebuilding the best lineup."""
from app.services.fantasy_league_data import SLOT_ELIGIBILITY
from app.services.fantasy_league_moves import (
    suggest_pickups,
    suggest_trades,
    team_moves,
)

SLOTS = ["QB", "RB", "RB", "WR", "WR", "FLEX", "DST"]


def player(pid, position, ppg, slot=None, out=False):
    return {
        "player_id": pid,
        "name": pid.title(),
        "position": position,
        "pro_team": "KC",
        "ppg": ppg,
        "slot": slot,
        "out": out,
    }


def team(team_id, players, name=None):
    return {"espn_team_id": team_id, "name": name or f"Team {team_id}", "players": players}


MINE = team(1, [
    player("qb1", "QB", 20.0),
    player("rb1", "RB", 15.0),
    player("rb2", "RB", 14.0),
    player("rb3", "RB", 12.0),
    player("rb4", "RB", 11.0),
    player("wr1", "WR", 13.0),
    player("wr2", "WR", 6.0),
    player("dst1", "DEF", 6.0),
    player("bench_wr", "WR", 3.0),
])

THEIRS = team(2, [
    player("qb9", "QB", 19.0),
    player("rb9", "RB", 13.0),
    player("rb8", "RB", 5.0),
    player("wr9", "WR", 12.5),
    player("wr8", "WR", 12.0),
    player("wr7", "WR", 11.5),
    player("wr6", "WR", 10.0),
    player("dst9", "DEF", 7.0),
], name="Theirs")


def fa(pid, position, ppg):
    return {"player_id": pid, "name": pid.title(), "position": position, "pro_team": "NYJ", "ppg": ppg}


def test_a_free_agent_who_lifts_the_lineup_is_a_pickup():
    pickups = suggest_pickups(MINE, {"WR": fa("fa_wr", "WR", 8.5)}, SLOTS, SLOT_ELIGIBILITY)
    assert len(pickups) == 1
    # He takes wr2's seat: 8.5 - 6.0.
    assert pickups[0]["gain"] == 2.5
    assert pickups[0]["replaces"]["name"] == "Wr2"
    # Same position displaced, so that is who goes.
    assert pickups[0]["drop"]["name"] == "Wr2"


def test_a_free_agent_who_would_not_start_is_not_suggested():
    assert suggest_pickups(MINE, {"WR": fa("fa_wr", "WR", 5.0)}, SLOTS, SLOT_ELIGIBILITY) == []


def test_a_marginal_upgrade_is_not_worth_a_claim():
    # 6.5 over a 6.0 defense is half a point: churn.
    assert suggest_pickups(MINE, {"DEF": fa("fa_d", "DEF", 6.5)}, SLOTS, SLOT_ELIGIBILITY) == []


def test_an_empty_seat_takes_the_free_agent_at_full_value():
    no_dst = team(1, [p for p in MINE["players"] if p["position"] != "DEF"])
    pickup = suggest_pickups(no_dst, {"DEF": fa("fa_d", "DEF", 7.0)}, SLOTS, SLOT_ELIGIBILITY)[0]
    assert pickup["gain"] == 7.0
    assert pickup["replaces"] is None
    assert pickup["slot"] == "DST"
    assert pickup["drop"]["name"] == "Bench_Wr"


REPLACEMENTS = {
    "QB": fa("fa_qb", "QB", 10.0),
    "RB": fa("fa_rb", "RB", 5.0),
    "WR": fa("fa_wr", "WR", 5.0),
    "TE": fa("fa_te", "TE", 4.0),
    "DEF": fa("fa_d", "DEF", 5.0),
}


def test_a_trade_needs_both_lineups_to_come_out_ahead():
    trades = suggest_trades(MINE, [MINE, THEIRS], SLOTS, SLOT_ELIGIBILITY, REPLACEMENTS)
    assert len(trades) == 1
    trade = trades[0]
    assert trade["partner"]["name"] == "Theirs"
    # My spare running back for their spare receiver.
    assert [p["position"] for p in trade["give"]] == ["RB"]
    assert [p["position"] for p in trade["get"]] == ["WR"]
    assert trade["my_gain"] >= 1.0 and trade["their_gain"] >= 1.0
    assert trade["my_drop"] is None and trade["their_drop"] is None


def test_two_spare_players_can_buy_one_better_one():
    # Their one tradeable player is a star no single player of mine matches
    # in value; everyone else they have is replacement level.
    deep = team(1, [
        player("qb1", "QB", 20.0),
        player("rb1", "RB", 15.0),
        player("rb2", "RB", 14.0),
        player("rb3", "RB", 13.0),
        player("rb4", "RB", 11.0),
        player("wr1", "WR", 13.0),
        player("wr2", "WR", 6.0),
        player("dst1", "DEF", 6.0),
    ])
    thin = team(2, [
        player("qb9", "QB", 19.0),
        player("rb9", "RB", 5.0),
        player("rb8", "RB", 5.0),
        player("wr9", "WR", 17.0),
        player("wr8", "WR", 5.0),
        player("wr7", "WR", 5.0),
        player("dst9", "DEF", 7.0),
    ], name="Thin")
    trades = suggest_trades(deep, [deep, thin], SLOTS, SLOT_ELIGIBILITY, REPLACEMENTS)
    assert trades, "expected a trade"
    trade = trades[0]
    assert len(trade["give"]) == 2 and len(trade["get"]) == 1
    assert trade["get"][0]["name"] == "Wr9"
    # They take two for one, so they cut someone; I do not.
    assert trade["their_drop"] is not None
    assert trade["my_drop"] is None


def test_a_package_never_exceeds_two_a_side():
    trades = suggest_trades(MINE, [MINE, THEIRS], SLOTS, SLOT_ELIGIBILITY, REPLACEMENTS)
    for trade in trades:
        assert 1 <= len(trade["give"]) <= 2 and 1 <= len(trade["get"]) <= 2


def test_no_trade_when_only_one_side_wins():
    # A partner with nothing spare to offer at a position I need.
    rich = team(3, [player("qbx", "QB", 25.0), player("rbx", "RB", 20.0), player("rby", "RB", 19.0),
                    player("wrx", "WR", 18.0), player("wry", "WR", 17.0), player("wrz", "WR", 16.0),
                    player("dstx", "DEF", 9.0)])
    assert suggest_trades(MINE, [MINE, rich], SLOTS, SLOT_ELIGIBILITY, REPLACEMENTS) == []


def test_team_moves_reads_one_team_off_the_board():
    board = {
        "slots": SLOTS,
        "teams": [{**MINE, "need": {"seat": "WR2"}, "surplus": []}, THEIRS],
        "replacements": {**REPLACEMENTS, "WR": fa("fa_wr", "WR", 8.5)},
    }
    moves = team_moves(1, board, SLOT_ELIGIBILITY)
    assert moves["available"] is True
    assert moves["need"]["seat"] == "WR2"
    assert moves["pickups"] and moves["trades"]
    assert team_moves(99, board, SLOT_ELIGIBILITY)["available"] is False
