"""Collector unit tests: source clients are always faked (no network), and we
assert snapshot semantics, upserts, name/id mapping, and derived rankings.
"""
import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyGame,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyRanking,
    FantasyTrendingSnapshot,
    SessionLocal,
    FantasyMeta,
)
from app.services import fantasy_collector as fc
from app.services.fantasy_common import normalize_name
from app.services.fantasy_sleeper import parse_projection_rows

FF_MODELS = (
    FantasyRanking,
    FantasyProjection,
    FantasyTrendingSnapshot,
    FantasyPlayerStat,
    FantasyGame,
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyMeta,
)


@pytest.fixture
def db():
    session = SessionLocal()
    for model in FF_MODELS:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    session.close()


# ── fakes ───────────────────────────────────────────────────────────────


class FakeSleeper:
    def __init__(self, players=None, state=None, projections=None, trending=None):
        self._players = players or {}
        self._state = state or {"season": "2025", "week": 3, "season_type": "regular"}
        self._projections = projections or []
        self._trending = trending or {"add": [], "drop": []}

    def get_players(self):
        return self._players

    def get_state(self):
        return self._state

    def get_projections(self, season, week, season_type="regular"):
        return parse_projection_rows(self._projections)

    def get_trending(self, kind, lookback_hours=24, limit=25):
        return self._trending[kind]


class FakeNflverse:
    def __init__(self, games=None, weekly=None):
        self._games = games or []
        self._weekly = weekly or []

    def get_schedule(self, season):
        return [g for g in self._games if g["season"] == season]

    def get_weekly_stats(self, season):
        return [r for r in self._weekly if r["season"] == season]


PLAYERS_DUMP = {
    "100": {
        "full_name": "Patrick Mahomes",
        "first_name": "Patrick",
        "last_name": "Mahomes",
        "position": "QB",
        "team": "KC",
        "gsis_id": "00-0033873",
        "espn_id": 3139477,
    },
    "200": {
        "full_name": "Justin Jefferson",
        "position": "WR",
        "team": "MIN",
        "gsis_id": "00-0036322",
    },
    "300": {
        "full_name": "Bijan Robinson",
        "position": "RB",
        "team": "ATL",
        "gsis_id": "00-0038542",
    },
    "900": {  # non-fantasy position — must be filtered out
        "full_name": "Some Lineman",
        "position": "OL",
        "team": "KC",
    },
}


def _seed_players(db):
    fc.collect_players(db, client=FakeSleeper(players=PLAYERS_DUMP))


# ── tests ───────────────────────────────────────────────────────────────


def test_normalize_name_handles_suffixes_initials_accents():
    assert normalize_name("Odell Beckham Jr.") == "odell beckham"
    assert normalize_name("D.J. Moore") == "dj moore"
    assert normalize_name("Amon-Ra St. Brown") == "amon ra st brown"
    assert normalize_name(None) == ""


def test_collect_players_filters_positions_and_upserts(db):
    run = fc.collect_players(db, client=FakeSleeper(players=PLAYERS_DUMP))
    assert run.status == "success"
    # OL filtered; three fantasy players stored.
    assert run.rows_written == 3
    assert db.query(FantasyPlayer).count() == 3
    mahomes = db.get(FantasyPlayer, "100")
    assert mahomes.gsis_id == "00-0033873"
    assert mahomes.espn_id == "3139477"
    assert mahomes.search_name == "patrick mahomes"

    # Second run with a changed team upserts in place (no duplicate rows).
    changed = {**PLAYERS_DUMP, "100": {**PLAYERS_DUMP["100"], "team": "NYJ"}}
    fc.collect_players(db, client=FakeSleeper(players=changed))
    assert db.query(FantasyPlayer).count() == 3
    assert db.get(FantasyPlayer, "100").team == "NYJ"


def test_projection_shape_validation_drops_bad_rows():
    payload = [
        {"player_id": "100", "stats": {"pts_ppr": 20.0}},
        {"player_id": "200"},  # no stats -> dropped
        {"stats": {"pts_ppr": 5}},  # no player_id -> dropped
        "garbage",  # not a dict -> dropped
    ]
    rows = parse_projection_rows(payload)
    assert [r["player_id"] for r in rows] == ["100"]
    # Dict-keyed payloads are also accepted.
    dict_payload = {"100": {"player_id": "100", "stats": {"pts_ppr": 20.0}}}
    assert len(parse_projection_rows(dict_payload)) == 1


def test_projections_snapshot_and_latest_resolution(db):
    _seed_players(db)
    projections = [
        {"player_id": "100", "stats": {"pts_ppr": 24.0, "pts_half_ppr": 24.0, "pts_std": 24.0}},
        {"player_id": "200", "stats": {"pts_ppr": 21.0, "pts_half_ppr": 18.5, "pts_std": 16.0}},
        {"player_id": "999", "stats": {"pts_ppr": 30.0}},  # unknown player -> skipped
    ]
    run1 = fc.collect_projections(db, 2025, 3, client=FakeSleeper(projections=projections))
    assert run1.status == "success"
    assert run1.rows_written == 2  # unknown player filtered

    # A second run creates a new snapshot; "latest" resolves to it.
    run2 = fc.collect_projections(db, 2025, 3, client=FakeSleeper(projections=projections))
    assert run2.id != run1.id
    latest = fc.latest_successful_run(db, "projections", 2025, 3)
    assert latest.id == run2.id
    # Both snapshots persist (history), 2 rows each.
    assert db.query(FantasyProjection).count() == 4


