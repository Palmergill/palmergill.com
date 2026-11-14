from fastapi.testclient import TestClient

from app.database import AnalyticsEvent, Base, CastleDefenseScore, SessionLocal, SiteCounter, engine
from app.main import app
from app.routers import analytics

client = TestClient(app)


def setup_function():
    Base.metadata.create_all(bind=engine)
    analytics._analytics_rate_limit_store.clear()
    db = SessionLocal()
    try:
        db.query(SiteCounter).delete()
        db.query(AnalyticsEvent).delete()
        # Games played also counts Castle Defense runs; other tests leave some.
        db.query(CastleDefenseScore).delete()
        db.commit()
    finally:
        db.close()


def test_stats_seed_from_existing_events_then_count_new_ones():
    db = SessionLocal()
    try:
        db.add_all([
            AnalyticsEvent(event_type="page_view", event_name="page_view"),
            AnalyticsEvent(event_type="page_view", event_name="page_view"),
            AnalyticsEvent(event_type="app_event", event_name="blackjack_round_completed"),
        ])
        db.commit()
    finally:
        db.close()

    assert client.get("/api/analytics/stats").json() == {"games_played": 1, "page_views": 2}

    client.post("/api/analytics/events", json={"event_type": "page_view", "event_name": "page_view"})
    client.post("/api/analytics/events", json={"event_type": "app_event", "event_name": "game_played", "metadata": {"game": "craps"}})
    client.post("/api/analytics/events", json={"event_type": "app_event", "event_name": "craps_roll_resolved"})

    assert client.get("/api/analytics/stats").json() == {"games_played": 2, "page_views": 3}


def test_counters_survive_analytics_retention_cleanup():
    client.post("/api/analytics/events", json={"event_type": "page_view", "event_name": "page_view"})
    db = SessionLocal()
    try:
        db.query(AnalyticsEvent).delete()
        db.commit()
    finally:
        db.close()
    assert client.get("/api/analytics/stats").json()["page_views"] == 1
