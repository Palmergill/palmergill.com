"""Underdog and Polymarket season props, and the consensus they make possible.

The Kalshi-only behavior lives in test_fantasy_season_props.py. This file
covers what the second and third providers add: each one's own parsing
hazards, and the read path's job of holding three disagreeing sources
together without letting any one of them speak for the board.
"""
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
    SeasonPropsError,
    devig,
    parse_season_props,
)
from app.services.fantasy_polymarket_props import (
    PolymarketClient,
    parse_polymarket_props,
)
from app.services.fantasy_underdog_props import (
    UnderdogClient,
    parse_underdog_props,
)

import json


# ── Underdog ────────────────────────────────────────────────────────────


def ud_line(stat, value, appearance, over="-112", under="-112", **overrides):
    line = {
        "status": "active",
        "line_type": "balanced",
        "non_discounted_stat_value": None,
        "stat_value": value,
        "updated_at": "2026-08-23T02:33:44Z",
        "over_under": {
            "boost": None,
            "appearance_stat": {"stat": stat, "appearance_id": appearance},
        },
        "options": [
            {"choice": "higher", "american_price": over, "status": "active"},
            {"choice": "lower", "american_price": under, "status": "active"},
        ],
    }
    line.update(overrides)
    return line


UNDERDOG = {
    "players": [
        {"id": "p-nfl", "first_name": "Bucky", "last_name": "Irving", "sport_id": "NFL"},
        {"id": "p-cfb", "first_name": "College", "last_name": "Runner", "sport_id": "CFB"},
    ],
    "appearances": [
        {"id": "a-nfl", "player_id": "p-nfl"},
        {"id": "a-cfb", "player_id": "p-cfb"},
    ],
    "over_under_lines": [
        ud_line("season_rush_yards", "799.5", "a-nfl"),
        # Same stat and a bigger number, but college football. The feed is
        # every sport at once and the display name gives no hint.
        ud_line("season_rush_yards", "1799.5", "a-cfb"),
        # Promotional lines are priced to be attractive, not accurate.
        ud_line("season_rec_yards", "500.5", "a-nfl", line_type="boosted"),
        ud_line("season_rec_yards", "500.5", "a-nfl", non_discounted_stat_value="700.5"),
    ],
}


def test_underdog_keeps_only_nfl_players():
    rows = parse_underdog_props(UNDERDOG)

    assert {row["player_name_raw"] for row in rows} == {"Bucky Irving"}
    assert {row["bookmaker"] for row in rows} == {"Underdog"}


def test_underdog_drops_boosted_and_discounted_lines():
    markets = {row["market"] for row in parse_underdog_props(UNDERDOG)}

    assert markets == {"season_rush_yds"}


def test_underdog_balanced_line_is_the_markets_own_estimate():
    rows = parse_underdog_props(UNDERDOG)

    over = next(row for row in rows if row["outcome"] == "Over")
    under = next(row for row in rows if row["outcome"] == "Under")
    assert over["point"] == 799.5
    # -112 both ways is a coin flip once the vig is removed, so the posted
    # number needs no interpolation to be used as the 50% value.
    assert over["price"] == 100
    assert under["price"] == 100
    assert over["quoted_at"].isoformat() == "2026-08-23T02:33:44"


def test_underdog_devigs_an_unbalanced_line():
    payload = {
        **UNDERDOG,
        "over_under_lines": [ud_line("season_rush_yards", "799.5", "a-nfl", over="-134", under="+104")],
    }
    rows = parse_underdog_props(payload)

    over = next(row for row in rows if row["outcome"] == "Over")
    under = next(row for row in rows if row["outcome"] == "Under")
    # Raw prices sum past 1; the pair stored is complementary, so the two
    # sides describe one probability rather than two overlapping ones.
    assert fd._implied_probability(over["price"]) + fd._implied_probability(under["price"]) == pytest.approx(1.0, abs=0.01)
    assert over["price"] < 0  # the favorite side stays the favorite


def test_underdog_requires_both_sides_of_a_line():
    one_sided = ud_line("season_rush_yards", "799.5", "a-nfl")
    one_sided["options"] = one_sided["options"][:1]

    assert parse_underdog_props({**UNDERDOG, "over_under_lines": [one_sided]}) == []


def test_underdog_rejects_a_payload_without_lines():
    with pytest.raises(SeasonPropsError):
        parse_underdog_props({"players": [], "appearances": []})


