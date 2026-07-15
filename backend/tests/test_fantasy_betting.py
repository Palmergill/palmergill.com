"""Betting collector + read-layer tests. The Odds API client is always faked
(no network); covers the credit guard, event↔game matching, prop name
matching (including unmatched-name retention), futures, and the read helpers.
"""
import json

import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyFutureSnapshot,
    FantasyGame,
    FantasyMeta,
    FantasyOddsSnapshot,
    FantasyPlayer,
    FantasyPropSnapshot,
    SessionLocal,
    utc_now,
)
from app.services import fantasy_collector as fc
from app.services import fantasy_data as fd
from app.services.fantasy_common import normalize_name
from app.services.fantasy_odds import GAME_MARKETS, PROP_MARKETS

FF_MODELS = (
    FantasyFutureSnapshot,
    FantasyPropSnapshot,
    FantasyOddsSnapshot,
    FantasyGame,
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyMeta,
)

GAME_ODDS = [
    {
        "id": "evt1",
        "home_team": "Buffalo Bills",
        "away_team": "New York Jets",
        "commence_time": "2026-09-13T17:00:00Z",
        "bookmakers": [
            {"key": "dk", "markets": [
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
            ]}
        ],
    }
]

EVENT_PROPS = {
    "evt1": {
        "id": "evt1",
        "bookmakers": [
            {"key": "dk", "markets": [
                {"key": "player_pass_yds", "outcomes": [
                    {"name": "Over", "description": "Josh Allen", "price": -115, "point": 274.5},
                    {"name": "Under", "description": "Josh Allen", "price": -105, "point": 274.5},
                ]},
                {"key": "player_anytime_td", "outcomes": [
                    {"name": "Yes", "description": "James Cook", "price": 120},
                    {"name": "Yes", "description": "Ghost Player", "price": 300},
                ]},
            ]}
        ],
    }
}

FUTURES = {
    "americanfootball_nfl_super_bowl_winner": [
        {"bookmakers": [{"key": "dk", "markets": [{"key": "outrights", "outcomes": [
            {"name": "Buffalo Bills", "price": 650},
            {"name": "Kansas City Chiefs", "price": 500},
        ]}]}]}
    ]
}


class FakeOdds:
    def __init__(self, configured=True):
        self._configured = configured
        self.last_remaining = 321
        self.regions = "us"

    @property
    def configured(self):
        return self._configured

    @property
    def region_count(self):
        return 1

    def game_odds_cost(self, markets=GAME_MARKETS):
        return len(markets)

    def event_props_cost(self, markets=PROP_MARKETS):
        return len(markets)

    def futures_cost(self):
        return 1

    def get_game_odds(self, markets=GAME_MARKETS):
        return GAME_ODDS

    def get_event_props(self, event_id, markets=PROP_MARKETS):
        return EVENT_PROPS.get(event_id, {})

    def get_futures(self, market_key):
        return FUTURES.get(market_key, [])


@pytest.fixture
def db():
    session = SessionLocal()
    for model in FF_MODELS:
        session.query(model).delete()
    session.commit()
    # NFL state + a scheduled game matching evt1.
    fc.set_meta(session, "nfl_state", json.dumps({"season": 2026, "week": 2, "season_type": "regular"}))
    session.add(FantasyGame(
        game_id="2026_02_NYJ_BUF", season=2026, week=2,
        home_team="BUF", away_team="NYJ",
        kickoff=utc_now().replace(2026, 9, 13, 17, 0, 0),
    ))
    for pid, name, team in [("qb1", "Josh Allen", "BUF"), ("rb1", "James Cook", "BUF")]:
        session.add(FantasyPlayer(
            player_id=pid, full_name=name, search_name=normalize_name(name),
            team=team, position="QB" if pid == "qb1" else "RB",
        ))
    session.commit()
    yield session
    session.rollback()
    session.close()


def test_odds_jobs_skip_without_api_key(db):
    run = fc.collect_odds_lines(db, client=FakeOdds(configured=False))
    assert run.status == "skipped"
    assert "ODDS_API_KEY" in run.detail


