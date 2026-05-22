# Polygon.io API Integration Guide

**Version:** v1.0.3

**Last Updated:** May 22, 2026

**API Version:** Polygon REST endpoints used by `backend/app/services/polygon_client.py`

## Overview

Polygon.io is our primary data source for the Stock Research App. This document outlines all endpoints we use, their capabilities, rate limits, and potential future enhancements.

## Current Endpoints in Use

### 1. Ticker Search
**Endpoint:** `GET /v3/reference/tickers`

**Purpose:** Search active stock tickers by symbol or company name

**Used in:** `polygon_client.py::search_stocks()`

**Parameters we send:**
- `search` - User query
- `market=stocks`
- `active=true`
- `sort=ticker`
- `order=asc`
- `limit` - Defaults to 10

**Response fields we use:**
- `ticker`
- `name`
- `primary_exchange` - Displayed as the search result sector/fallback category

**Example:**
```bash
curl "https://api.polygon.io/v3/reference/tickers?search=TSLA&market=stocks&active=true&limit=10&apiKey=YOUR_KEY"
```

---

### 2. Ticker Details
**Endpoint:** `GET /v3/reference/tickers/{ticker}`

**Purpose:** Get company information and basic metrics

**Used in:** `polygon_client.py::_get_ticker_details()`

**Response fields we use:**
- `name` - Company name
- `market_cap` - Market capitalization
- `currency_name` - Currency (USD)
- `description` - Business description
- `homepage_url` - Company website
- `total_employees` - Employee count
- `list_date` - IPO date
- `weighted_shares_outstanding` - Shares outstanding

**Example:**
```bash
curl "https://api.polygon.io/v3/reference/tickers/TSLA?apiKey=YOUR_KEY"
```

---

### 3. Previous Close (Fallback Current Price)
**Endpoint:** `GET /v2/aggs/ticker/{ticker}/prev`

**Purpose:** Get the previous trading day's OHLCV data. The app now prefers the most recent daily aggregate from `_get_price_history()` for displayed price and uses previous close as a fallback.

**Used in:** `polygon_client.py::_get_previous_close()`

**Response fields we use:**
- `c` - Close price (current price)
- `h` - High
- `l` - Low
- `o` - Open
- `v` - Volume
- `vw` - Volume weighted average price

**Example:**
```bash
curl "https://api.polygon.io/v2/aggs/ticker/TSLA/prev?apiKey=YOUR_KEY"
```

---

### 4. Aggregates (Historical Prices)
**Endpoint:** `GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`

**Purpose:** Get historical price data for charts

**Used in:** `polygon_client.py::_get_price_history()`

**Parameters:**
- `multiplier` - Number of timespans (1)
- `timespan` - minute, hour, day, week, month, quarter, year
- `from` - Start date (YYYY-MM-DD)
- `to` - End date (YYYY-MM-DD)

**Response fields we use:**
- `results` - Array of OHLCV bars
- `t` - Timestamp, converted to `YYYY-MM-DD`
- `o`, `h`, `l`, `c`, `v` - Open, high, low, close, volume

**Example:**
```bash
# Get daily bars for last year
curl "https://api.polygon.io/v2/aggs/ticker/TSLA/range/1/day/2024-02-14/2025-02-14?apiKey=YOUR_KEY"
```

---

### 5. Financial Statements (Quarterly)
**Endpoint:** `GET /vX/reference/financials`

**Purpose:** Get quarterly financial statements (10-Q, 10-K)

**Used in:** `polygon_client.py::_get_financials()`

**Parameters:**
- `ticker` - Stock symbol
- `timeframe` - quarterly, annual
- `order` - `desc`
- `limit` - Number of results (we use 12, while most displayed history uses the latest 8 quarters)

**Response sections we use:**

#### Income Statement
- `revenues` - Total revenue
- `net_income_loss` - Net income
- `net_income_loss_attributable_to_parent` - Net income to common shareholders
- `basic_earnings_per_share` - EPS (our primary metric!)
- `diluted_earnings_per_share` - Diluted EPS
- `operating_income_loss` - Operating income
- `gross_profit` - Gross profit
- `cost_of_revenue` - COGS
- `operating_expenses` - OpEx
- `research_and_development` - R&D spend

#### Balance Sheet
- `assets` - Total assets
- `liabilities` - Total liabilities
- `equity` - Shareholder equity
- `equity_attributable_to_parent` - Common equity
- `current_assets` - Current assets
- `current_liabilities` - Current liabilities
- `long_term_debt` - Long-term debt
- `inventory` - Inventory
- `accounts_payable` - A/P

