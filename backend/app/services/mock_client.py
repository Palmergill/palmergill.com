"""
Mock Data Client - For Development & Testing

Returns realistic synthetic data without hitting external APIs.
Useful for development, testing, and avoiding rate limits.
"""

from datetime import date, datetime, timedelta
from typing import Dict, List, Optional
import random
import logging
import zlib

logger = logging.getLogger(__name__)


def _seeded_rng(*parts) -> random.Random:
    """Deterministic RNG for a ticker (and optional salt).

    Python's built-in hash() is salted per process, so seeding with it gave
    every server restart (and every worker) different demo numbers. crc32 is
    stable, so the same ticker shows the same values on every load.
    """
    key = "|".join(str(part) for part in parts)
    return random.Random(zlib.crc32(key.encode("utf-8")))


def _recent_quarter_ends(count: int, today: Optional[date] = None) -> List[date]:
    """Most recent completed calendar quarter-ends, newest first."""
    today = today or date.today()
    year = today.year
    # Last day of the previous completed quarter
    quarter = (today.month - 1) // 3  # 0..3 completed quarters this year
    if quarter == 0:
        year -= 1
        quarter = 4
    ends = []
    for _ in range(count):
        month = quarter * 3
        next_month_first = date(year + (month == 12), (month % 12) + 1, 1)
        ends.append(next_month_first - timedelta(days=1))
        quarter -= 1
        if quarter == 0:
            quarter = 4
            year -= 1
    return ends