def test_devig_normalizes_a_two_sided_pair():
    assert devig(0.5283, 0.5283) == pytest.approx(0.5)
    assert devig(0.6, 0.5) == pytest.approx(0.5454, abs=1e-4)
    assert devig(0.6, None) is None


# ── Polymarket ──────────────────────────────────────────────────────────


def pm_market(title, bid, ask, **overrides):
    market = {
        "groupItemTitle": title,
        "outcomes": '["Yes", "No"]',
        "bestBid": bid,
        "bestAsk": ask,
        "active": True,
        "closed": False,
        "archived": False,
        "acceptingOrders": True,
        "updatedAt": "2026-08-23T14:43:21.581070Z",
    }
    market.update(overrides)
    return market


def pm_event(name, category, markets, season="2026-27"):
    slug = f"{name.lower().replace(' ', '-')}-{category.lower().replace(' ', '-')}-{season}"
    return {
        "title": f"Pro Football: {name} {season} Regular Season {category}",
        "slug": slug,
        "markets": markets,
    }


POLYMARKET = [
    pm_event("Saquon Barkley", "Rushing Yards", [
        pm_market("899.5+ rushing yards", 0.65, 0.69),
        # The comma is part of the live formatting, not a typo.
        pm_market("1,099.5+ rushing yards", 0.47, 0.53),
    ]),
    # Season leader markets carry the same tag but a different shape.
    {"title": "Pro Football: 2026-27 Rushing Yards Leader", "slug": "rushing-yards-leader-2026-27",
     "markets": [pm_market("Saquon Barkley", 0.10, 0.14)]},
    # Next season's board is quoted alongside this one.
    pm_event("Saquon Barkley", "Rushing Yards", [pm_market("999.5+ rushing yards", 0.48, 0.52)], season="2027-28"),
]


def test_polymarket_reads_a_player_ladder_and_ignores_leader_markets():
    rows = parse_polymarket_props(POLYMARKET, 2026)

    assert {row["player_name_raw"] for row in rows} == {"Saquon Barkley"}
    assert {row["provider_player_id"] for row in rows} == {"saquon-barkley"}
    assert sorted({row["point"] for row in rows}) == [899.5, 1099.5]
    assert {row["market"] for row in rows} == {"season_rush_yds"}


def test_polymarket_keeps_only_the_requested_season():
    rows = parse_polymarket_props(POLYMARKET, 2027)

    # The 2027-28 board is the only one titled for that season.
    assert sorted({row["point"] for row in rows}) == [999.5]


def test_polymarket_skips_a_market_whose_outcomes_are_not_yes_first():
    # bestBid/bestAsk describe the first outcome. Read against a No-first
    # market they would invert the probability, and an inverted ladder is
    # still a plausible-looking curve — it would pass every later check.
    inverted = pm_event("Test Player", "Rushing Yards", [
        pm_market("899.5+ rushing yards", 0.65, 0.69, outcomes='["No", "Yes"]'),
    ])

    assert parse_polymarket_props([inverted], 2026) == []


def test_polymarket_skips_markets_that_are_not_open():
    closed = pm_event("Test Player", "Rushing Yards", [
        pm_market("899.5+ rushing yards", 0.65, 0.69, acceptingOrders=False),
        pm_market("999.5+ rushing yards", 0.55, 0.59, closed=True),
    ])

    assert parse_polymarket_props([closed], 2026) == []


def test_polymarket_drops_a_ladder_that_contradicts_itself():
    contradictory = pm_event("Test Player", "Receiving Yards", [
        pm_market("999.5+ receiving yards", 0.30, 0.36),
        pm_market("1,249.5+ receiving yards", 0.55, 0.61),
    ])

    assert parse_polymarket_props([contradictory], 2026) == []


def test_polymarket_rejects_a_payload_that_is_not_a_list():
    with pytest.raises(SeasonPropsError):
        parse_polymarket_props({"events": []}, 2026)


# ── Kalshi's stable player key and partial-failure tolerance ────────────


def test_kalshi_prefers_the_custom_strike_player_id():
    payload = {
        "KXNFLSEASONPASSYDS": [{
            "ticker": "KXNFLSEASONPASSYDS-27C3500-TSHOUGH6",
            "custom_strike": {"football_player": "2699489c-13e2", "football_team": "f7c2cd06"},
            "yes_sub_title": "Tyler Shough",
            "floor_strike": 3499.5,
            "yes_bid_dollars": "0.6200",
            "yes_ask_dollars": "0.6800",
            "status": "active",
            "updated_time": "2026-08-12T23:26:12.155834Z",
        }]
    }
    rows = parse_season_props(payload)

    # The UUID survives a ticker rename; the suffix is only the fallback.
    assert {row["provider_player_id"] for row in rows} == {"2699489c-13e2"}
    assert rows[0]["quoted_at"].isoformat() == "2026-08-12T23:26:12.155834"


