"""Season-long NFL player over/under collection and read behavior."""
import json

import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyMeta,
    FantasyPlayer,
    FantasySeasonPropSnapshot,
    SessionLocal,
)
from app.services import fantasy_collector as fc
from app.services import fantasy_data as fd
from app.services.fantasy_common import normalize_name
from app.services.fantasy_season_props import (
    parse_season_props,
    probability_to_american,
)


def market(ticker, name, strike, bid, ask, status="active"):
    """A Kalshi market row, trimmed to the fields the parser reads."""
    return {
        "ticker": ticker,
        "yes_sub_title": name,
        "floor_strike": strike,
        "yes_bid_dollars": f"{bid:.4f}",
        "yes_ask_dollars": f"{ask:.4f}",
        "status": status,
    }


# Josh Allen's ladder is tight and correctly ordered, so it survives. The
# other three rows each trip one filter.
PAYLOAD = {
    "KXNFLSEASONPASSYDS": [
        market("KXNFLSEASONPASSYDS-27C3500-JALLEN", "Josh Allen", 3499.5, 0.62, 0.68),
        market("KXNFLSEASONPASSYDS-27C4000-JALLEN", "Josh Allen", 3999.5, 0.36, 0.42),
        # Bid 0.02 against an ask near the cap is an empty book, not a wide one.
        market("KXNFLSEASONPASSYDS-27C3500-BACKUP", "Backup Passer", 3499.5, 0.02, 0.84),
        # Settled markets keep their last quote; only active ones are a view.
        market("KXNFLSEASONPASSYDS-27C3500-RETIRED", "Retired Passer", 3499.5, 0.40, 0.44, status="finalized"),
    ],
    "KXNFLSEASONRECYDS": [
        # 1000+ priced below 1250+ is impossible, so the ladder is dropped.
        market("KXNFLSEASONRECYDS-27C1000-STALE", "Stale Receiver", 999.5, 0.30, 0.36),
        market("KXNFLSEASONRECYDS-27C1250-STALE", "Stale Receiver", 1249.5, 0.55, 0.61),
    ],
}


class FakeKalshi:
    configured = True
    max_spread = 0.20

    def get_season_props(self):
        return PAYLOAD


@pytest.fixture
def db():
    session = SessionLocal()
    session.query(FantasySeasonPropSnapshot).delete()
    session.query(FantasyCollectionRun).delete()
    session.query(FantasyPlayer).delete()
    session.query(FantasyMeta).delete()
    session.commit()
    fc.set_meta(session, "nfl_state", json.dumps({"season": 2026, "week": 1, "season_type": "pre"}))
    session.add(
        FantasyPlayer(
            player_id="qb1",
            full_name="Josh Allen",
            search_name=normalize_name("Josh Allen"),
            team="BUF",
            position="QB",
        )
    )
    session.commit()
    yield session
    session.rollback()
    session.close()


def test_probability_to_american_normalizes_both_sides_of_even_money():
    # Even money is +100 by convention here, matching the decimal-odds
    # helper this replaced (2.00 -> +100).
    assert probability_to_american(0.5) == 100
    assert probability_to_american(0.65) == -186
    assert probability_to_american(0.25) == 300
    # 0 and 1 are not prices, they are settled outcomes.
    assert probability_to_american(0) is None
    assert probability_to_american(1) is None
    assert probability_to_american(None) is None


def test_parser_emits_both_sides_of_each_surviving_threshold():
    rows = parse_season_props(PAYLOAD)

    assert {row["player_name_raw"] for row in rows} == {"Josh Allen"}
    assert {row["bookmaker"] for row in rows} == {"Kalshi"}
    # Two strikes x Over/Under.
    assert len(rows) == 4

    over = next(r for r in rows if r["point"] == 3499.5 and r["outcome"] == "Over")
    under = next(r for r in rows if r["point"] == 3499.5 and r["outcome"] == "Under")
    assert over["market"] == "season_pass_yds"
    assert over["provider_player_id"] == "JALLEN"
    # Mid of 0.62/0.68 is 0.65; the Under is its complement.
    assert over["price"] == -186
    assert under["price"] == 186


def test_parser_drops_empty_books_settled_markets_and_stale_ladders():
    names = {row["player_name_raw"] for row in parse_season_props(PAYLOAD)}
    assert "Backup Passer" not in names
    assert "Retired Passer" not in names
    assert "Stale Receiver" not in names


def test_parser_spread_filter_is_configurable():
    wide = {
        "KXNFLSEASONPASSYDS": [
            market("KXNFLSEASONPASSYDS-27C3500-WIDE", "Wide Passer", 3499.5, 0.40, 0.65),
        ]
    }
    assert parse_season_props(wide) == []
    assert len(parse_season_props(wide, max_spread=0.30)) == 2


def test_collector_matches_player_and_read_returns_six_categories(db):
    run = fc.collect_season_props(db, client=FakeKalshi())
    assert run.status == "success"
    assert run.rows_written == 4
    assert all(row.player_id == "qb1" for row in db.query(FantasySeasonPropSnapshot).all())

    result = fd.get_player_season_props(db, "qb1", season=2026)
    assert result["player"]["name"] == "Josh Allen"
    assert result["source"] == "Kalshi"
    assert len(result["markets"]) == 6
    by_market = {row["market"]: row for row in result["markets"]}
    # Both strikes are stored; the read path picks one as the headline line.
    assert by_market["season_pass_yds"]["line"] in (3499.5, 3999.5)
    assert by_market["season_pass_yds"]["over_price"] is not None
    assert by_market["season_rush_yds"]["line"] is None


