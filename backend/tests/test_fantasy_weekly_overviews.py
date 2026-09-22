"""The weekly team overview: written by the scheduler on Tuesday morning.

There is no button any more — overviews are a recap of the week just played
and a look at the next one, and the only writer is ``run_scheduled``. What is
worth pinning is *when* it writes (the Tuesday window, never mid-week-being-
played) and that it writes each completed week exactly once.
"""
from datetime import datetime

import pytest

from app.database import FantasyMeta
from app.services import fantasy_ai
from app.services import fantasy_collector as C
from tests.test_fantasy_league_power_history import (  # noqa: F401 — fixtures
    auth_env,
    db,
    matchup,
    season_row,
)

# Sep 2026: the 22nd is a Tuesday.
MONDAY_NIGHT = datetime(2026, 9, 21, 23, 0)
TUESDAY_EARLY = datetime(2026, 9, 22, 6, 0)
TUESDAY_MORNING = datetime(2026, 9, 22, 12, 30)
FRIDAY = datetime(2026, 9, 25, 15, 0)
SUNDAY = datetime(2026, 9, 27, 18, 0)


@pytest.fixture
def calls(db, monkeypatch):
    db.query(FantasyMeta).filter(FantasyMeta.key.like("overviews:%")).delete(
        synchronize_session=False
    )
    db.commit()
    seen = []
    monkeypatch.setattr(
        fantasy_ai,
        "generate_weekly_overviews",
        lambda db, season, week: seen.append((season, week)) or {1: "local"},
    )
    yield seen
    db.query(FantasyMeta).filter(FantasyMeta.key.like("overviews:%")).delete(
        synchronize_session=False
    )
    db.commit()


@pytest.mark.parametrize(
    "now, expected",
    [
        (MONDAY_NIGHT, False),
        (TUESDAY_EARLY, False),
        (TUESDAY_MORNING, True),
        (FRIDAY, True),
        (SUNDAY, False),
    ],
)
def test_the_window_opens_tuesday_morning_and_closes_before_sunday(now, expected):
    assert C._in_overview_window(now) is expected


def test_tuesday_writes_the_week_just_finished(db, calls):
    season_row(db)
    matchup(db, 2026, 1, 1, 2)
    matchup(db, 2026, 2, 1, 2)
    matchup(db, 2026, 3, 1, 2, complete=False)
    db.commit()

    assert C._write_weekly_overviews(db, 2026, TUESDAY_MORNING) == 2
    assert calls == [(2026, 2)]


def test_each_week_is_written_once(db, calls):
    season_row(db)
    matchup(db, 2026, 1, 1, 2)
    db.commit()

    C._write_weekly_overviews(db, 2026, TUESDAY_MORNING)
    # The scheduler ticks all week; a second pass must not bill again.
    assert C._write_weekly_overviews(db, 2026, FRIDAY) is None
    assert calls == [(2026, 1)]


def test_a_missed_tuesday_catches_up_later_in_the_week(db, calls):
    season_row(db)
    matchup(db, 2026, 1, 1, 2)
    db.commit()

    assert C._write_weekly_overviews(db, 2026, FRIDAY) == 1


def test_nothing_is_written_outside_the_window_or_before_week_one(db, calls):
    season_row(db)
    db.commit()
    assert C._write_weekly_overviews(db, 2026, TUESDAY_MORNING) is None

    matchup(db, 2026, 1, 1, 2)
    db.commit()
    assert C._write_weekly_overviews(db, 2026, SUNDAY) is None
    assert calls == []
