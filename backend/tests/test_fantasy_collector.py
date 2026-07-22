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
    def __init__(self, players=None, state=None, projections=None, trending=None, season_projections=None):
        self._players = players or {}
        self._state = state or {"season": "2025", "week": 3, "season_type": "regular"}
        self._projections = projections or []
        self._season_projections = season_projections or []
        self._trending = trending or {"add": [], "drop": []}

    def get_players(self):
        return self._players

    def get_state(self):
        return self._state

    def get_projections(self, season, week, season_type="regular"):
        return parse_projection_rows(self._projections)

    def get_season_projections(self, season, season_type="regular"):
        return parse_projection_rows(self._season_projections)

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


class FakeFantasyPros:
    def __init__(self, projections=None):
        self._projections = projections or []

    def get_projections(self, season, week):
        return self._projections


class FakeEspnProjections:
    def __init__(self, projections=None):
        self._projections = projections or []

    def get_projections(self, season, week):
        return self._projections


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


def test_fantasypros_projections_match_players_by_name_and_team(db):
    _seed_players(db)
    client = FakeFantasyPros(
        [
            {
                "name": "Patrick Mahomes II",
                "team": "KC",
                "position": "QB",
                "pts_ppr": 27.5,
                "pts_half_ppr": 27.5,
                "pts_std": 27.5,
                "stats": {"points_ppr": 27.5},
            },
            {
                "name": "Unknown Player",
                "team": "FA",
                "position": "WR",
                "pts_ppr": 10,
                "pts_half_ppr": 9,
                "pts_std": 8,
                "stats": {},
            },
        ]
    )

    run = fc.collect_fantasypros_projections(db, 2025, 3, client=client)

    assert run.status == "success"
    assert run.rows_written == 1
    projection = db.query(FantasyProjection).filter_by(run_id=run.id).one()
    assert projection.player_id == "100"
    assert projection.source == "fantasypros"
    assert projection.pts_ppr == 27.5


def test_fantasypros_projections_normalize_defense_team_aliases(db):
    db.add(
        FantasyPlayer(
            player_id="JAX",
            full_name="Jacksonville Jaguars",
            search_name=normalize_name("Jacksonville Jaguars"),
            team="JAX",
            position="DEF",
        )
    )
    db.commit()
    client = FakeFantasyPros(
        [
            {
                "name": "Jacksonville Jaguars",
                "team": "JAC",
                "position": "DEF",
                "pts_ppr": 7.0,
                "pts_half_ppr": 7.0,
                "pts_std": 7.0,
                "stats": {"points": 7.0},
            }
        ]
    )

    run = fc.collect_fantasypros_projections(db, 2025, 3, client=client)

    assert run.status == "success"
    projection = db.query(FantasyProjection).filter_by(run_id=run.id).one()
    assert projection.player_id == "JAX"


def test_espn_projections_match_players_by_crosswalk_id(db):
    _seed_players(db)
    client = FakeEspnProjections(
        [
            {
                "espn_id": "3139477",
                "name": "Patrick Mahomes",
                "position": "QB",
                "pts_ppr": 26.0,
                "pts_half_ppr": 25.0,
                "pts_std": 24.0,
                "stats": {"espn_ppr": 26.0, "espn_standard": 24.0},
            }
        ]
    )

    run = fc.collect_espn_projections(db, 2025, 3, client=client)

    assert run.status == "success"
    projection = db.query(FantasyProjection).filter_by(run_id=run.id).one()
    assert projection.player_id == "100"
    assert projection.source == "espn"
    assert projection.pts_half_ppr == 25.0


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
    monkeypatch.setattr(fc, "espn_projection_client", FakeEspnProjections())

    summaries = fc.run_scheduled(db)
    jobs_ran = {s["job"] for s in summaries}
    assert {"state", "players", "projections", "rankings", "schedule", "trending"} <= jobs_ran
    # Rankings were derived from the projection snapshot taken this cycle.
    assert fc.latest_successful_run(db, "rankings", 2025, 3) is not None

    # Everything is now marked not-due, so a second immediate cycle is a no-op.
    assert fc.run_scheduled(db) == []