def named_player(player_id, name, position, team):
    return FantasyPlayer(
        player_id=player_id,
        full_name=name,
        search_name=normalize_name(name),
        team=team,
        position=position,
    )


def test_collector_ignores_a_shared_name_outside_the_quoted_positions(db):
    # A season passing line can only belong to a passer, so positions these
    # markets never price are not candidates for the name at all.
    db.add(named_player("lb1", "Josh Allen", "LB", "JAX"))
    db.commit()

    run = fc.collect_season_props(db, client=FakeKalshi())

    assert run.status == "success"
    assert {row.player_id for row in db.query(FantasySeasonPropSnapshot).all()} == {"qb1"}


def test_collector_gives_a_shared_name_to_the_rostered_player(db):
    # The catalog keeps retired players forever, so an active player routinely
    # collides with one who last played a decade ago. Only one is on a team.
    db.add(named_player("qb_retired", "Josh Allen", "QB", None))
    db.commit()

    run = fc.collect_season_props(db, client=FakeKalshi())

    assert run.status == "success"
    assert {row.player_id for row in db.query(FantasySeasonPropSnapshot).all()} == {"qb1"}


def test_collector_drops_a_name_two_rostered_players_share(db):
    # Nothing left to break the tie: no line is better than one under the
    # wrong player's face.
    db.add(named_player("wr9", "Josh Allen", "WR", "SEA"))
    db.commit()

    run = fc.collect_season_props(db, client=FakeKalshi())

    assert run.status == "partial"
    assert "no quoted player matched" in run.detail
    assert all(row.player_id is None for row in db.query(FantasySeasonPropSnapshot).all())
    assert fd.get_player_season_props(db, "qb1", season=2026)["markets"][0]["line"] is None


def test_collector_reports_partial_when_nothing_clears_the_filter(db):
    class NoLiquidity:
        configured = True
        max_spread = 0.20

        def get_season_props(self):
            return {
                "KXNFLSEASONPASSYDS": [
                    market("KXNFLSEASONPASSYDS-27C3500-X", "Josh Allen", 3499.5, 0.02, 0.84),
                ]
            }

    run = fc.collect_season_props(db, client=NoLiquidity())
    assert run.status == "partial"
    assert "quote filter" in run.detail


def test_collector_skips_when_provider_unavailable(db):
    class Unavailable:
        configured = False

    run = fc.collect_season_props(db, client=Unavailable())
    assert run.status == "skipped"
    assert "not configured" in run.detail


def test_leaderboard_lists_who_is_quoted_and_ranks_them(db):
    fc.collect_season_props(db, client=FakeKalshi())

    board = fd.get_season_prop_leaders(db, season=2026)

    # Passing yards is the only category with anyone in it, so it leads.
    assert board["market"] == "season_pass_yds"
    assert board["source"] == "Kalshi"
    assert [entry["player"]["name"] for entry in board["leaders"]] == ["Josh Allen"]
    counts = {entry["market"]: entry["players"] for entry in board["markets"]}
    assert counts["season_pass_yds"] == 1
    # Categories nobody trades are still reported, so the client can show the
    # whole board and mark them rather than hiding a tab that turns up empty.
    assert counts["season_rush_yds"] == 0
    assert len(board["markets"]) == 6


def test_leaderboard_breaks_a_shared_line_on_the_market_chance(db):
    class TwoReceivers:
        configured = True
        max_spread = 0.20

        def get_season_props(self):
            return {
                "KXNFLSEASONRECYDS": [
                    # Both quoted on the same threshold. Only the price says
                    # which one the market actually likes.
                    market("KXNFLSEASONRECYDS-27C1000-LONGSHOT", "Zeta Receiver", 999.5, 0.20, 0.26),
                    market("KXNFLSEASONRECYDS-27C1000-FAVORITE", "Alpha Receiver", 999.5, 0.70, 0.76),
                ]
            }

    db.add(named_player("wr_fav", "Alpha Receiver", "WR", "SEA"))
    db.add(named_player("wr_dog", "Zeta Receiver", "WR", "NYJ"))
    db.commit()
    fc.collect_season_props(db, client=TwoReceivers())

    leaders = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)["leaders"]

    assert [entry["player"]["name"] for entry in leaders] == ["Alpha Receiver", "Zeta Receiver"]
    assert leaders[0]["line"] == leaders[1]["line"] == 999.5
    assert leaders[0]["over_chance"] == 0.73
    # Alphabetical order would have put Alpha first by luck; make sure the
    # price is doing the work.
    assert leaders[0]["over_chance"] > leaders[1]["over_chance"]


def test_leaderboard_is_empty_before_any_collection_run(db):
    board = fd.get_season_prop_leaders(db, season=2026)

    assert board["leaders"] == []
    assert board["source"] is None
    assert all(entry["players"] == 0 for entry in board["markets"])