class MockDataClient:
    """Mock client that returns realistic fake stock data."""
    
    # Mock data for popular tickers
    MOCK_COMPANIES = {
        "TSLA": {
            "name": "Tesla, Inc.",
            "sector": "Consumer Cyclical",
            "industry": "Auto Manufacturers",
            "description": "Tesla, Inc. designs, develops, manufactures, leases, and sells electric vehicles, and energy generation and storage systems in the United States, China, and internationally. The company was founded in 2003 and is headquartered in Austin, Texas. Tesla is accelerating the world's transition to sustainable energy with electric cars, solar and integrated renewable energy solutions.",
            "employees": 140473,
            "founded": "2003",
            "hq": "Austin, Texas",
            "website": "https://www.tesla.com",
            "market_cap": 1566415207400,
            "current_price": 417.44,
            "pe_ratio": 353.76,
            "revenue_growth": -3.14,
            "free_cash_flow": 3813000000,
            "profit_margin": 3.44,
            "operating_margin": 5.66,
            "gross_margin": 20.12,
            "roe": 1.03,
            "roa": 0.62,
            "roic": 1.58,
            "debt_to_equity": 0.66,
            "current_ratio": 2.16,
            "quick_ratio": 1.77,
            "ps_ratio": 8.5,
            "pb_ratio": 18.92,
            "ev_ebitda": 45.2,
            "enterprise_value": 1570000000000,
            "shares_outstanding": 3750000000,
            "working_capital": 36930000000,
            "cash": 28400000000,
            "beta": 2.1,
            "avg_volume": 51430000,
            "price_52w_high": 498.83,
            "price_52w_low": 214.25,
        },
        "AAPL": {
            "name": "Apple Inc.",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "description": "Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide. The company was founded in 1976 and is headquartered in Cupertino, California. Apple is one of the world's most valuable companies and is known for its iPhone, Mac, iPad, and services ecosystem.",
            "employees": 161000,
            "founded": "1976",
            "hq": "Cupertino, California",
            "website": "https://www.apple.com",
            "market_cap": 3755141989200,
            "current_price": 255.78,
            "pe_ratio": 32.3,
            "revenue_growth": 15.65,
            "free_cash_flow": 53925000000,
            "profit_margin": 29.28,
            "operating_margin": 35.37,
            "gross_margin": 48.16,
            "roe": 47.73,
            "roa": 11.1,
            "roic": 28.78,
            "debt_to_equity": 3.3,
            "current_ratio": 0.97,
            "quick_ratio": 0.94,
            "ps_ratio": 8.8,
            "pb_ratio": 42.58,
            "ev_ebitda": 24.5,
            "enterprise_value": 3843641989200,
            "shares_outstanding": 14681140000,
            "working_capital": -4263000000,
            "cash": 65000000000,
            "beta": 1.2,
            "avg_volume": 56291457,
            "price_52w_high": 288.62,
            "price_52w_low": 169.21,
        },
        "NVDA": {
            "name": "Nvidia Corp",
            "sector": "Technology",
            "market_cap": 4443197050000,
            "current_price": 182.81,
            "pe_ratio": 57.85,
            "revenue_growth": 89.77,
            "free_cash_flow": 23751000000,
            "profit_margin": 55.98,
            "operating_margin": 63.17,
            "gross_margin": 73.41,
            "roe": 26.84,
            "roa": 19.8,
            "roic": 28.27,
            "debt_to_equity": 0.36,
            "current_ratio": 4.47,
            "quick_ratio": 3.71,
            "ps_ratio": 25.3,
            "pb_ratio": 37.37,
            "ev_ebitda": 52.1,
            "enterprise_value": 4451664050000,
            "shares_outstanding": 24305000000,
            "working_capital": 90417000000,
            "cash": 25000000000,
            "beta": 1.8,
            "avg_volume": 161876983,
            "price_52w_high": 212.19,
            "price_52w_low": 86.62,
        },
        "MSFT": {
            "name": "Microsoft Corp",
            "sector": "Technology",
            "market_cap": 2980053460780,
            "current_price": 401.32,
            "pe_ratio": 25.0,
            "revenue_growth": 23.92,
            "free_cash_flow": 35758000000,
            "profit_margin": 47.32,
            "operating_margin": 47.09,
            "gross_margin": 68.92,
            "roe": 9.84,
            "roa": 8.5,
            "roic": 15.2,
            "debt_to_equity": 0.7,
            "current_ratio": 1.3,
            "quick_ratio": 1.25,
            "ps_ratio": 11.2,
            "pb_ratio": 10.5,
            "ev_ebitda": 19.8,
            "enterprise_value": 3050000000000,
            "shares_outstanding": 7425000000,
            "working_capital": 15000000000,
            "cash": 80000000000,
            "beta": 0.9,
            "avg_volume": 22000000,
            "price_52w_high": 555.45,
            "price_52w_low": 344.79,
        },
        "GOOGL": {
            "name": "Alphabet Inc.",
            "sector": "Technology",
            "market_cap": 2100000000000,
            "current_price": 165.50,
            "pe_ratio": 22.5,
            "revenue_growth": 12.5,
            "free_cash_flow": 42000000000,
            "profit_margin": 24.0,
            "operating_margin": 28.5,
            "gross_margin": 56.0,
            "roe": 18.5,
            "roa": 12.0,
            "roic": 16.0,
            "debt_to_equity": 0.2,
            "current_ratio": 2.5,
            "quick_ratio": 2.3,
            "ps_ratio": 5.8,
            "pb_ratio": 5.2,
            "ev_ebitda": 12.5,
            "enterprise_value": 2150000000000,
            "shares_outstanding": 12690000000,
            "working_capital": 85000000000,
            "cash": 95000000000,
            "beta": 1.05,
            "avg_volume": 25000000,
            "price_52w_high": 191.75,
            "price_52w_low": 130.25,
        },
        "AMZN": {
            "name": "Amazon.com Inc.",
            "sector": "Consumer Cyclical",
            "market_cap": 1950000000000,
            "current_price": 185.25,
            "pe_ratio": 58.0,
            "revenue_growth": 11.0,
            "free_cash_flow": 28000000000,
            "profit_margin": 6.5,
            "operating_margin": 8.2,
            "gross_margin": 47.0,
            "roe": 12.0,
            "roa": 4.5,
            "roic": 9.0,
            "debt_to_equity": 0.85,
            "current_ratio": 1.05,
            "quick_ratio": 0.95,
            "ps_ratio": 2.1,
            "pb_ratio": 6.8,
            "ev_ebitda": 18.5,
            "enterprise_value": 2020000000000,
            "shares_outstanding": 10520000000,
            "working_capital": 5000000000,
            "cash": 54000000000,
            "beta": 1.15,
            "avg_volume": 35000000,
            "price_52w_high": 242.52,
            "price_52w_low": 144.50,
        },
        "META": {
            "name": "Meta Platforms, Inc.",
            "sector": "Technology",
            "market_cap": 1618333699203,
            "current_price": 639.77,
            "pe_ratio": 26.69,
            "revenue_growth": 23.78,
            "free_cash_flow": 36214000000,
            "profit_margin": 38.01,
            "operating_margin": 41.32,
            "gross_margin": 80.5,
            "roe": 10.48,
            "roa": 9.2,
            "roic": 14.5,
            "debt_to_equity": 0.68,
            "current_ratio": 2.8,
            "quick_ratio": 2.6,
            "ps_ratio": 10.5,
            "pb_ratio": 8.2,
            "ev_ebitda": 15.2,
            "enterprise_value": 1650000000000,
            "shares_outstanding": 2528000000,
            "working_capital": 52000000000,
            "cash": 48000000000,
            "beta": 1.25,
            "avg_volume": 15000000,
            "price_52w_high": 796.25,
            "price_52w_low": 479.8,
        },
    }
    
    def __init__(self):
        self._cache = {}
        logger.info("[Mock] Initialized mock data client")
    
    def is_configured(self) -> bool:
        """Always configured - no API keys needed."""
        return True
    
    def get_stock_data(self, ticker: str) -> Optional[Dict]:
        """Get mock stock data for a ticker."""
        ticker = ticker.upper().strip()
        
        # Return mock data for known tickers, generate for unknown
        if ticker in self.MOCK_COMPANIES:
            company_data = self.MOCK_COMPANIES[ticker].copy()
        else:
            company_data = self._generate_random_company(ticker)
        
        # Generate earnings history
        earnings = self._generate_earnings(ticker, company_data)
        
        return {
            "ticker": ticker,
            "name": company_data["name"],
            "description": company_data.get("description", f"{company_data['name']} is a publicly traded company."),
            "industry": company_data.get("industry", company_data.get("sector", "-")),
            "sector": company_data.get("sector", "-"),
            "employees": company_data.get("employees"),
            "founded": company_data.get("founded", "-"),
            "hq": company_data.get("hq", "-"),
            "website": company_data.get("website"),
            "summary": {
                "ticker": ticker,
                "name": company_data["name"],
                "market_cap": company_data["market_cap"],
                "current_price": company_data["current_price"],
                "pe_ratio": company_data.get("pe_ratio"),
                "revenue_growth": company_data.get("revenue_growth"),
                "free_cash_flow": company_data.get("free_cash_flow"),
                "profit_margin": company_data.get("profit_margin"),
                "operating_margin": company_data.get("operating_margin"),
                "gross_margin": company_data.get("gross_margin"),
                "roe": company_data.get("roe"),
                "roa": company_data.get("roa"),
                "roic": company_data.get("roic"),
                "debt_to_equity": company_data.get("debt_to_equity"),
                "current_ratio": company_data.get("current_ratio"),
                "quick_ratio": company_data.get("quick_ratio"),
                "interest_coverage": company_data.get("interest_coverage"),
                "cash": company_data.get("cash"),
                "working_capital": company_data.get("working_capital"),
                "ps_ratio": company_data.get("ps_ratio"),
                "pb_ratio": company_data.get("pb_ratio"),
                "ev_ebitda": company_data.get("ev_ebitda"),
                "enterprise_value": company_data.get("enterprise_value"),
                "shares_outstanding": company_data.get("shares_outstanding"),
                "dividend_yield": company_data.get("dividend_yield"),
                "beta": company_data.get("beta"),
                "avg_volume": company_data.get("avg_volume"),
                "price_52w_high": company_data.get("price_52w_high"),
                "price_52w_low": company_data.get("price_52w_low"),
                "next_earnings_date": None,
            },
            "earnings": earnings,
            "price_history": [],
            "source": "Mock Data",
        }
    
    def get_price_history(self, ticker: str, days: int = 365) -> List[Dict]:
        """Generate mock price history that ends at the quoted current price.

        The walk is generated backwards from today's price so the chart, the
        header quote, and the day change all agree.
        """
        ticker = ticker.upper().strip()

        if ticker in self.MOCK_COMPANIES:
            end_price = self.MOCK_COMPANIES[ticker]["current_price"]
        else:
            end_price = self._generate_random_company(ticker)["current_price"]

        # Seed on ticker only so every range (1M..2Y) is a slice of one series.
        rng = _seeded_rng("prices", ticker)
        end_date = datetime.now()
        total_days = max(days, 730)

        dates = []
        for i in range(total_days):
            day = end_date - timedelta(days=i)
            if day.weekday() < 5:
                dates.append(day)

        closes = []
        price = end_price
        for _ in dates:
            closes.append(price)
            price = max(price / (1 + rng.uniform(-0.025, 0.026)), 1.0)

        prices = []
        cutoff = end_date - timedelta(days=days)
        for day, close in zip(reversed(dates), reversed(closes)):
            # Draw every day's values, then filter, so a 1M request is an
            # exact slice of the 2Y series.
            row = {
                "date": day.strftime("%Y-%m-%d"),
                "open": round(close * rng.uniform(0.99, 1.01), 2),
                "high": round(close * rng.uniform(1.0, 1.02), 2),
                "low": round(close * rng.uniform(0.98, 1.0), 2),
                "close": round(close, 2),
                "volume": int(rng.uniform(10000000, 100000000)),
            }
            if day > cutoff:
                prices.append(row)

        return prices

    def search_stocks(self, query: str, limit: int = 10) -> List[Dict]:
        """Search for stocks - returns mock results."""
        query = query.upper().strip()
        results = []
        
        for ticker, data in self.MOCK_COMPANIES.items():
            if query in ticker or query in data["name"].upper():
                results.append({
                    "ticker": ticker,
                    "name": data["name"],
                    "sector": data.get("sector", "Technology"),
                    "market_cap": data["market_cap"],
                })
        
        # If no matches, generate some fake ones
        if not results and len(query) <= 4:
            results = [
                {
                    "ticker": query,
                    "name": f"{query} Corporation",
                    "sector": "Technology",
                    "market_cap": _seeded_rng("search", query).randint(1000000000, 500000000000),
                }
            ]
        
        return results[:limit]
    
    def _generate_random_company(self, ticker: str) -> Dict:
        """Generate realistic random data for unknown tickers."""
        rng = _seeded_rng("company", ticker)
        base_price = rng.uniform(20, 800)
        market_cap = base_price * rng.uniform(1000000, 10000000000)
        
        sectors = ["Technology", "Healthcare", "Financials", "Consumer Cyclical", "Industrials", "Energy", "Utilities"]
        sector = rng.choice(sectors)
        
        return {
            "name": f"{ticker} Corporation",
            "sector": sector,
            "industry": f"{sector} Services",
            "description": f"{ticker} Corporation operates as a leading provider of {sector.lower()} solutions worldwide. The company delivers innovative products and services to customers across multiple markets.",
            "employees": rng.randint(1000, 500000),
            "founded": str(rng.randint(1950, 2015)),
            "hq": "United States",
            "website": f"https://www.{ticker.lower()}.com",
            "market_cap": market_cap,
            "current_price": base_price,
            "pe_ratio": rng.uniform(10, 100),
            "revenue_growth": rng.uniform(-20, 50),
            "free_cash_flow": rng.uniform(1000000, 50000000000),
            "profit_margin": rng.uniform(5, 40),
            "operating_margin": rng.uniform(8, 45),
            "gross_margin": rng.uniform(20, 80),
            "roe": rng.uniform(5, 50),
            "roa": rng.uniform(3, 25),
            "roic": rng.uniform(5, 30),
            "debt_to_equity": rng.uniform(0.1, 2.0),
            "current_ratio": rng.uniform(0.8, 3.5),
            "quick_ratio": rng.uniform(0.7, 3.0),
            "ps_ratio": rng.uniform(1, 30),
            "pb_ratio": rng.uniform(1, 50),
            "ev_ebitda": rng.uniform(8, 60),
            "enterprise_value": market_cap * rng.uniform(0.9, 1.2),
            "shares_outstanding": market_cap / base_price,
            "working_capital": rng.uniform(-10000000000, 50000000000),
            "cash": rng.uniform(1000000000, 100000000000),
            "beta": rng.uniform(0.5, 2.5),
            "avg_volume": rng.randint(5000000, 200000000),
            "price_52w_high": base_price * rng.uniform(1.1, 2.0),
            "price_52w_low": base_price * rng.uniform(0.4, 0.9),
        }
    
    def _generate_earnings(self, ticker: str, company_data: Dict) -> List[Dict]:
        """Generate eight quarters of earnings, newest first.

        Quarterly EPS is scaled so the trailing four quarters roughly match
        price / P/E, keeping the P/E chart and the headline P/E consistent.
        """
        rng = _seeded_rng("earnings", ticker)

        pe = company_data.get("pe_ratio") or 25
        price = company_data["current_price"]
        ttm_eps = price / pe if pe else 2.0
        shares = company_data.get("shares_outstanding") or 1e9
        # Revenue per dollar of earnings, fixed per company (margin proxy)
        revenue_multiple = rng.uniform(3.5, 8.0)

        quarter_ends = _recent_quarter_ends(8)
        # Build oldest -> newest with gentle growth toward today's TTM level
        eps_values = []
        level = ttm_eps / 4 * rng.uniform(0.7, 0.9)
        for _ in quarter_ends:
            level = max(level * (1 + rng.uniform(-0.08, 0.12)), 0.01)
            eps_values.append(level)
        recent_sum = sum(eps_values[-4:])
        scale = ttm_eps / recent_sum if recent_sum else 1
        eps_values = [value * scale for value in eps_values]

        earnings = []
        for quarter_end, eps in zip(reversed(quarter_ends), eps_values):
            estimated_eps = eps * rng.uniform(0.92, 1.06)
            surprise_pct = ((eps - estimated_eps) / estimated_eps) * 100
            net_income = eps * shares
            revenue = net_income * revenue_multiple * rng.uniform(0.95, 1.05)
            earnings.append({
                "fiscal_date": quarter_end.strftime("%Y-%m-%d"),
                "period": f"Q{(quarter_end.month - 1) // 3 + 1}",
                "reported_eps": round(eps, 2),
                "estimated_eps": round(estimated_eps, 2),
                "surprise_pct": round(surprise_pct, 2),
                "revenue": round(revenue, 0),
                "free_cash_flow": round(net_income * rng.uniform(0.6, 1.2), 0),
                "pe_ratio": None,
                "price": None,
            })

        earnings.reverse()
        return earnings


# Singleton instance
mock_data_client = MockDataClient()
