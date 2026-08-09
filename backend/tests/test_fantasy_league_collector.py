"""League collector tests: the ESPN client is always faked (no network).

Covers the three things that are easy to get wrong and expensive to notice
late — a private season must not poison the rest of the tick, the roster
digest must keep reads pointing at real rows, and upserts must not duplicate.
"""
import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyLeagueMatchup,
    FantasyLeagueMember,
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyMeta,
    FantasyPlayer,
    SessionLocal,
)
from app.services import fantasy_collector as fc
from app.services import fantasy_league_collector as lc
from app.services.fantasy_league_espn import EspnLeagueError, EspnLeagueUnauthorized

LEAGUE_MODELS = (
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueMatchup,
    FantasyLeagueTeam,
    FantasyLeagueMember,
    FantasyLeagueSeason,
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyMeta,
)


@pytest.fixture
def db():
    session = SessionLocal()
    for model in LEAGUE_MODELS:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    session.close()


def league_payload(entries=None):
    return {
        "scoringPeriodId": 5,
        "status": {"currentMatchupPeriod": 5},
        "settings": {
            "name": "The League",
            "size": 2,
            "scheduleSettings": {
                "matchupPeriodCount": 14,
                "divisions": [{"id": 0, "name": "East"}],
            },
            "rosterSettings": {"lineupSlotCounts": {"0": 1}},
        },
        "members": [
            {"id": "{G1}", "displayName": "Palmer Gill", "firstName": "Palmer"},
            {"id": "{G2}", "displayName": "Someone Else", "firstName": "Sam"},
        ],
        "teams": [
            {
                "id": 1,
                "name": "4th and 20",
                "abbrev": "P",
                "divisionId": 0,
                "owners": ["{G1}"],
                "record": {
                    "overall": {
                        "wins": 1,
                        "losses": 1,
                        "ties": 0,
                        "pointsFor": 200.0,
                        "pointsAgainst": 190.0,
                    }
                },
                "roster": {"entries": entries if entries is not None else DEFAULT_ENTRIES},
            },
            {
                "id": 2,
                "name": "Rivals",
                "abbrev": "R",
                "divisionId": 0,
                "owners": ["{G2}"],
                "record": {
                    "overall": {
                        "wins": 1,
                        "losses": 1,
                        "ties": 0,
                        "pointsFor": 190.0,
                        "pointsAgainst": 200.0,
                    }
                },
                "roster": {"entries": []},
            },
        ],
    }


DEFAULT_ENTRIES = [
    {
        "playerId": 4374302,
        "lineupSlotId": 0,
        "acquisitionType": "DRAFT",
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
        "playerId": 888777,
        "lineupSlotId": 20,
        "playerPoolEntry": {
            "player": {
                "id": 888777,
                "fullName": "Undrafted Rookie",
                "defaultPositionId": 2,
                "proTeamId": 6,
            }
        },
    },
]

SCHEDULE_PAYLOAD = {
    "schedule": [
        {
            "id": 1,
            "matchupPeriodId": 1,
            "winner": "HOME",
            "playoffTierType": "NONE",
            "home": {"teamId": 1, "totalPoints": 110.0, "pointsByScoringPeriod": {"1": 110.0}},
            "away": {"teamId": 2, "totalPoints": 90.0, "pointsByScoringPeriod": {"1": 90.0}},
        },
        {
            "id": 2,
            "matchupPeriodId": 2,
            "winner": "AWAY",
            "playoffTierType": "NONE",
            "home": {"teamId": 1, "totalPoints": 90.0, "pointsByScoringPeriod": {"2": 90.0}},
            "away": {"teamId": 2, "totalPoints": 100.0, "pointsByScoringPeriod": {"2": 100.0}},
        },
    ]
}