def test_derived_rankings_sorted_by_position(db):
    _seed_players(db)
    projections = [
        {"player_id": "100", "stats": {"pts_ppr": 24.0, "pts_half_ppr": 24.0, "pts_std": 24.0}},  # QB
        {"player_id": "200", "stats": {"pts_ppr": 21.0, "pts_half_ppr": 18.5, "pts_std": 16.0}},  # WR
        {"player_id": "300", "stats": {"pts_ppr": 19.0, "pts_half_ppr": 17.0, "pts_std": 15.0}},  # RB
    ]
    fc.collect_projections(db, 2025, 3, client=FakeSleeper(projections=projections))
    run = fc.build_derived_rankings(db, 2025, 3)
    assert run.status == "success"

    # Overall PPR order: Mahomes(24) > Jefferson(21) > Robinson(19).
    overall = (
        db.query(FantasyRanking)
        .filter_by(run_id=run.id, scoring="ppr", position="ALL")
        .order_by(FantasyRanking.rank)
        .all()
    )
    assert [r.player_id for r in overall] == ["100", "200", "300"]

    # FLEX excludes the QB.
    flex_ids = {
        r.player_id
        for r in db.query(FantasyRanking).filter_by(run_id=run.id, scoring="ppr", position="FLEX")
    }
    assert flex_ids == {"200", "300"}

    # Position lists are isolated and rank from 1.
    wr = db.query(FantasyRanking).filter_by(run_id=run.id, scoring="ppr", position="WR").all()
    assert len(wr) == 1 and wr[0].rank == 1 and wr[0].player_id == "200"


def test_weekly_stats_maps_gsis_and_derives_half_ppr(db):
    _seed_players(db)
    weekly = [
        {
            "gsis_id": "00-0036322",  # Jefferson
            "season": 2025,
            "week": 1,
            "team": "MIN",
            "position": "WR",
            "opponent": "GB",
            "fantasy_points_ppr": 30.0,
            "fantasy_points_half": None,
            "fantasy_points_std": 20.0,
            "stats": {"receptions": 10, "receiving_yards": 150},
        },
        {
            "gsis_id": "99-9999999",  # unknown gsis -> dropped
            "season": 2025,
            "week": 1,
            "fantasy_points_ppr": 5.0,
            "fantasy_points_half": None,
            "fantasy_points_std": 5.0,
            "stats": {},
        },
    ]
    run = fc.collect_weekly_stats(db, 2025, client=FakeNflverse(weekly=weekly))
    assert run.status == "success"
    assert run.rows_written == 1
    stat = db.query(FantasyPlayerStat).filter_by(player_id="200", week=1).one()
    assert stat.fantasy_points_ppr == 30.0


def test_schedule_upsert_is_idempotent(db):
    games = [
        {
            "game_id": "2025_01_BUF_NYJ",
            "season": 2025,
            "week": 1,
            "game_type": "REG",
            "kickoff": None,
            "home_team": "NYJ",
            "away_team": "BUF",
            "home_score": None,
            "away_score": None,
        }
    ]
    fc.collect_schedule(db, 2025, client=FakeNflverse(games=games))
    fc.collect_schedule(db, 2025, client=FakeNflverse(games=games))
    assert db.query(FantasyGame).count() == 1


def test_monthly_credits_used_sums_current_month(db):
    run = fc._start_run(db, "odds_props", "the-odds-api")
    fc._finish_run(db, run, "success", rows_written=3, credits_used=5)
    run2 = fc._start_run(db, "odds_lines", "the-odds-api")
    fc._finish_run(db, run2, "success", rows_written=3, credits_used=3)
    assert fc.monthly_credits_used(db) == 8


def test_run_scheduled_runs_due_jobs_and_sets_next_due(db, monkeypatch):
    fake_sleeper = FakeSleeper(
        players=PLAYERS_DUMP,
        projections=[
            {"player_id": "100", "stats": {"pts_ppr": 24.0, "pts_half_ppr": 24.0, "pts_std": 24.0}},
        ],
        trending={"add": [{"player_id": "300", "count": 500}], "drop": []},
    )
    fake_nflverse = FakeNflverse(
        games=[
            {
                "game_id": "2025_03_KC_BUF",
                "season": 2025,
                "week": 3,
                "game_type": "REG",
                "kickoff": None,
                "home_team": "BUF",
                "away_team": "KC",
                "home_score": None,
                "away_score": None,
            }
        ],
        weekly=[],
    )
    monkeypatch.setattr(fc, "sleeper_client", fake_sleeper)
    monkeypatch.setattr(fc, "nflverse_client", fake_nflverse)

    summaries = fc.run_scheduled(db)
    jobs_ran = {s["job"] for s in summaries}
    assert {"state", "players", "projections", "rankings", "schedule", "trending"} <= jobs_ran
    # Rankings were derived from the projection snapshot taken this cycle.
    assert fc.latest_successful_run(db, "rankings", 2025, 3) is not None

    # Everything is now marked not-due, so a second immediate cycle is a no-op.
    assert fc.run_scheduled(db) == []