def test_run_scheduled_offseason_collects_season_long_rankings(db, monkeypatch):
    """Offseason (season_type=off): the cycle snapshots Sleeper's full-season
    projections for the upcoming season under week 0 and derives season-long
    rankings from them, instead of fetching a (nonexistent) weekly slate."""
    fake_sleeper = FakeSleeper(
        players=PLAYERS_DUMP,
        state={"season": "2026", "week": 0, "season_type": "off", "display_week": 0},
        season_projections=[
            {"player_id": "100", "stats": {"pts_ppr": 360.0, "pts_half_ppr": 360.0, "pts_std": 360.0}},
            {"player_id": "200", "stats": {"pts_ppr": 310.0, "pts_half_ppr": 290.0, "pts_std": 270.0}},
        ],
    )
    monkeypatch.setattr(fc, "sleeper_client", fake_sleeper)
    monkeypatch.setattr(fc, "nflverse_client", FakeNflverse())
    monkeypatch.setattr(fc, "espn_projection_client", FakeEspnProjections())

    summaries = fc.run_scheduled(db)
    proj = next(s for s in summaries if s["job"] == "projections")
    assert (proj["season"], proj["week"], proj["status"]) == (2026, fc.SEASON_LONG_WEEK, "success")
    assert proj["rows_written"] == 2

    rankings_run = fc.latest_successful_run(db, "rankings", 2026, fc.SEASON_LONG_WEEK)
    assert rankings_run is not None
    overall = (
        db.query(FantasyRanking)
        .filter_by(run_id=rankings_run.id, scoring="ppr", position="ALL")
        .order_by(FantasyRanking.rank)
        .all()
    )
    assert [r.player_id for r in overall] == ["100", "200"]
    # No weekly projection rows were written — only the week-0 snapshot.
    assert db.query(FantasyProjection).filter(FantasyProjection.week != 0).count() == 0


def test_new_provider_bootstraps_when_sleeper_is_not_due(db, monkeypatch):
    """A provider added after the shared timer was set should not wait for it."""
    now = fc.utc_now()
    fake_sleeper = FakeSleeper(
        players=PLAYERS_DUMP,
        state={"season": "2026", "week": 0, "season_type": "off", "display_week": 0},
    )
    fc.collect_state(db, client=fake_sleeper)
    fc.collect_players(db, client=fake_sleeper)

    # Reproduce an existing deployment whose original jobs (including the
    # shared Sleeper projection job) already have future next-due timestamps.
    future = (now + fc.timedelta(days=2)).isoformat()
    for job in fc.JOB_INTERVALS_SECONDS:
        fc.set_meta(db, f"{fc._DUE_META_PREFIX}{job}", future)
    db.commit()

    espn = FakeEspnProjections(
        [
            {
                "espn_id": "3139477",
                "name": "Patrick Mahomes",
                "position": "QB",
                "pts_ppr": 355.0,
                "pts_half_ppr": 355.0,
                "pts_std": 355.0,
                "stats": {},
            }
        ]
    )
    monkeypatch.setattr(fc, "espn_projection_client", espn)
    monkeypatch.setattr(fc, "fantasypros_client", type("Unavailable", (), {"available": False})())

    summaries = fc.run_scheduled(db, now=now)

    assert [(item["job"], item["rows_written"]) for item in summaries] == [
        ("projections", 1)
    ]
    run = fc.latest_successful_run(db, "projections", 2026, 0, source="espn")
    assert run is not None
    assert fc.get_meta(db, f"due:projections:espn:2026:0") is not None
    assert fc.run_scheduled(db, now=now) == []


def test_run_job_uses_season_long_week_in_offseason(db, monkeypatch):
    fake_sleeper = FakeSleeper(
        players=PLAYERS_DUMP,
        state={"season": "2026", "week": 0, "season_type": "off", "display_week": 0},
        season_projections=[
            {"player_id": "100", "stats": {"pts_ppr": 360.0, "pts_half_ppr": 360.0, "pts_std": 360.0}},
        ],
    )
    monkeypatch.setattr(fc, "sleeper_client", fake_sleeper)
    fc.collect_state(db, client=fake_sleeper)
    fc.collect_players(db, client=fake_sleeper)

    run = fc.run_job(db, "projections")
    assert (run.season, run.week, run.status) == (2026, fc.SEASON_LONG_WEEK, "success")
    rankings = fc.run_job(db, "rankings")
    assert (rankings.season, rankings.week, rankings.status) == (2026, fc.SEASON_LONG_WEEK, "success")