class FakeEspnLeagueClient:
    """Serves canned payloads, or raises for seasons configured to fail."""

    def __init__(self, payloads=None, errors=None):
        self.payloads = payloads or {}
        self.errors = errors or {}
        self.calls = []

    def _check(self, season):
        self.calls.append(season)
        error = self.errors.get(season)
        if error:
            raise error

    def get_league(self, season):
        self._check(season)
        return self.payloads.get(season, league_payload())

    def get_schedule(self, season):
        self._check(season)
        return SCHEDULE_PAYLOAD


def seed_players(db):
    db.add(
        FantasyPlayer(
            player_id="4035687",
            full_name="Amon-Ra St. Brown",
            position="WR",
            team="DET",
            espn_id="4374302",
        )
    )
    db.add(
        FantasyPlayer(
            player_id="DEN",
            full_name="Denver Broncos",
            position="DEF",
            team="DEN",
            espn_id=None,
        )
    )
    db.commit()


# ── the private-season path ─────────────────────────────────────────────


def test_unauthorized_season_is_skipped_not_errored(db):
    client = FakeEspnLeagueClient(
        errors={2025: EspnLeagueUnauthorized("ESPN returned 401 — not public")}
    )
    run = lc.collect_league_sync(db, 2025, client)

    # "skipped", not "error": a private season is a stable expected state and
    # marking it an error would make the run log look like a crash loop.
    assert run.status == "skipped"
    assert "401" in run.detail

    season_row = db.query(FantasyLeagueSeason).filter_by(season=2025).one()
    assert season_row.status == "unauthorized"
    assert season_row.last_error


def test_one_private_season_does_not_block_the_others(db):
    client = FakeEspnLeagueClient(
        errors={2025: EspnLeagueUnauthorized("not public")}
    )
    private = lc.collect_season(db, 2025, client)
    public = lc.collect_season(db, 2024, client)

    assert [run.status for run in private] == ["skipped"]
    assert [run.status for run in public] == ["success", "success", "success"]
    assert db.query(FantasyLeagueTeam).filter_by(season=2024).count() == 2


def test_transport_error_is_recorded_as_error(db):
    client = FakeEspnLeagueClient(errors={2024: EspnLeagueError("ESPN returned HTTP 503")})
    run = lc.collect_league_sync(db, 2024, client)
    assert run.status == "error"
    assert db.query(FantasyLeagueSeason).filter_by(season=2024).one().status == "error"


def test_rosters_and_rankings_are_skipped_when_sync_fails(db):
    client = FakeEspnLeagueClient(errors={2025: EspnLeagueUnauthorized("nope")})
    runs = lc.collect_season(db, 2025, client)
    assert len(runs) == 1  # no point snapshotting a season we could not read
    assert db.query(FantasyLeagueRosterEntry).count() == 0


# ── sync semantics ──────────────────────────────────────────────────────


def test_sync_writes_teams_members_and_matchups(db):
    client = FakeEspnLeagueClient()
    run = lc.collect_league_sync(db, 2024, client)

    assert run.status == "success"
    assert db.query(FantasyLeagueMember).filter_by(season=2024).count() == 2
    assert db.query(FantasyLeagueTeam).filter_by(season=2024).count() == 2
    assert db.query(FantasyLeagueMatchup).filter_by(season=2024).count() == 2

    team = db.query(FantasyLeagueTeam).filter_by(season=2024, espn_team_id=1).one()
    assert team.owner_name == "Palmer Gill"
    assert team.division_name == "East"

    season_row = db.query(FantasyLeagueSeason).filter_by(season=2024).one()
    assert season_row.status == "ok"
    assert season_row.name == "The League"
    assert season_row.current_scoring_period == 5


def test_resync_upserts_rather_than_duplicating(db):
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2024, client)
    lc.collect_league_sync(db, 2024, client)

    assert db.query(FantasyLeagueTeam).filter_by(season=2024).count() == 2
    assert db.query(FantasyLeagueMatchup).filter_by(season=2024).count() == 2
    assert db.query(FantasyLeagueMember).filter_by(season=2024).count() == 2
    assert db.query(FantasyLeagueSeason).filter_by(season=2024).count() == 1


