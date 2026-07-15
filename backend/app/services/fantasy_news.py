"""Recent-articles lookup for the player slide-over.

ESPN's fantasy news endpoint (site.api.espn.com, key-less) serves recent
stories tagged to a player, looked up by the espn_id already stored on
ff_players. Like the undocumented Sleeper endpoints, the payload is shape-
validated and malformed items are dropped rather than trusted.

Unlike the collectors this is fetched lazily — news for ~4k players can't
be snapshotted wholesale, so the read endpoint fetches on first view and
caches the parsed articles in ff_meta (one ``news:{player_id}`` key per
viewed player) for NEWS_CACHE_TTL_SECONDS. A failed refresh serves the
stale cache rather than erroring the drawer.
"""
import json
import logging
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.database import FantasyPlayer

logger = logging.getLogger(__name__)

NEWS_CACHE_TTL_SECONDS = int(os.getenv("FANTASY_NEWS_TTL_SECONDS", str(6 * 3600)))
NEWS_ARTICLE_LIMIT = 6
_CACHE_KEY_PREFIX = "news:"


class EspnNewsError(Exception):
    """Raised when ESPN cannot serve a news request."""


class EspnNewsClient:
    def __init__(self, api_base: Optional[str] = None, timeout: Optional[float] = None):
        self.api_base = (
            api_base
            or os.getenv("ESPN_NEWS_URL")
            or "https://site.api.espn.com/apis/fantasy/v2/games/ffl"
        ).rstrip("/")
        self.timeout = timeout or float(os.getenv("ESPN_NEWS_TIMEOUT_SECONDS", "10"))

    def get_player_news(self, espn_id: str, limit: int = NEWS_ARTICLE_LIMIT) -> List[Dict[str, Any]]:
        query = urllib.parse.urlencode({"playerId": espn_id, "limit": limit})
        request = urllib.request.Request(
            f"{self.api_base}/news/players?{query}",
            headers={"Accept": "application/json", "User-Agent": "palmergill-fantasy/1.0"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise EspnNewsError("Timed out waiting for ESPN news") from exc
        except urllib.error.HTTPError as exc:
            raise EspnNewsError(f"ESPN news returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise EspnNewsError(f"Could not reach ESPN news: {exc}") from exc

        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise EspnNewsError("ESPN news returned invalid JSON") from exc
        return parse_news_items(payload)


def parse_news_items(payload: Any) -> List[Dict[str, Any]]:
    """Validate and normalize an ESPN news payload.

    Each yielded article is {headline, description, byline, url,
    published_at, premium}. Items without a headline or an http(s) web link
    are dropped — the shape guard for an undocumented endpoint.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("feed"), list):
        raise EspnNewsError("ESPN news payload had no feed list")

    articles: List[Dict[str, Any]] = []
    for item in payload["feed"]:
        if not isinstance(item, dict):
            continue
        headline = item.get("headline") or item.get("title")
        links = item.get("links")
        url = None
        if isinstance(links, dict):
            web = links.get("web")
            if isinstance(web, dict):
                url = web.get("href")
        if not headline or not isinstance(url, str) or not url.startswith(("http://", "https://")):
            continue
        articles.append(
            {
                "headline": str(headline),
                "description": str(item.get("description") or "") or None,
                "byline": str(item.get("byline") or "") or None,
                "url": url,
                "published_at": str(item.get("published") or "") or None,
                "premium": bool(item.get("premium")),
            }
        )
    return articles


espn_news_client = EspnNewsClient()


def _read_cache(db: Session, player_id: str) -> Optional[Dict[str, Any]]:
    from app.services.fantasy_collector import get_meta

    raw = get_meta(db, f"{_CACHE_KEY_PREFIX}{player_id}")
    if not raw:
        return None
    try:
        cached = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(cached, dict) or not isinstance(cached.get("articles"), list):
        return None
    return cached


def _cache_age_seconds(cached: Dict[str, Any]) -> Optional[float]:
    try:
        fetched_at = datetime.fromisoformat(cached["fetched_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return (datetime.now(timezone.utc) - fetched_at).total_seconds()


def get_player_news(db: Session, player_id: str, client=None) -> Optional[Dict[str, Any]]:
    """Articles for one player: fresh cache, else live fetch, else stale cache.

    Returns None for an unknown player. Players without an espn_id (or with
    nothing written about them) get an empty articles list.
    """
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None

    result = {"player_id": player_id, "name": player.full_name, "as_of": None, "articles": []}
    if not player.espn_id:
        return result

    cached = _read_cache(db, player_id)
    age = _cache_age_seconds(cached) if cached else None
    if cached is not None and age is not None and age < NEWS_CACHE_TTL_SECONDS:
        result.update({"as_of": cached.get("fetched_at"), "articles": cached["articles"]})
        return result

    from app.services.fantasy_collector import set_meta

    client = client or espn_news_client
    try:
        articles = client.get_player_news(player.espn_id, limit=NEWS_ARTICLE_LIMIT)
    except Exception as exc:
        logger.warning("ESPN news fetch failed for %s (espn %s): %s", player_id, player.espn_id, exc)
        if cached is not None:  # stale beats nothing
            result.update({"as_of": cached.get("fetched_at"), "articles": cached["articles"]})
        return result

    fetched_at = datetime.now(timezone.utc).isoformat()
    set_meta(
        db,
        f"{_CACHE_KEY_PREFIX}{player_id}",
        json.dumps({"fetched_at": fetched_at, "articles": articles}),
    )
    db.commit()
    result.update({"as_of": fetched_at, "articles": articles})
    return result
