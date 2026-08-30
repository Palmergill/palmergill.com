"""Stock cache and live company-profile regression coverage."""

from datetime import timedelta

from app.database import EarningsRecord, SessionLocal, StockSummary
from app.services.polygon_client import PolygonClient
from app.services.stock_data_client import stock_data_client, utc_now


def setup_function():
    db = SessionLocal()
    try:
        db.query(EarningsRecord).filter(EarningsRecord.ticker == "CACHEFIX").delete()
        db.query(StockSummary).filter(StockSummary.ticker == "CACHEFIX").delete()
        db.commit()
    finally:
        db.close()


def test_combined_stock_cache_honors_the_one_minute_price_ttl():
    db = SessionLocal()
    try:
        db.add(StockSummary(
            ticker="CACHEFIX",
            name="Cache Fix Inc.",
            current_price=42.0,
            fetched_at=utc_now() - timedelta(minutes=2),
        ))
        db.commit()

        assert stock_data_client._get_cached_data("CACHEFIX", db) is None
        assert stock_data_client._get_cached_data("CACHEFIX", db, accept_stale=True) is not None
    finally:
        db.close()


def test_polygon_company_metadata_is_mapped_from_ticker_details():
    metadata = PolygonClient._company_metadata({
        "description": "Builds useful things.",
        "sic_code": "3571",
        "sic_description": "Electronic Computers",
        "total_employees": 1234,
        "list_date": "2001-02-03",
        "homepage_url": "https://example.com",
        "address": {
            "address1": "1 Main St",
            "city": "Austin",
            "state": "TX",
            "postal_code": "78701",
        },
    })

    assert metadata == {
        "description": "Builds useful things.",
        "industry": "Electronic Computers",
        "sector": "Manufacturing",
        "employees": 1234,
        "list_date": "2001-02-03",
        "headquarters": "1 Main St, Austin, TX, 78701",
        "website": "https://example.com",
    }


def test_company_metadata_survives_database_cache_round_trip():
    db = SessionLocal()
    try:
        result = stock_data_client._save_polygon_data("CACHEFIX", {
            "name": "Cache Fix Inc.",
            "description": "Builds useful things.",
            "industry": "Electronic Computers",
            "sector": "Manufacturing",
            "employees": 1234,
            "list_date": "2001-02-03",
            "headquarters": "Austin, TX",
            "website": "https://example.com",
            "current_price": 42.0,
            "earnings": [],
        }, db)

        assert result["description"] == "Builds useful things."
        assert result["industry"] == "Electronic Computers"
        assert result["sector"] == "Manufacturing"
        assert result["employees"] == 1234
        assert result["list_date"] == "2001-02-03"
        assert result["headquarters"] == "Austin, TX"
        assert result["website"] == "https://example.com"
    finally:
        db.close()