def test_seasons_are_kept_separate(db):
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2023, client)
    lc.collect_league_sync(db, 2024, client)
    # ESPN team ids repeat across seasons, so the key must include the season.
    assert db.query(FantasyLeagueTeam).count() == 4


# ── roster snapshots and the crosswalk ──────────────────────────────────


def test_roster_snapshot_resolves_the_player_crosswalk(db):
    seed_players(db)
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2024, client)
    run = lc.collect_league_rosters(db, 2024, client)

    assert run.status == "success"
    entries = {
        entry.player_name_raw: entry
        for entry in db.query(FantasyLeagueRosterEntry).all()
    }

    # Skill player matches on espn_id.
    assert entries["Amon-Ra St. Brown"].player_id == "4035687"
    # Defense has no espn_id in Sleeper's dump; it resolves by team abbrev.
    assert entries["Broncos D/ST"].player_id == "DEN"
    # Unmatched players are kept with their raw name, never dropped.
    assert entries["Undrafted Rookie"].player_id is None
    assert entries["Undrafted Rookie"].player_name_raw == "Undrafted Rookie"
    assert "1 unmatched" in run.detail

    assert entries["Amon-Ra St. Brown"].scoring_period == 5


def test_unchanged_rosters_skip_the_write_but_reads_still_resolve(db):
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2024, client)
    first = lc.collect_league_rosters(db, 2024, client)
    second = lc.collect_league_rosters(db, 2024, client)

    assert first.status == "success" and first.rows_written == 3
    assert second.status == "skipped" and second.rows_written == 0
    assert db.query(FantasyLeagueRosterEntry).count() == 3

    # latest_successful_run filters on "success", so it still points at the
    # run that actually has rows — reads need no special case for the skip.
    latest = fc.latest_successful_run(db, "league_rosters", 2024)
    assert latest.id == first.id
    assert db.query(FantasyLeagueRosterEntry).filter_by(run_id=latest.id).count() == 3


def test_changed_rosters_write_a_new_snapshot_and_keep_the_old(db):
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2024, client)
    first = lc.collect_league_rosters(db, 2024, client)

    traded = [entry for entry in DEFAULT_ENTRIES if entry["playerId"] != 888777]
    client.payloads[2024] = league_payload(entries=traded)
    second = lc.collect_league_rosters(db, 2024, client)

    assert second.status == "success"
    assert second.id != first.id
    assert db.query(FantasyLeagueRosterEntry).filter_by(run_id=first.id).count() == 3
    assert db.query(FantasyLeagueRosterEntry).filter_by(run_id=second.id).count() == 2


def test_crosswalk_falls_back_to_name_when_espn_id_is_missing(db):
    """Sleeper leaves espn_id null for a large share of active players, so an
    id-only crosswalk resolves under half a roster. Name+team closes it."""
    db.add(
        FantasyPlayer(
            player_id="7547",
            full_name="Amon-Ra St. Brown",
            search_name="amon ra st brown",
            position="WR",
            team="DET",
            espn_id=None,
        )
    )
    db.commit()

    crosswalk = lc.PlayerCrosswalk(db)
    resolved = crosswalk.resolve(
        {
            "espn_id": "4374302",
            "player_name_raw": "Amon-Ra St. Brown",
            "pro_team": "DET",
        }
    )
    assert resolved == "7547"


def test_crosswalk_prefers_espn_id_over_name(db):
    db.add(
        FantasyPlayer(
            player_id="by-id",
            full_name="Mike Williams",
            search_name="mike williams",
            position="WR",
            team="NYJ",
            espn_id="123",
        )
    )
    db.add(
        FantasyPlayer(
            player_id="by-name",
            full_name="Mike Williams",
            search_name="mike williams",
            position="WR",
            team="LAC",
            espn_id=None,
        )
    )
    db.commit()

    crosswalk = lc.PlayerCrosswalk(db)
    assert (
        crosswalk.resolve(
            {"espn_id": "123", "player_name_raw": "Mike Williams", "pro_team": "LAC"}
        )
        == "by-id"
    )


