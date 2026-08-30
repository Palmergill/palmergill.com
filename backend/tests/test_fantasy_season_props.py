"""Season-long NFL player over/under collection and read behavior."""
import json

import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyMeta,
    FantasyPlayer,
    FantasyProjection,
    FantasySeasonPropSnapshot,
    SessionLocal,
)
from app.services import fantasy_collector as fc
from app.services import fantasy_data as fd
from app.services.fantasy_common import normalize_name
from app.services.fantasy_season_props import (
    KalshiClient,
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


class FakeKalshi(KalshiClient):
    """The real client with its one network call stubbed out."""

    def get_season_props(self):
        return PAYLOAD


@pytest.fixture
def db():
    session = SessionLocal()
    session.query(FantasySeasonPropSnapshot).delete()
    session.query(FantasyProjection).delete()
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


def test_parser_uses_a_real_last_trade_when_the_live_book_is_one_sided():
    traded = market(
        "KXNFLSEASONPASSTDS-27C30-JALLEN", "Josh Allen", 29.5, 0.0, 0.62
    )
    traded.update({"last_price_dollars": "0.5800", "volume_fp": "14.25"})
    rows = parse_season_props({"KXNFLSEASONPASSTDS": [traded]})

    assert len(rows) == 2
    assert next(row for row in rows if row["outcome"] == "Over")["price"] == -138

    # A displayed last price with no executed volume is not market evidence.
    traded["volume_fp"] = "0.00"
    assert parse_season_props({"KXNFLSEASONPASSTDS": [traded]}) == []


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
    class NoLiquidity(KalshiClient):
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
    class Unavailable(KalshiClient):
        configured = False

    run = fc.collect_season_props(db, client=Unavailable())
    assert run.status == "skipped"
    assert run.detail == "no season props provider is configured"


def test_leaderboard_lists_who_is_quoted_and_ranks_them(db):
    fc.collect_season_props(db, client=FakeKalshi())

    board = fd.get_season_prop_leaders(db, season=2026)

    # Passing yards is the only category with anyone in it, so it leads.
    assert board["market"] == "season_pass_yds"
    assert board["source"] == "Kalshi"
    assert [entry["player"]["name"] for entry in board["leaders"]] == ["Josh Allen"]
    # P(over 3499.5)=65% and P(over 3999.5)=39%; interpolate the 50% crossing.
    assert board["leaders"][0]["implied_value"] == pytest.approx(3788.9, abs=0.2)
    counts = {entry["market"]: entry["players"] for entry in board["markets"]}
    assert counts["season_pass_yds"] == 1
    # Categories nobody trades are still reported, so the client can show the
    # whole board and mark them rather than hiding a tab that turns up empty.
    assert counts["season_rush_yds"] == 0
    assert len(board["markets"]) == 6


def test_leaderboard_ranks_on_implied_raw_value(db):
    class TwoReceivers(KalshiClient):
        def get_season_props(self):
            return {
                "KXNFLSEASONRECYDS": [
                    market("KXNFLSEASONRECYDS-27C750-FAVORITE", "Alpha Receiver", 749.5, 0.76, 0.84),
                    market("KXNFLSEASONRECYDS-27C1000-FAVORITE", "Alpha Receiver", 999.5, 0.36, 0.44),
                    # A sparse player still gets a raw value from this quote
                    # and the category slope established by Alpha's ladder.
                    market("KXNFLSEASONRECYDS-27C750-LONGSHOT", "Zeta Receiver", 749.5, 0.56, 0.64),
                ]
            }

    db.add(named_player("wr_fav", "Alpha Receiver", "WR", "SEA"))
    db.add(named_player("wr_dog", "Zeta Receiver", "WR", "NYJ"))
    db.commit()
    fc.collect_season_props(db, client=TwoReceivers())

    leaders = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)["leaders"]

    assert [entry["player"]["name"] for entry in leaders] == ["Alpha Receiver", "Zeta Receiver"]
    assert leaders[0]["implied_value"] == pytest.approx(937.0, abs=0.2)
    assert leaders[1]["implied_value"] == pytest.approx(812.0, abs=0.2)
    assert leaders[0]["implied_value"] > leaders[1]["implied_value"]