def test_credit_guard_skips_when_budget_exhausted(db, monkeypatch):
    monkeypatch.setenv("ODDS_API_MONTHLY_BUDGET", "3")
    # Seed prior spend this month so only 2 credits remain; lines cost 3.
    prior = fc._start_run(db, "odds_lines", "the-odds-api")
    fc._finish_run(db, prior, "success", rows_written=1, credits_used=1)
    run = fc.collect_odds_lines(db, client=FakeOdds())
    assert run.status == "skipped"
    assert "budget" in run.detail


def test_collect_odds_lines_matches_event_to_game(db):
    run = fc.collect_odds_lines(db, client=FakeOdds())
    assert run.status == "success"
    assert run.credits_used == 3  # 3 markets x 1 region
    game = db.get(FantasyGame, "2026_02_NYJ_BUF")
    assert game.odds_event_id == "evt1"
    snaps = db.query(FantasyOddsSnapshot).filter_by(run_id=run.id).all()
    assert all(s.game_id == "2026_02_NYJ_BUF" for s in snaps)
    # x-requests-remaining recorded to meta.
    assert fc.get_meta(db, "odds_requests_remaining") == "321"


def test_collect_props_matches_names_and_retains_unmatched(db):
    fc.collect_odds_lines(db, client=FakeOdds())  # featured events come from here
    run = fc.collect_odds_props(db, client=FakeOdds(), limit=4)
    assert run.status == "success"
    props = db.query(FantasyPropSnapshot).filter_by(run_id=run.id).all()
    by_name = {p.player_name_raw: p for p in props}
    assert by_name["Josh Allen"].player_id == "qb1"
    assert by_name["James Cook"].player_id == "rb1"
    # Unmatched name is kept with a NULL player_id (no data dropped).
    assert "Ghost Player" in by_name
    assert by_name["Ghost Player"].player_id is None


def test_collect_futures_writes_snapshot(db):
    run = fc.collect_odds_futures(
        db, client=FakeOdds(), markets=("americanfootball_nfl_super_bowl_winner",)
    )
    assert run.status == "success"
    assert run.credits_used == 1  # single market x 1 region
    rows = db.query(FantasyFutureSnapshot).filter_by(run_id=run.id).all()
    assert {r.outcome for r in rows} == {"Buffalo Bills", "Kansas City Chiefs"}


def test_collect_futures_counts_a_credit_per_market_call(db):
    # Each market key is a separate API call and costs a credit even if some
    # return nothing (only super_bowl_winner is in the fixture).
    run = fc.collect_odds_futures(db, client=FakeOdds())
    assert run.credits_used == 3


# ── read layer ──────────────────────────────────────────────────────────


def test_get_games_returns_consensus_lines(db):
    fc.collect_odds_lines(db, client=FakeOdds())
    result = fd.get_games(db, season=2026, week=2)
    game = next(g for g in result["games"] if g["game_id"] == "2026_02_NYJ_BUF")
    assert game["lines"]["spread_home"] == -3.5
    assert game["lines"]["total"] == 45.5
    assert game["lines"]["moneyline_home"] == -160


def test_get_props_groups_by_game_and_resolves_names(db):
    fc.collect_odds_lines(db, client=FakeOdds())
    fc.collect_odds_props(db, client=FakeOdds(), limit=4)
    result = fd.get_props(db)
    assert len(result["featured"]) == 1
    featured = result["featured"][0]
    assert featured["home_team"] == "BUF"
    markets = {m["market"]: m for m in featured["markets"]}
    pass_line = next(l for l in markets["player_pass_yds"]["lines"] if l["player_name"] == "Josh Allen")
    assert pass_line["point"] == 274.5


def test_get_futures_sorted_by_price(db):
    fc.collect_odds_futures(db, client=FakeOdds())
    result = fd.get_futures(db)
    # Lowest (shortest) price first: Chiefs 500 before Bills 650.
    assert [o["outcome"] for o in result["outcomes"]] == ["Kansas City Chiefs", "Buffalo Bills"]


def test_player_detail_includes_props(db):
    fc.collect_odds_lines(db, client=FakeOdds())
    fc.collect_odds_props(db, client=FakeOdds(), limit=4)
    detail = fd.get_player_detail(db, "qb1")
    labels = {p["label"] for p in detail["props"]}
    assert "Pass yds" in labels