def test_crosswalk_refuses_an_ambiguous_name(db):
    """Two players sharing a name is exactly when a wrong guess is worst, so
    an unresolvable name stays unresolved."""
    for suffix, team in (("a", "NYJ"), ("b", "LAC")):
        db.add(
            FantasyPlayer(
                player_id=f"dup-{suffix}",
                full_name="Mike Williams",
                search_name="mike williams",
                position="WR",
                team=team,
                espn_id=None,
            )
        )
    db.commit()

    crosswalk = lc.PlayerCrosswalk(db)
    # No team to disambiguate, two candidates -> no match.
    assert (
        crosswalk.resolve({"player_name_raw": "Mike Williams", "pro_team": None})
        is None
    )
    # With a team it resolves precisely.
    assert (
        crosswalk.resolve({"player_name_raw": "Mike Williams", "pro_team": "LAC"})
        == "dup-b"
    )


def test_crosswalk_normalizes_punctuation_and_suffixes(db):
    db.add(
        FantasyPlayer(
            player_id="6803",
            full_name="Travis Etienne Jr.",
            search_name="travis etienne",
            position="RB",
            team="NO",
            espn_id=None,
        )
    )
    db.commit()

    crosswalk = lc.PlayerCrosswalk(db)
    assert (
        crosswalk.resolve({"player_name_raw": "Travis Etienne Jr.", "pro_team": "NO"})
        == "6803"
    )


def test_digest_ignores_volatile_fields():
    """Only adds, drops, trades and lineup moves should invalidate a snapshot
    — not an injury designation flipping on a Friday."""
    base = [
        {"espn_team_id": 1, "espn_player_id": 5, "lineup_slot_id": 0},
    ]
    same_but_injured = [
        {"espn_team_id": 1, "espn_player_id": 5, "lineup_slot_id": 0, "injury_status": "OUT"},
    ]
    moved_to_bench = [
        {"espn_team_id": 1, "espn_player_id": 5, "lineup_slot_id": 20},
    ]
    assert lc._roster_digest(base) == lc._roster_digest(same_but_injured)
    assert lc._roster_digest(base) != lc._roster_digest(moved_to_bench)


def test_digest_is_order_independent():
    a = [
        {"espn_team_id": 1, "espn_player_id": 5, "lineup_slot_id": 0},
        {"espn_team_id": 1, "espn_player_id": 6, "lineup_slot_id": 20},
    ]
    assert lc._roster_digest(a) == lc._roster_digest(list(reversed(a)))


# ── power rankings ──────────────────────────────────────────────────────


def test_power_rankings_cover_every_week_and_algorithm(db):
    client = FakeEspnLeagueClient()
    lc.collect_league_sync(db, 2024, client)
    run = lc.build_league_power_rankings(db, 2024)

    assert run.status == "success"
    rows = db.query(FantasyLeaguePowerRanking).all()
    # 2 weeks x 7 algorithms x 2 teams
    assert len(rows) == 28
    assert {row.week for row in rows} == {1, 2}

    week_one = [r for r in rows if r.week == 1 and r.algorithm == "composite"]
    assert all(row.rank_delta is None for row in week_one)

    week_two = [r for r in rows if r.week == 2 and r.algorithm == "composite"]
    assert all(row.rank_delta is not None for row in week_two)


def test_power_rankings_skip_without_teams(db):
    run = lc.build_league_power_rankings(db, 2024)
    assert run.status == "skipped"


def test_power_rankings_skip_before_any_game_is_played(db):
    client = FakeEspnLeagueClient()
    client.payloads[2026] = league_payload()
    lc.collect_league_sync(db, 2026, client)
    db.query(FantasyLeagueMatchup).filter_by(season=2026).update(
        {"is_complete": False, "winner": "UNDECIDED"}
    )
    db.commit()

    run = lc.build_league_power_rankings(db, 2026)
    assert run.status == "skipped"
    assert "No completed games" in run.detail