def test_leaderboard_is_empty_before_any_collection_run(db):
    board = fd.get_season_prop_leaders(db, season=2026)

    assert board["leaders"] == []
    assert board["source"] is None
    assert all(entry["players"] == 0 for entry in board["markets"])


def test_implied_fantasy_points_combine_yards_and_touchdowns(db):
    class ReceiverMarkets(KalshiClient):
        def get_season_props(self):
            return {
                "KXNFLSEASONRECYDS": [
                    market("KXNFLSEASONRECYDS-27C1000-ALPHA", "Alpha Receiver", 999.5, 0.48, 0.52),
                    market("KXNFLSEASONRECYDS-27C750-ZETA", "Zeta Receiver", 749.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRECTD": [
                    market("KXNFLSEASONRECTD-27C10-ALPHA", "Alpha Receiver", 9.5, 0.48, 0.52),
                    market("KXNFLSEASONRECTD-27C8-ZETA", "Zeta Receiver", 7.5, 0.48, 0.52),
                ],
            }

    db.add(named_player("wr_alpha", "Alpha Receiver", "WR", "SEA"))
    db.add(named_player("wr_zeta", "Zeta Receiver", "WR", "NYJ"))
    db.commit()
    fc.collect_season_props(db, client=ReceiverMarkets())

    class SeasonProjections:
        def get_season_projections(self, season):
            return [
                {
                    "player_id": "wr_alpha",
                    "pts_ppr": 250.0,
                    "pts_half_ppr": 205.0,
                    "pts_std": 160.0,
                    "stats": {"rec": 90.0},
                },
                {
                    "player_id": "wr_zeta",
                    "pts_ppr": 190.0,
                    "pts_half_ppr": 160.0,
                    "pts_std": 130.0,
                    "stats": {"rec": 60.0},
                },
            ]

    fc.collect_projections(db, 2026, fc.SEASON_LONG_WEEK, client=SeasonProjections())

    board = fd.get_season_fantasy_point_leaders(db, season=2026)

    assert board["scoring"] == "std"
    assert [entry["player"]["name"] for entry in board["leaders"]] == [
        "Alpha Receiver", "Zeta Receiver",
    ]
    assert board["leaders"][0] == {
        "player": fd._player_public(db.get(FantasyPlayer, "wr_alpha")),
        "yard_points": 100.0,
        "touchdown_points": 57.0,
        "projected_receptions": 90.0,
        "reception_points": 0.0,
        "fantasy_points": 157.0,
        "markets_used": 2,
        "pairs_used": ["receiving"],
        "partial_pairs": [],
        # Sleeper's season-long pts_std for wr_alpha; the market is 3.0 under it.
        "projected_points": 160.0,
        "projection_delta": -3.0,
        "books": ["Kalshi"],
        "implied": {"season_rec_yds": 999.5, "season_rec_tds": 9.5},
    }
    assert board["leaders"][1]["fantasy_points"] == 120.0

    half = fd.get_season_fantasy_point_leaders(db, season=2026, scoring="half")
    assert half["scoring"] == "half"
    # Only Sleeper has a week-0 run here, so there is no blend to make.
    assert half["projection_source"] == "sleeper"
    assert half["projection_providers"] is None
    assert half["leaders"][0]["reception_points"] == 45.0
    assert half["leaders"][0]["fantasy_points"] == 202.0

    ppr = fd.get_season_fantasy_point_leaders(db, season=2026, scoring="ppr")
    assert ppr["leaders"][0]["reception_points"] == 90.0
    assert ppr["leaders"][0]["fantasy_points"] == 247.0


def test_implied_fantasy_points_require_the_primary_matching_pair(db):
    class MismatchedQuarterbackMarkets(KalshiClient):
        def get_season_props(self):
            return {
                **PAYLOAD,
                "KXNFLSEASONRSHTD": [
                    market("KXNFLSEASONRSHTD-27C8-JALLEN", "Josh Allen", 7.5, 0.48, 0.52),
                ],
            }

    fc.collect_season_props(db, client=MismatchedQuarterbackMarkets())

    board = fd.get_season_fantasy_point_leaders(db, season=2026)

    # Passing yards plus a rushing-TD market is not a complete QB projection.
    assert board["leaders"] == []


def test_implied_fantasy_points_name_the_categories_behind_each_total(db):
    """A dropped half-quoted category is reported, not silently omitted."""

    class RunningQuarterbackMarkets(KalshiClient):
        def get_season_props(self):
            return {
                "KXNFLSEASONPASSYDS": [
                    market("KXNFLSEASONPASSYDS-27C4000-JALLEN", "Josh Allen", 3999.5, 0.48, 0.52),
                    market("KXNFLSEASONPASSYDS-27C4000-POCKET", "Pocket Passer", 3999.5, 0.48, 0.52),
                ],
                "KXNFLSEASONPASSTDS": [
                    market("KXNFLSEASONPASSTDS-27C30-JALLEN", "Josh Allen", 29.5, 0.48, 0.52),
                    market("KXNFLSEASONPASSTDS-27C30-POCKET", "Pocket Passer", 29.5, 0.48, 0.52),
                ],
                # Allen has both halves of the rushing pair, so it scores.
                "KXNFLSEASONRSHYDS": [
                    market("KXNFLSEASONRSHYDS-27C500-JALLEN", "Josh Allen", 499.5, 0.48, 0.52),
                    market("KXNFLSEASONRSHYDS-27C200-POCKET", "Pocket Passer", 199.5, 0.48, 0.52),
                ],
                # The pocket passer has rushing yards but no rushing-TD ladder,
                # so his rushing yards are discarded rather than counted alone.
                "KXNFLSEASONRSHTD": [
                    market("KXNFLSEASONRSHTD-27C6-JALLEN", "Josh Allen", 5.5, 0.48, 0.52),
                ],
            }

    # Josh Allen is already seeded by the fixture; a second row with the same
    # name would make the collector's name lookup ambiguous.
    db.add(named_player("qb_pocket", "Pocket Passer", "QB", "NYG"))
    db.commit()
    fc.collect_season_props(db, client=RunningQuarterbackMarkets())

    board = fd.get_season_fantasy_point_leaders(db, season=2026)
    rows = {entry["player"]["name"]: entry for entry in board["leaders"]}

    allen = rows["Josh Allen"]
    assert allen["pairs_used"] == ["passing", "rushing"]
    assert allen["partial_pairs"] == []
    # 3999.5/25 + 499.5/10 = 159.98 + 49.95; 29.5*4 + 5.5*6 = 118 + 33.
    assert allen["yard_points"] == 209.9
    assert allen["touchdown_points"] == 151.0
    assert allen["fantasy_points"] == 360.9

    pocket = rows["Pocket Passer"]
    assert pocket["pairs_used"] == ["passing"]
    assert pocket["partial_pairs"] == ["rushing"]
    # The 199.5 rushing yards are not in the total, and the row says so.
    assert pocket["yard_points"] == 160.0
    assert pocket["fantasy_points"] == 278.0


def _two_receivers_with_markets(db):
    """Two quoted receivers, so projection coverage can differ between them."""

    class ReceiverMarkets(KalshiClient):
        def get_season_props(self):
            return {
                "KXNFLSEASONRECYDS": [
                    market("KXNFLSEASONRECYDS-27C1000-ALPHA", "Alpha Receiver", 999.5, 0.48, 0.52),
                    market("KXNFLSEASONRECYDS-27C750-ZETA", "Zeta Receiver", 749.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRECTD": [
                    market("KXNFLSEASONRECTD-27C10-ALPHA", "Alpha Receiver", 9.5, 0.48, 0.52),
                    market("KXNFLSEASONRECTD-27C8-ZETA", "Zeta Receiver", 7.5, 0.48, 0.52),
                ],
            }

    db.add(named_player("wr_alpha", "Alpha Receiver", "WR", "SEA"))
    db.add(named_player("wr_zeta", "Zeta Receiver", "WR", "NYJ"))
    db.commit()
    fc.collect_season_props(db, client=ReceiverMarkets())


def _sleeper_season_projections(rows):
    class SeasonProjections:
        def get_season_projections(self, season):
            return rows

    return SeasonProjections()


def test_projected_points_follow_the_requested_scoring(db):
    _two_receivers_with_markets(db)
    fc.collect_projections(db, 2026, fc.SEASON_LONG_WEEK, client=_sleeper_season_projections([
        {
            "player_id": "wr_alpha",
            "pts_ppr": 250.0, "pts_half_ppr": 205.0, "pts_std": 160.0,
            "stats": {"rec": 90.0},
        },
    ]))

    def alpha(scoring):
        board = fd.get_season_fantasy_point_leaders(db, season=2026, scoring=scoring)
        return next(e for e in board["leaders"] if e["player"]["player_id"] == "wr_alpha")

    # The column has to track the toggle, not sit on one field.
    assert alpha("std")["projected_points"] == 160.0
    assert alpha("half")["projected_points"] == 205.0
    assert alpha("ppr")["projected_points"] == 250.0

    # 157.0 market vs 160.0 projected, and the delta is clean to one decimal
    # rather than the -3.0000000000000114 a raw float subtraction would give.
    assert alpha("std")["projection_delta"] == -3.0


def test_a_quoted_player_without_a_projection_still_ranks_in_standard(db):
    _two_receivers_with_markets(db)
    # Zeta is quoted by the market but absent from the projection feed.
    fc.collect_projections(db, 2026, fc.SEASON_LONG_WEEK, client=_sleeper_season_projections([
        {
            "player_id": "wr_alpha",
            "pts_ppr": 250.0, "pts_half_ppr": 205.0, "pts_std": 160.0,
            "stats": {"rec": 90.0},
        },
    ]))

    std = fd.get_season_fantasy_point_leaders(db, season=2026, scoring="std")
    zeta = next(e for e in std["leaders"] if e["player"]["player_id"] == "wr_zeta")
    # He keeps his market rank; only the comparison columns are blank.
    assert zeta["projected_points"] is None
    assert zeta["projection_delta"] is None
    assert zeta["fantasy_points"] == 120.0
    assert std["excluded_without_projection"] == 0

    # PPR needs a reception projection to be honest, so he drops — and says so.
    ppr = fd.get_season_fantasy_point_leaders(db, season=2026, scoring="ppr")
    assert [e["player"]["player_id"] for e in ppr["leaders"]] == ["wr_alpha"]
    assert ppr["excluded_without_projection"] == 1


def test_two_providers_blend_into_a_consensus_projection(db):
    _two_receivers_with_markets(db)
    fc.collect_projections(db, 2026, fc.SEASON_LONG_WEEK, client=_sleeper_season_projections([
        {
            "player_id": "wr_alpha",
            "pts_ppr": 250.0, "pts_half_ppr": 205.0, "pts_std": 160.0,
            "stats": {"rec": 90.0},
        },
    ]))

    class EspnProjections:
        def get_projections(self, season, week):
            return [{"name": "Alpha Receiver", "espn_id": None,
                     "pts_ppr": 270.0, "pts_half_ppr": 225.0, "pts_std": 180.0,
                     "stats": {}}]

    fc.collect_espn_projections(db, 2026, fc.SEASON_LONG_WEEK, client=EspnProjections())

    board = fd.get_season_fantasy_point_leaders(db, season=2026, scoring="std")
    alpha = next(e for e in board["leaders"] if e["player"]["player_id"] == "wr_alpha")

    assert board["projection_source"] == "consensus"
    assert board["projection_providers"] == ["espn", "sleeper"]
    # Mean of Sleeper's 160 and ESPN's 180.
    assert alpha["projected_points"] == 170.0
    assert alpha["projection_delta"] == -13.0


def test_offense_rankings_combine_air_and_rushing_without_double_counting(db):
    class TeamMarkets(KalshiClient):
        def get_season_props(self):
            return {
                "KXNFLSEASONPASSYDS": [
                    market("KXNFLSEASONPASSYDS-27C4000-JALLEN", "Josh Allen", 3999.5, 0.48, 0.52),
                    market("KXNFLSEASONPASSYDS-27C4500-KCQB", "Kansas City QB", 4499.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRSHYDS": [
                    market("KXNFLSEASONRSHYDS-27C1000-BUFRB", "Buffalo Runner", 999.5, 0.48, 0.52),
                    market("KXNFLSEASONRSHYDS-27C800-KCRB", "Kansas City Runner", 799.5, 0.48, 0.52),
                    market("KXNFLSEASONRSHYDS-27C900-CHIRB", "Chicago Runner", 899.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRECYDS": [
                    # KC's receiving line must not be added on top of its
                    # passing line. Chicago uses receiving as an air fallback.
                    market("KXNFLSEASONRECYDS-27C1500-KCWR", "Kansas City Receiver", 1499.5, 0.48, 0.52),
                    market("KXNFLSEASONRECYDS-27C1200-CHIWR", "Chicago Receiver", 1199.5, 0.48, 0.52),
                ],
                "KXNFLSEASONPASSTDS": [
                    market("KXNFLSEASONPASSTDS-27C30-JALLEN", "Josh Allen", 29.5, 0.48, 0.52),
                    market("KXNFLSEASONPASSTDS-27C35-KCQB", "Kansas City QB", 34.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRSHTD": [
                    market("KXNFLSEASONRSHTD-27C12-BUFRB", "Buffalo Runner", 11.5, 0.48, 0.52),
                    market("KXNFLSEASONRSHTD-27C10-KCRB", "Kansas City Runner", 9.5, 0.48, 0.52),
                ],
                "KXNFLSEASONRECTD": [
                    market("KXNFLSEASONRECTD-27C14-KCWR", "Kansas City Receiver", 13.5, 0.48, 0.52),
                ],
            }

    for player_id, name, position, team in (
        ("buf_rb", "Buffalo Runner", "RB", "BUF"),
        ("kc_qb", "Kansas City QB", "QB", "KC"),
        ("kc_rb", "Kansas City Runner", "RB", "KC"),
        ("kc_wr", "Kansas City Receiver", "WR", "KC"),
        ("chi_rb", "Chicago Runner", "RB", "CHI"),
        ("chi_wr", "Chicago Receiver", "WR", "CHI"),
    ):
        db.add(named_player(player_id, name, position, team))
    db.commit()
    fc.collect_season_props(db, client=TeamMarkets())

    board = fd.get_season_offense_leaders(db, season=2026)

    assert [row["team"] for row in board["yards"]] == ["KC", "BUF", "CHI"]
    assert board["yards"][0] == {
        "team": "KC",
        "total": 5299.0,
        "air": 4499.5,
        "ground": 799.5,
        "air_source": "passing",
        "players": 2,
    }
    assert board["yards"][2]["air_source"] == "receiving"
    assert board["yards"][2]["total"] == 2099.0
    assert [row["team"] for row in board["touchdowns"]] == ["KC", "BUF"]
    assert [row["total"] for row in board["touchdowns"]] == [44.0, 41.0]


def test_offense_rankings_are_empty_before_any_collection_run(db):
    board = fd.get_season_offense_leaders(db, season=2026)

    assert board["source"] is None
    assert board["yards"] == []
    assert board["touchdowns"] == []
