"""Demo-mode stock data must be stable and internally consistent."""

from app.services.mock_client import MockDataClient, _recent_quarter_ends
from datetime import date


def test_same_ticker_returns_same_values():
    first = MockDataClient().get_stock_data("ZZQX")
    second = MockDataClient().get_stock_data("ZZQX")
    assert first["summary"] == second["summary"]
    assert first["earnings"] == second["earnings"]


def test_price_history_ends_at_quoted_price():
    client = MockDataClient()
    for ticker in ("AAPL", "ZZQX"):
        quote = client.get_stock_data(ticker)["summary"]["current_price"]
        history = client.get_price_history(ticker, days=365)
        assert history[-1]["close"] == round(quote, 2)


def test_short_range_is_a_slice_of_the_long_range():
    client = MockDataClient()
    long_range = client.get_price_history("AAPL", days=730)
    short_range = client.get_price_history("AAPL", days=30)
    assert short_range == long_range[-len(short_range):]


def test_trailing_eps_matches_stated_pe():
    data = MockDataClient().get_stock_data("AAPL")
    summary = data["summary"]
    ttm_eps = sum(quarter["reported_eps"] for quarter in data["earnings"][:4])
    implied_pe = summary["current_price"] / ttm_eps
    assert abs(implied_pe - summary["pe_ratio"]) / summary["pe_ratio"] < 0.02


def test_quarter_ends_are_completed_quarters():
    assert _recent_quarter_ends(3, today=date(2026, 10, 14)) == [
        date(2026, 9, 30),
        date(2026, 6, 30),
        date(2026, 3, 31),
    ]
    assert _recent_quarter_ends(1, today=date(2026, 2, 1)) == [date(2025, 12, 31)]