#### Cash Flow Statement
- `net_cash_flow_from_operating_activities` - Operating cash flow
- `net_cash_flow_from_investing_activities` - Investing cash flow
- `net_cash_flow_from_financing_activities` - Financing cash flow
- `net_cash_flow` - Total cash flow

#### Comprehensive Income
- `comprehensive_income_loss` - Comprehensive income

**Example:**
```bash
curl "https://api.polygon.io/vX/reference/financials?ticker=TSLA&timeframe=quarterly&limit=8&apiKey=YOUR_KEY"
```

**Notes:**
- This is our MOST IMPORTANT endpoint
- Provides all data for: EPS, Revenue, FCF, ROE, Debt/Equity calculations
- Financials are typically available 30-45 days after quarter end

---

## Calculated Metrics (Derived from Polygon Data)

We calculate these metrics ourselves using Polygon data:

| Metric | Calculation | Source Fields |
|--------|-------------|---------------|
| **P/E Ratio** | Price / TTM EPS | latest close / sum(4Q `basic_earnings_per_share`) |
| **Revenue Growth (YoY)** | (Q_now - Q_year_ago) / Q_year_ago × 100 | `revenues` current vs 4Q prior |
| **ROE** | TTM net income / latest equity × 100 | income statement + balance sheet |
| **ROA** | TTM net income / latest assets × 100 | income statement + balance sheet |
| **ROIC** | TTM operating income / invested capital × 100 | income statement + balance sheet |
| **Debt-to-Equity** | Debt or liabilities / equity | balance sheet |
| **Free Cash Flow** | Operating cash flow less capex when direct FCF is absent | cash flow statement |
| **Profit Margin** | TTM net income / TTM revenue × 100 | income statement |
| **Operating Margin** | TTM operating income / TTM revenue × 100 | income statement |
| **Gross Margin** | TTM gross profit / TTM revenue × 100 | income statement |
| **EBITDA Margin** | TTM EBITDA / TTM revenue × 100 | income statement |
| **P/S, P/B, EV/EBITDA** | Market cap or enterprise value ratios | ticker details, price, financials |
| **Current Ratio / Quick Ratio / Interest Coverage / Working Capital** | Balance-sheet and income-statement formulas | financials |

## Optional Finnhub Enhancement

When `FINNHUB_API_KEY` is configured, `stock_data_client.py` fetches earnings estimates from Finnhub and merges them into Polygon-derived earnings data. Polygon remains the primary source.

---

## Available But Unused Endpoints

These endpoints could enhance the app but aren't currently implemented:

### 1. Ticker News
**Endpoint:** `GET /v2/reference/news`

**Purpose:** Get news articles for a ticker

**Use case:** News feed in the app

**Example:**
```bash
curl "https://api.polygon.io/v2/reference/news?ticker=TSLA&limit=10&apiKey=YOUR_KEY"
```

---

### 2. Insider Transactions
**Endpoint:** `GET /vX/insiders-transactions`

**Purpose:** Get insider trading activity

**Use case:** Insider buying/selling signals

---

### 3. Analyst Ratings
**Endpoint:** `GET /vX/reference/analyst-ratings`

**Purpose:** Get analyst recommendations

**Use case:** Show buy/hold/sell ratings

---

### 4. Dividends
**Endpoint:** `GET /v3/reference/dividends`

**Purpose:** Get dividend history

**Use case:** Dividend yield calculation, history chart

---

### 5. Splits
**Endpoint:** `GET /v3/reference/splits`

**Purpose:** Get stock split history

**Use case:** Adjust historical prices

---

### 6. Market Holidays
**Endpoint:** `GET /v1/marketstatus/upcoming`

**Purpose:** Get upcoming market holidays

**Use case:** Show when market is closed

---

### 7. Market Status
**Endpoint:** `GET /v1/marketstatus/now`

**Purpose:** Check if market is open

**Use case:** Real-time market status indicator

---

### 8. Grouped Daily (All Tickers)
**Endpoint:** `GET /v2/aggs/grouped/locale/us/market/stocks/{date}`

**Purpose:** Get all stocks for a trading day

**Use case:** Market overview, top gainers/losers

---

### 9. Snapshot - All Tickers
**Endpoint:** `GET /v2/snapshot/locale/us/markets/stocks/tickers`

**Purpose:** Real-time data for all tickers

**Use case:** Market dashboard

---