def test_kalshi_survives_losing_one_series():
    class FlakyKalshi(KalshiClient):
        def _get_series(self, series_ticker):
            if series_ticker == "KXNFLSEASONPASSTDS":
                raise SeasonPropsError("boom")
            return []

    # Six categories behind one request each used to be six chances to lose
    # the whole fetch. Only losing every series is a provider outage.
    payload = FlakyKalshi().get_season_props()
    assert "KXNFLSEASONPASSTDS" not in payload
    assert "KXNFLSEASONPASSYDS" in payload


def test_kalshi_raises_when_every_series_fails():
    class DeadKalshi(KalshiClient):
        def _get_series(self, series_ticker):
            raise SeasonPropsError("boom")

    with pytest.raises(SeasonPropsError):
        DeadKalshi().get_season_props()


# ── the collector across providers ──────────────────────────────────────


class StubProvider:
    """A provider that answers with fixed rows, or refuses to answer."""

    def __init__(self, name, rows=None, error=None, configured=True):
        self.name = name
        self._rows = rows or []
        self._error = error
        self.configured = configured

    def collect(self, season):
        if self._error:
            raise self._error
        return self._rows


def row(name, market, point, price, outcome, bookmaker, provider_id="x"):
    return {
        "provider_player_id": provider_id,
        "player_name_raw": name,
        "bookmaker": bookmaker,
        "market": market,
        "outcome": outcome,
        "price": price,
        "point": point,
        "quoted_at": None,
    }


def pair(name, market, point, over_price, bookmaker, provider_id="x"):
    return [
        row(name, market, point, over_price, "Over", bookmaker, provider_id),
        row(name, market, point, -over_price, "Under", bookmaker, provider_id),
    ]


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
            player_id="wr1",
            full_name="Alpha Receiver",
            search_name=normalize_name("Alpha Receiver"),
            team="SEA",
            position="WR",
        )
    )
    session.commit()
    yield session
    session.rollback()
    session.close()


def test_collector_pools_every_provider(db):
    run = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", pair("Alpha Receiver", "season_rec_yds", 999.5, 100, "Kalshi")),
        StubProvider("Underdog", pair("Alpha Receiver", "season_rec_yds", 1099.5, 100, "Underdog")),
    ])

    assert run.status == "success"
    assert run.rows_written == 4
    # The run log names who actually answered, so a two-source board is not
    # later mistaken for a three-source one.
    assert run.source == "kalshi,underdog"
    assert {r.bookmaker for r in db.query(FantasySeasonPropSnapshot).all()} == {"Kalshi", "Underdog"}


def test_collector_survives_one_provider_going_dark(db):
    run = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", pair("Alpha Receiver", "season_rec_yds", 999.5, 100, "Kalshi")),
        StubProvider("Underdog", error=SeasonPropsError("HTTP 403")),
    ])

    # These are public endpoints nobody promised us. Losing one costs the
    # coverage only it had, not the board.
    assert run.status == "partial"
    assert run.rows_written == 2
    assert run.source == "kalshi"
    assert "Underdog: HTTP 403" in run.detail


def test_collector_errors_only_when_every_provider_fails(db):
    run = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", error=SeasonPropsError("timeout")),
        StubProvider("Underdog", error=SeasonPropsError("HTTP 403")),
    ])

    assert run.status == "error"
    assert "Kalshi: timeout" in run.detail and "Underdog: HTTP 403" in run.detail
    assert db.query(FantasySeasonPropSnapshot).count() == 0


def test_collector_ignores_providers_that_are_switched_off(db):
    run = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", pair("Alpha Receiver", "season_rec_yds", 999.5, 100, "Kalshi")),
        StubProvider("Underdog", pair("Alpha Receiver", "season_rec_yds", 1099.5, 100, "Underdog"), configured=False),
    ])

    assert run.status == "success"
    assert run.source == "kalshi"


# ── consensus across providers ──────────────────────────────────────────


