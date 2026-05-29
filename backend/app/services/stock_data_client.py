"""
Stock Data Client

This module provides unified access to stock data.
- Polygon.io: Production data source (default)
- Mock Data: Explicit local/dev fallback (set USE_REAL_DATA=false)
"""

from datetime import date, datetime, timedelta, timezone
from typing import Optional, List
import logging
import os

logger = logging.getLogger(__name__)

# Cache TTLs optimized for data type
CACHE_TTL = {
    "price": timedelta(minutes=1),
    "financials": timedelta(hours=24),
    "company_info": timedelta(hours=24),
}


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

def _env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _real_data_enabled() -> bool:
    if os.getenv("USE_REAL_DATA") is not None:
        return _env_flag("USE_REAL_DATA", True)
    if os.getenv("USE_MOCK_DATA") is not None:
        return not _env_flag("USE_MOCK_DATA", False)
    return True


# Use real data by default. Set USE_REAL_DATA=false for local mock mode.
USE_REAL_DATA = _real_data_enabled()
ALLOW_MOCK_FALLBACK = _env_flag("ALLOW_MOCK_FALLBACK", False)


class StockDataClient:
    """Primary stock data client with explicit real vs mock modes."""
    
    def __init__(self):
        self._polygon_client = None
        self._mock_client = None
        self._finnhub_client = None
    
    @property
    def polygon(self):
        """Lazy import of polygon client to avoid circular imports."""
        if self._polygon_client is None:
            from app.services.polygon_client import polygon_client
            self._polygon_client = polygon_client
        return self._polygon_client
    
    @property
    def mock(self):
        """Lazy import of mock client."""
        if self._mock_client is None:
            from app.services.mock_client import mock_data_client
            self._mock_client = mock_data_client
        return self._mock_client
    
    @property
    def finnhub(self):
        """Lazy import of Finnhub client for estimates."""
        if self._finnhub_client is None:
            from app.services.finnhub_client import finnhub_estimates_client
            self._finnhub_client = finnhub_estimates_client
        return self._finnhub_client
    
    def _use_mock(self) -> bool:
        """Check if we should use mock data."""
        return not USE_REAL_DATA

    def _require_real_data_configured(self):
        """Fail loudly when production real-data mode is missing its provider."""
        if not self.polygon.is_configured():
            raise RuntimeError(
                "Real stock data is enabled, but POLYGON_API_KEY is not configured"
            )
    
    def get_stock_data(self, ticker: str, db, force_refresh: bool = False) -> dict:
        """Get comprehensive stock data for a ticker."""
        from app.database import EarningsRecord, StockSummary
        
        ticker = ticker.upper().strip()
        
        # Use mock data only when explicitly configured.
        if self._use_mock():
            logger.info(f"[{ticker}] Using mock data")
            data = self.mock.get_stock_data(ticker)
            data["_mock"] = True
            return data

        self._require_real_data_configured()
        
        # Real data path (requires API keys)
        # Check cache unless force_refresh
        if not force_refresh:
            cached = self._get_cached_data(ticker, db)
            if cached:
                logger.info(f"[{ticker}] Serving from cache")
                return cached
        
        # Fetch fresh data from Polygon
        try:
            logger.info(f"[{ticker}] Fetching from Polygon.io")
            data = self.polygon.get_stock_data(ticker)
            
            # Fetch Finnhub earnings estimates and merge
            try:
                if self.finnhub.is_configured():
                    logger.info(f"[{ticker}] Fetching earnings estimates from Finnhub")
                    finnhub_estimates = self.finnhub.get_earnings_estimates(ticker)
                    if finnhub_estimates:
                        data["earnings"] = self.finnhub.merge_with_polygon(
                            data.get("earnings", []), 
                            finnhub_estimates
                        )
                        logger.info(f"[{ticker}] Merged Finnhub estimates into earnings data")
                else:
                    logger.debug(f"[{ticker}] Finnhub not configured, skipping estimates")
            except Exception as e:
                logger.warning(f"[{ticker}] Could not fetch Finnhub estimates: {e}")
                # Continue without estimates - not critical
            
            return self._save_polygon_data(ticker, data, db)
        except Exception as e:
            error_msg = str(e)
            logger.error(f"[{ticker}] Polygon API error: {error_msg}")
            
            # Try to serve stale cache
            stale_data = self._get_cached_data(ticker, db, accept_stale=True)
            if stale_data:
                hours_old = self._get_cache_age_hours(stale_data.get("_fetched_at"))
                stale_data["_warning"] = f"Using {hours_old}h old data - API error"
                return stale_data
            
            if ALLOW_MOCK_FALLBACK:
                logger.warning(f"[{ticker}] Falling back to mock data due to error")
                data = self.mock.get_stock_data(ticker)
                data["_mock"] = True
                data["_warning"] = f"Using mock data - API error: {error_msg}"
                return data

            raise RuntimeError(f"Real stock data unavailable: {error_msg}") from e

    def get_price_history(self, ticker: str, days: int = 365) -> List[dict]:
        """Get daily price history from the active stock data source."""
        ticker = ticker.upper().strip()

        if self._use_mock():
            return self.mock.get_price_history(ticker, days=days)

        self._require_real_data_configured()
        price_history = self.polygon._get_price_history(ticker, days=days)
        if not price_history:
            raise RuntimeError(f"Real price history unavailable for {ticker}")
        return price_history
    
    def _get_cached_data(self, ticker: str, db, accept_stale: bool = False):
        """Retrieve cached data from database."""
        from app.database import EarningsRecord, StockSummary
        
        summary = db.query(StockSummary).filter(StockSummary.ticker == ticker).first()
        if not summary:
            return None
        
        cache_age = utc_now() - summary.fetched_at
        max_ttl = max(CACHE_TTL.values())
        
        if not accept_stale and cache_age > max_ttl:
            return None
        
        earnings = db.query(EarningsRecord).filter(
            EarningsRecord.ticker == ticker
        ).order_by(EarningsRecord.fiscal_date.desc()).all()
        
        result = self._format_response(ticker, summary, earnings)
        result["_fetched_at"] = summary.fetched_at.isoformat()
        result["_cache_age_hours"] = round(cache_age.total_seconds() / 3600, 1)
        
        return result
    
    def _get_cache_age_hours(self, fetched_at_iso: Optional[str]) -> float:
        """Calculate cache age in hours."""
        if not fetched_at_iso:
            return 0
        try:
            fetched_at = datetime.fromisoformat(fetched_at_iso.replace('Z', '+00:00'))
            age = utc_now() - fetched_at.replace(tzinfo=None)
            return round(age.total_seconds() / 3600, 1)
        except Exception:
            return 0
    
    def _save_polygon_data(self, ticker: str, data: dict, db) -> dict:
        """Save Polygon.io data to database."""
        from app.database import EarningsRecord, StockSummary
        
        logger.info(f"[{ticker}] Saving data to database")
        
        # Delete old earnings
        db.query(EarningsRecord).filter(EarningsRecord.ticker == ticker).delete(
            synchronize_session=False
        )
        
        # Add new earnings records
        current_price = data.get("current_price") or 0
        for e in data.get("earnings", []):
            record = EarningsRecord(
                ticker=ticker,
                fiscal_date=self._parse_date(e.get("fiscal_date")) or utc_now().date(),
                period=e.get("period", "Q"),
                reported_eps=e.get("reported_eps"),
                estimated_eps=e.get("estimated_eps"),
                surprise_pct=e.get("surprise_pct"),
                revenue=e.get("revenue"),
                free_cash_flow=e.get("free_cash_flow"),
                pe_ratio=data.get("pe_ratio"),
                price=current_price
            )
            db.add(record)
        
        # Upsert summary
        summary_values = {
            "ticker": ticker,
            "name": data.get("name", ticker),
            "market_cap": data.get("market_cap"),
            "current_price": data.get("current_price"),
            "pe_ratio": data.get("pe_ratio"),
            "revenue_growth": data.get("revenue_growth"),
            "free_cash_flow": data.get("free_cash_flow"),
            "profit_margin": data.get("profit_margin"),
            "operating_margin": data.get("operating_margin"),
            "roe": data.get("roe"),
            "debt_to_equity": data.get("debt_to_equity"),
            "dividend_yield": data.get("dividend_yield"),
            "beta": data.get("beta"),
            "price_52w_high": data.get("price_52w_high"),
            "price_52w_low": data.get("price_52w_low"),
            "next_earnings_date": self._parse_date(data.get("next_earnings_date")),
            # New valuation metrics
            "ps_ratio": data.get("ps_ratio"),
            "pb_ratio": data.get("pb_ratio"),
            "ev_ebitda": data.get("ev_ebitda"),
            "enterprise_value": data.get("enterprise_value"),
            "shares_outstanding": data.get("shares_outstanding"),
            # Profitability metrics
            "gross_margin": data.get("gross_margin"),
            "ebitda_margin": data.get("ebitda_margin"),
            "roa": data.get("roa"),
            "roic": data.get("roic"),
            # Financial health metrics
            "current_ratio": data.get("current_ratio"),
            "quick_ratio": data.get("quick_ratio"),
            "interest_coverage": data.get("interest_coverage"),
            "cash": data.get("cash"),
            "working_capital": data.get("working_capital"),
            # Market data
            "avg_volume": data.get("avg_volume"),
            "fetched_at": utc_now()
        }
        
        summary = db.query(StockSummary).filter(StockSummary.ticker == ticker).first()
        if not summary:
            summary = StockSummary(ticker=ticker)
            db.add(summary)

        for key, value in summary_values.items():
            setattr(summary, key, value)

        db.commit()
        
        summary = db.query(StockSummary).filter(StockSummary.ticker == ticker).first()
        earnings = db.query(EarningsRecord).filter(
            EarningsRecord.ticker == ticker
        ).order_by(EarningsRecord.fiscal_date.desc()).all()
        
        return self._format_response(ticker, summary, earnings)

    def _parse_date(self, value) -> Optional[date]:
        """Parse API date values into database-safe date objects."""
        if not value:
            return None
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        if isinstance(value, str):
            try:
                return date.fromisoformat(value[:10])
            except ValueError:
                return None
        return None
    
    def _format_response(self, ticker: str, summary, earnings: List) -> dict:
        """Format database records into API response."""
        return {
            "ticker": ticker,
            "name": summary.name,
            "summary": {
                "ticker": ticker,
                "name": summary.name,
                "market_cap": summary.market_cap,
                "current_price": summary.current_price,
                "pe_ratio": summary.pe_ratio,
                "revenue_growth": summary.revenue_growth,
                "free_cash_flow": summary.free_cash_flow,
                "profit_margin": summary.profit_margin,
                "operating_margin": summary.operating_margin,
                "roe": summary.roe,
                "debt_to_equity": summary.debt_to_equity,
                "dividend_yield": summary.dividend_yield,
                "beta": summary.beta,
                "price_52w_high": summary.price_52w_high,
                "price_52w_low": summary.price_52w_low,
                "next_earnings_date": summary.next_earnings_date.isoformat() if summary.next_earnings_date else None,
                # New valuation metrics
                "ps_ratio": summary.ps_ratio,
                "pb_ratio": summary.pb_ratio,
                "ev_ebitda": summary.ev_ebitda,
                "enterprise_value": summary.enterprise_value,
                "shares_outstanding": summary.shares_outstanding,
                # Profitability metrics
                "gross_margin": summary.gross_margin,
                "ebitda_margin": summary.ebitda_margin,
                "roa": summary.roa,
                "roic": summary.roic,
                # Financial health metrics
                "current_ratio": summary.current_ratio,
                "quick_ratio": summary.quick_ratio,
                "interest_coverage": summary.interest_coverage,
                "cash": summary.cash,
                "working_capital": summary.working_capital,
                # Market data
                "avg_volume": summary.avg_volume,
            },
            "earnings": [
                {
                    "fiscal_date": e.fiscal_date.isoformat(),
                    "period": e.period,
                    "reported_eps": e.reported_eps,
                    "estimated_eps": e.estimated_eps,
                    "surprise_pct": e.surprise_pct,
                    "revenue": e.revenue,
                    "free_cash_flow": e.free_cash_flow,
                    "pe_ratio": e.pe_ratio,
                    "price": e.price
                }
                for e in sorted(earnings, key=lambda x: x.fiscal_date, reverse=True)
            ],
            "source": "Polygon.io",
            "cached_at": summary.fetched_at.isoformat() if summary.fetched_at else None
        }


# Singleton instance
stock_data_client = StockDataClient()