### 10. Trades (Websocket)
**Endpoint:** WebSocket `/vX/trades`

**Purpose:** Real-time trade data

**Use case:** Real-time price updates (requires WebSocket implementation)

---

## Rate Limits by Plan

Polygon plan limits can change and should be checked against the active Polygon account. The app reduces pressure on the API with database caching and by reusing aggregate price history for both chart data and the 52-week range.

---

## Best Practices

### 1. Caching Strategy
- Price cache target: 1 minute
- Financials cache target: 24 hours
- Company-info cache target: 24 hours
- The combined stock summary currently uses the maximum configured TTL when deciding whether cached summary data is still usable.

### 2. Error Handling
- Always check for `status: "OK"` in responses
- Handle 429 (rate limit) with exponential backoff
- Serve stale cache on Polygon failure when available
- Fall back to mock data only when `ALLOW_MOCK_FALLBACK=true`

### 3. Data Freshness
- Financials: Available 30-45 days after quarter end
- Prices: Previous close is T-1 (yesterday's close)
- Real-time: Requires different endpoints (not used currently)

### 4. Cost Optimization
- Use aggregates endpoint with larger time spans to reduce calls
- Cache aggressively for historical data
- Only refresh on user action for expensive endpoints

---

## Potential Enhancements

### Short Term (Easy Wins)
1. **News Feed** - Add `/v2/reference/news` to show latest articles
2. **Market Status** - Show if market is open/closed
3. **Dividend History** - Chart of dividend payments over time
4. **Stock Splits** - Show split history

### Medium Term (More Work)
1. **Real-time Prices** - WebSocket for live price updates
2. **Analyst Ratings** - Show buy/hold/sell recommendations
3. **Insider Activity** - Track insider buying/selling
4. **Market Overview** - Show top gainers/losers for the day

### Long Term (Major Features)
1. **Options Data** - Options chain and Greeks
2. **Forex/Crypto** - Expand beyond stocks
3. **Fundamental Screener** - Filter stocks by metrics
4. **Portfolio Tracking** - Connect user portfolios

---

## API Response Examples

### Financials Response Structure
```json
{
  "results": [
    {
      "fiscal_date": "2025-12-31",
      "fiscal_period": "Q4",
      "fiscal_year": "2025",
      "financials": {
        "income_statement": {
          "revenues": {"value": 24901000000, "unit": "USD"},
          "net_income_loss": {"value": 856000000, "unit": "USD"},
          "basic_earnings_per_share": {"value": 0.26, "unit": "USD"}
        },
        "balance_sheet": {
          "assets": {"value": 137806000000, "unit": "USD"},
          "liabilities": {"value": 54941000000, "unit": "USD"},
          "equity": {"value": 82807000000, "unit": "USD"}
        },
        "cash_flow_statement": {
          "net_cash_flow_from_operating_activities": {"value": 3813000000, "unit": "USD"}
        }
      }
    }
  ]
}
```

### Aggregates Response Structure
```json
{
  "ticker": "TSLA",
  "results": [
    {
      "v": 123456789,  // Volume
      "vw": 417.50,    // VWAP
      "o": 415.00,     // Open
      "c": 417.44,     // Close
      "h": 420.00,     // High
      "l": 414.00,     // Low
      "t": 1707867600000  // Timestamp
    }
  ]
}
```

---

## Implementation Notes

### Field Name Variations
Polygon uses different field names for the same metric across endpoints. We handle this with fallback logic:

```python
# Example: Getting net income
for key in ["net_income_loss", "net_income", "net_income_loss_attributable_to_parent"]:
    value = income.get(key, {}).get("value")
    if value:
        break
```

### Date Handling
- Financials use `filing_date` or `period_of_report_date`
- Prices use Unix timestamps (milliseconds)
- Always convert to ISO format for consistency

### Error Responses
```json
{
  "status": "ERROR",
  "error": "Unknown API Key"
}
```

Always check status before processing data.

---

## Resources

- **Polygon Docs:** https://polygon.io/docs
- **API Status:** https://polygon.io/status
- **Support:** support@polygon.io
- **Pricing:** https://polygon.io/pricing

---

## Summary

**Currently using:** 5 endpoints

**Total available:** 40+ endpoints

**Utilization:** ~10% of Polygon's capabilities

**Key strength:** Financial statements endpoint provides incredibly detailed data that would require multiple API calls elsewhere.

**Next steps to maximize value:**
1. Add news feed
2. Show market status
3. Implement dividend tracking
4. Consider real-time WebSocket for premium users
