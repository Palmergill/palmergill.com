"""Player-news unit tests: parser shape validation and the per-player cache
(fresh cache -> no fetch, expiry -> refetch, fetch failure -> stale cache).
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.database import FantasyMeta, FantasyPlayer, SessionLocal
from app.services import fantasy_news
from app.services.fantasy_news import EspnNewsError, get_player_news, parse_news_items


@pytest.fixture
def db():
    session = SessionLocal()
    for model in (FantasyMeta, FantasyPlayer):
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    session.close()


class FakeEspn:
    def __init__(self, articles=None, error=None):
        self.articles = articles if articles is not None else []
        self.error = error
        self.calls = 0

    def get_player_news(self, espn_id, limit=6):
        self.calls += 1
        if self.error:
            raise self.error
        return self.articles


ARTICLE = {
    "headline": "Allen tops 2026 QB rankings",
    "description": "Season-long outlook.",
    "byline": "Staff",
    "url": "https://www.espn.com/story/1",
    "published_at": "2026-07-10T19:39:14Z",
    "premium": False,
}


def _seed_player(db, player_id="100", espn_id="3918298"):
    db.add(
        FantasyPlayer(
            player_id=player_id,
            full_name="Josh Allen",
            position="QB",
            team="BUF",
            espn_id=espn_id,
        )
    )
    db.commit()


def test_parse_news_items_validates_shape():
    payload = {
        "feed": [
            {  # good
                "headline": "Story one",
                "description": "desc",
                "byline": "Author",
                "published": "2026-07-10T19:39:14Z",
                "premium": True,
                "links": {"web": {"href": "https://www.espn.com/story/1"}},
            },
            {"links": {"web": {"href": "https://www.espn.com/story/2"}}},  # no headline
            {"headline": "No link at all"},
            {"headline": "Bad scheme", "links": {"web": {"href": "javascript:alert(1)"}}},
            "garbage",
        ]
    }
    articles = parse_news_items(payload)
    assert len(articles) == 1
    assert articles[0]["headline"] == "Story one"
    assert articles[0]["url"] == "https://www.espn.com/story/1"
    assert articles[0]["premium"] is True

    with pytest.raises(EspnNewsError):
        parse_news_items({"status": "success"})  # no feed list


def test_unknown_player_and_missing_espn_id(db):
    assert get_player_news(db, "zzz", client=FakeEspn()) is None

    _seed_player(db, player_id="200", espn_id=None)
    fake = FakeEspn(articles=[ARTICLE])
    news = get_player_news(db, "200", client=fake)
    assert news["articles"] == []
    assert fake.calls == 0  # nothing to look up without an espn_id


def test_fetch_then_cache_hit(db):
    _seed_player(db)
    fake = FakeEspn(articles=[ARTICLE])

    first = get_player_news(db, "100", client=fake)
    assert first["articles"][0]["headline"] == ARTICLE["headline"]
    assert first["as_of"] is not None
    assert fake.calls == 1

    second = get_player_news(db, "100", client=fake)
    assert second["articles"] == first["articles"]
    assert fake.calls == 1  # served from cache, no second fetch


def test_expired_cache_refetches(db):
    _seed_player(db)
    stale_time = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    db.add(
        FantasyMeta(
            key="news:100",
            value=json.dumps({"fetched_at": stale_time, "articles": [{"headline": "old"}]}),
        )
    )
    db.commit()

    fake = FakeEspn(articles=[ARTICLE])
    news = get_player_news(db, "100", client=fake)
    assert fake.calls == 1
    assert news["articles"][0]["headline"] == ARTICLE["headline"]


def test_fetch_failure_serves_stale_cache(db):
    _seed_player(db)
    stale_time = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    db.add(
        FantasyMeta(
            key="news:100",
            value=json.dumps({"fetched_at": stale_time, "articles": [ARTICLE]}),
        )
    )
    db.commit()

    fake = FakeEspn(error=EspnNewsError("down"))
    news = get_player_news(db, "100", client=fake)
    assert news["articles"] == [ARTICLE]  # stale beats nothing
    assert news["as_of"] == stale_time

    # No cache at all + failure -> empty, not an exception.
    db.query(FantasyMeta).delete()
    db.commit()
    empty = get_player_news(db, "100", client=fake)
    assert empty["articles"] == [] and empty["as_of"] is None