def collect_from(db, *provider_rows):
    return fc.collect_season_props(db, providers=[
        StubProvider(name, rows) for name, rows in provider_rows
    ])


def test_board_takes_the_median_of_the_providers_quoting_a_player(db):
    # Three balanced quotes at three different numbers. The odd one out is a
    # ladder that has not traded in a week, which is the case this exists for.
    collect_from(
        db,
        ("Kalshi", pair("Alpha Receiver", "season_rec_yds", 1400.5, 100, "Kalshi")),
        ("Polymarket", pair("Alpha Receiver", "season_rec_yds", 1000.5, 100, "Polymarket")),
        ("Underdog", pair("Alpha Receiver", "season_rec_yds", 1050.5, 100, "Underdog")),
    )

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)
    leader = board["leaders"][0]

    assert leader["implied_value"] == 1050.5
    assert leader["books"] == ["Kalshi", "Polymarket", "Underdog"]
    assert leader["book_values"] == {
        "Kalshi": 1400.5, "Polymarket": 1000.5, "Underdog": 1050.5,
    }


def test_board_reports_each_providers_own_freshness(db):
    stale = pair("Alpha Receiver", "season_rec_yds", 1000.5, 100, "Kalshi")
    for entry in stale:
        entry["quoted_at"] = fc.utc_now().replace(year=2026, month=8, day=12)
    fresh = pair("Alpha Receiver", "season_rec_yds", 1050.5, 100, "Underdog")
    for entry in fresh:
        entry["quoted_at"] = fc.utc_now().replace(year=2026, month=8, day=23)
    collect_from(db, ("Kalshi", stale), ("Underdog", fresh))

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)

    # The collection run is minutes old either way. Only the provider's own
    # last movement says whether the price behind it is current.
    sources = {entry["bookmaker"]: entry["quoted_at"] for entry in board["sources"]}
    assert sources["Kalshi"].startswith("2026-08-12")
    assert sources["Underdog"].startswith("2026-08-23")
    assert board["source"] == "Kalshi, Underdog"


def test_headline_price_is_the_median_not_the_friendliest(db):
    # Every provider's price arrives de-vigged, so these are estimates of one
    # probability rather than competing offers. Taking the best of them would
    # not be line shopping, it would be picking the most optimistic source.
    collect_from(
        db,
        ("Kalshi", pair("Alpha Receiver", "season_rec_yds", 1000.5, 300, "Kalshi")),
        ("Polymarket", pair("Alpha Receiver", "season_rec_yds", 1000.5, 100, "Polymarket")),
        ("Underdog", pair("Alpha Receiver", "season_rec_yds", 1000.5, -150, "Underdog")),
    )

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)
    leader = board["leaders"][0]

    assert leader["over_price"] == 100
    assert leader["over_chance"] == 0.5


def test_a_provider_slope_is_never_borrowed_from_another(db):
    # Underdog posts one line per player and so has no ladder slope of its
    # own. Its quote here sits at 60% rather than even, which is exactly when
    # the extrapolation runs: with no slope the posted number stands, but a
    # slope borrowed from Kalshi's ladder (0.00125 per yard across 800.5 to
    # 1200.5) would push it 80 yards to 1130.5.
    collect_from(
        db,
        ("Kalshi", [
            *pair("Alpha Receiver", "season_rec_yds", 800.5, -300, "Kalshi"),
            *pair("Alpha Receiver", "season_rec_yds", 1200.5, 300, "Kalshi"),
        ]),
        ("Underdog", pair("Alpha Receiver", "season_rec_yds", 1050.5, -150, "Underdog")),
    )

    values = fd.get_season_prop_leaders(
        db, market="season_rec_yds", season=2026
    )["leaders"][0]["book_values"]

    assert values["Underdog"] == 1050.5
    assert values["Kalshi"] == pytest.approx(1000.5, abs=1.0)