# ── admin refresh routing ───────────────────────────────────────────────


def test_run_job_routes_league_jobs_with_an_explicit_season(db, monkeypatch):
    client = FakeEspnLeagueClient()
    monkeypatch.setattr(lc, "espn_league_client", client)

    run = fc.run_job(db, "league_sync", season=2023)
    assert run.status == "success"
    assert run.season == 2023
    assert db.query(FantasyLeagueTeam).filter_by(season=2023).count() == 2


def test_run_job_rejects_unknown_jobs(db):
    with pytest.raises(ValueError):
        fc.run_job(db, "league_nonsense")


def test_league_jobs_are_refreshable():
    for job in ("league_sync", "league_rosters", "league_rankings"):
        assert job in fc.REFRESHABLE_JOBS


# ── the scheduling gate ─────────────────────────────────────────────────


def defer_non_league_jobs(db):
    """Push every non-league job past its next-due stamp.

    run_scheduled drives the whole collector, and these tests only care about
    the league block — without this they would fetch Sleeper and nflverse for
    real.
    """
    from datetime import timedelta

    from app.database import utc_now

    later = (utc_now() + timedelta(days=30)).isoformat()
    for job in fc.JOB_INTERVALS_SECONDS:
        if not job.startswith("league_"):
            fc.set_meta(db, f"due:{job}", later)
    db.commit()


def test_league_collection_is_off_unless_a_league_id_is_configured(monkeypatch):
    """Without ESPN_LEAGUE_ID the scheduler must not touch the league.

    This is what keeps a fresh clone (or a test run) from quietly fetching a
    stranger's league over the network — the same self-skip the odds jobs do
    without ODDS_API_KEY.
    """
    monkeypatch.delenv("ESPN_LEAGUE_ID", raising=False)
    assert lc.league_seasons() == []

    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")
    assert lc.league_seasons() == [2023, 2024, 2025, 2026]


def test_run_scheduled_skips_the_league_when_disabled(db, monkeypatch):
    monkeypatch.delenv("ESPN_LEAGUE_ID", raising=False)
    defer_non_league_jobs(db)

    def explode(*args, **kwargs):
        raise AssertionError("the league must not be collected when disabled")

    monkeypatch.setattr(lc, "collect_season", explode)
    fc.run_scheduled(db)  # must not raise
    assert db.query(FantasyLeagueTeam).count() == 0


def test_run_scheduled_collects_every_configured_season(db, monkeypatch):
    client = FakeEspnLeagueClient()
    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")
    monkeypatch.setenv("ESPN_LEAGUE_SEASONS", "2023,2024")
    monkeypatch.setattr(lc, "espn_league_client", client)
    defer_non_league_jobs(db)

    summaries = fc.run_scheduled(db)
    league_jobs = [item for item in summaries if item["job"].startswith("league_")]

    assert {item["season"] for item in league_jobs} == {2023, 2024}
    assert db.query(FantasyLeagueTeam).count() == 4

    # Everything is now marked due in the future, so a second tick is a no-op.
    repeat = [
        item
        for item in fc.run_scheduled(db)
        if item["job"].startswith("league_")
    ]
    assert repeat == []


def test_run_scheduled_keeps_going_when_one_season_is_private(db, monkeypatch):
    client = FakeEspnLeagueClient(
        errors={2023: EspnLeagueUnauthorized("ESPN returned 401")}
    )
    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")
    monkeypatch.setenv("ESPN_LEAGUE_SEASONS", "2023,2024")
    monkeypatch.setattr(lc, "espn_league_client", client)
    defer_non_league_jobs(db)

    fc.run_scheduled(db)

    assert db.query(FantasyLeagueSeason).filter_by(season=2023).one().status == "unauthorized"
    assert db.query(FantasyLeagueSeason).filter_by(season=2024).one().status == "ok"
    assert db.query(FantasyLeagueTeam).filter_by(season=2024).count() == 2