def test_offense_rankings_add_implied_values_not_ladder_rungs(db):
    # A Kalshi rung at 1,000.5 and an Underdog line at 1,200.5 are not the
    # same kind of number. Ranking on whichever was the headline line would
    # rank teams on which provider happened to quote them.
    db.add(FantasyPlayer(
        player_id="qb1", full_name="Alpha Passer",
        search_name=normalize_name("Alpha Passer"), team="SEA", position="QB",
    ))
    db.commit()
    collect_from(
        db,
        ("Kalshi", [
            *pair("Alpha Passer", "season_pass_yds", 4000.5, 100, "Kalshi", "k1"),
            *pair("Alpha Receiver", "season_rush_yds", 1000.5, 100, "Kalshi", "k2"),
        ]),
        ("Underdog", [
            *pair("Alpha Passer", "season_pass_yds", 4200.5, 100, "Underdog", "u1"),
            *pair("Alpha Receiver", "season_rush_yds", 1200.5, 100, "Underdog", "u2"),
        ]),
    )

    board = fd.get_season_offense_leaders(db, season=2026)

    assert [row["team"] for row in board["yards"]] == ["SEA"]
    # Medians of each pair: 4100.5 through the air, 1100.5 on the ground.
    assert board["yards"][0]["air"] == 4100.5
    assert board["yards"][0]["ground"] == 1100.5
    assert board["yards"][0]["total"] == 5201.0


def test_clients_are_public_and_need_no_key():
    assert UnderdogClient().configured is True
    assert PolymarketClient().configured is True
    assert PolymarketClient().base_url.startswith("https://")


def test_player_card_credits_every_provider_behind_the_implied_value(db):
    # Underdog posts 1050.5 and Polymarket's ladder sits elsewhere. The card's
    # implied value is a median of both, so listing only the provider at the
    # headline line would credit one source for a two-source number.
    collect_from(
        db,
        ("Polymarket", [
            *pair("Alpha Receiver", "season_rec_yds", 899.5, -300, "Polymarket"),
            *pair("Alpha Receiver", "season_rec_yds", 1199.5, 300, "Polymarket"),
        ]),
        ("Underdog", pair("Alpha Receiver", "season_rec_yds", 1050.5, 100, "Underdog")),
    )

    card = fd.get_player_season_props(db, "wr1", season=2026)
    receiving = next(m for m in card["markets"] if m["market"] == "season_rec_yds")
    books = {entry["bookmaker"]: entry for entry in receiving["books"]}

    assert sorted(books) == ["Polymarket", "Underdog"]
    assert receiving["line"] == 1050.5
    # Polymarket interpolates to 1049.5; the median with Underdog is 1050.0.
    assert receiving["implied_value"] == 1050.0
    # Polymarket has a view on the market but no price at this exact number,
    # and saying so is more honest than borrowing one from its nearest rung.
    assert books["Polymarket"]["implied_value"] == pytest.approx(1049.5, abs=0.5)
    assert books["Polymarket"]["over_price"] is None
    assert books["Underdog"]["over_price"] == 100


def test_board_serves_a_degraded_run_rather_than_freezing(db):
    collect_from(db, ("Kalshi", pair("Alpha Receiver", "season_rec_yds", 900.5, 100, "Kalshi")))

    # Underdog dies. The next run is partial, but two providers still wrote a
    # perfectly usable board — and if it stayed dead, serving only successful
    # runs would pin the dashboard to this first snapshot forever.
    degraded = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", pair("Alpha Receiver", "season_rec_yds", 1100.5, 100, "Kalshi")),
        StubProvider("Underdog", error=SeasonPropsError("HTTP 403")),
    ])
    assert degraded.status == "partial"

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)
    assert board["leaders"][0]["implied_value"] == 1100.5


def test_a_run_that_wrote_nothing_never_replaces_a_real_board(db):
    collect_from(db, ("Kalshi", pair("Alpha Receiver", "season_rec_yds", 900.5, 100, "Kalshi")))

    # Nothing cleared the quote filter. That is also "partial", but there is
    # no board in it, so the last real one has to stand.
    empty = fc.collect_season_props(db, providers=[StubProvider("Kalshi", [])])
    assert empty.status == "partial" and empty.rows_written == 0

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)
    assert board["leaders"][0]["implied_value"] == 900.5


def test_a_run_nobody_matched_never_replaces_a_real_board(db):
    collect_from(db, ("Kalshi", pair("Alpha Receiver", "season_rec_yds", 900.5, 100, "Kalshi")))

    # Rows were stored, but under a name the catalog does not know. The run
    # has a row count and no board, and a board is what the reader needs.
    orphaned = fc.collect_season_props(db, providers=[
        StubProvider("Kalshi", pair("Nobody At All", "season_rec_yds", 1500.5, 100, "Kalshi")),
    ])
    assert orphaned.status == "partial" and orphaned.rows_written == 2

    board = fd.get_season_prop_leaders(db, market="season_rec_yds", season=2026)
    assert board["leaders"][0]["implied_value"] == 900.5
