# Spec 9 — Stock Research Upgrades

- **Quarter:** Q1 2027 (Jan–Mar)
- **Status:** draft
- **Depends on:** Spec 4 (API contract tests), Spec 11 (rate limiting) recommended alongside
- **Areas:** `stock-research/` (app.js, watchlist.js, compare.js), `backend/app/routers/stocks.py`, `backend/app/services/` (finnhub, polygon, stock_data, mock_client)

## Summary

Deepen the stock research app from single-ticker lookups into a daily-use
tool: live watchlist quotes, chart-level comparison, basic fundamentals, and
a nightly server-side snapshot so demo mode always shows fresh real data.

## Background / current state

- `watchlist.js` already persists up to 16 tickers with last-seen price in
  localStorage and renders in the empty-state panel.
- `compare.js` already holds up to 4 tickers and renders a side-by-side
  *metric table* off the existing `GET /api/stocks/<ticker>` endpoint —
  but no comparison *chart*.
- Backend: `finnhub_client.py` and `polygon_client.py` behind
  `stock_data_client.py`, SQLite/Postgres cache via `stock_data.py` /
  `database.py`; `mock_client.py` powers demo mode without credentials.

## Goals

1. The watchlist is a living quote board, not a bookmark list.
2. Comparison shows normalized price performance on one chart, not just a
   table.
3. A ticker page answers "is this company expensive?" at a glance
   (fundamentals), not just "what's the price?"
4. Demo mode (no API keys) shows real market data from the latest nightly
   snapshot instead of synthetic mocks.

## Non-goals

- No portfolios, cost-basis tracking, or trade logging.
- No screeners or discovery features.
- No intraday/streaming quotes — daily-granularity refresh with on-demand
  fetch is the ceiling.
- No paid data-plan dependencies; everything fits free-tier provider limits.

## Requirements

### Watchlist v2

- **R1.** Watchlist entries refresh on page load via one batched
  `GET /api/stocks/quotes?tickers=A,B,C` endpoint (new; server fans out to
  the cache/provider): current price, day change %, sparkline of last 30
  days from cached history.
- **R2.** Sort options (name, day change, added order); drag-to-reorder is
  out (keep it simple).
- **R3.** Keep the 16-ticker cap and localStorage persistence; the batch
  endpoint enforces the same cap server-side.

### Comparison chart

- **R4.** `compare.js` gains a normalized performance chart: each ticker's
  price series rebased to 100 at the range start; ranges 1M / 6M / 1Y / 5Y.
  Existing metric table stays below the chart.
- **R5.** Data via existing per-ticker history endpoints (or extend to a
  range parameter if today's endpoint is fixed-window) — check
  `routers/stocks.py` first and extend, don't duplicate.

### Fundamentals

- **R6.** Ticker page adds a fundamentals card: market cap, P/E, EPS (TTM),
  dividend yield, 52-week range with current-price marker, sector. Source:
  whichever of Finnhub/Polygon exposes these on the free tier — resolve in a
  one-day spike before committing UI (both clients already exist).
- **R7.** Each metric gets the site-standard plain-English gloss (P/E:
  "price relative to yearly earnings — higher can mean expectations of
  growth, or just expensive").
- **R8.** Missing fundamentals (ETFs, foreign listings) render as "—" per
  field, never an error card.

### Nightly snapshot (demo-mode freshness)

- **R9.** A scheduled job (Railway cron hitting a protected
  `POST /api/admin/snapshot`, or an in-process scheduler — decide based on
  Railway plan capabilities) refreshes cached quotes + daily history for a
  curated list (~30 liquid tickers + everything on recent request logs) into
  the existing stock cache.
- **R10.** Demo mode serves from this cache with an "as of <date>" stamp
  instead of `mock_client` synthetic data; `mock_client` remains the
  fallback when the cache is empty (fresh local dev).

## Technical design

- **Batch endpoint:** new handler in `routers/stocks.py`; reuses
  `stock_data.py` caching so N watchlist clients don't multiply provider
  calls. Cache TTL ~15 min during market hours is fine at this scale.
- **Normalization** for R4 is client-side arithmetic over the history
  responses (rebase to 100) — no backend change beyond range support.
- **Snapshot job:** one function `refresh_snapshot(tickers)` in
  `stock_data.py`, callable from the admin endpoint and from tests with a
  mock client. Rate-limit aware: chunk requests to stay under free-tier
  per-minute caps; log a summary line per run for the admin dashboard.
- **Tests:** batch endpoint contract (per Spec 4 patterns), rebase math
  fixture, snapshot job with mock client asserting cache writes and
  rate-limit chunking.

## Acceptance criteria

- [ ] Watchlist with 5 tickers loads prices + sparklines in one network
      request (verify network tab).
- [ ] Compare chart: two tickers over 1Y, both series start at 100; table
      unchanged below.
- [ ] Fundamentals card renders for AAPL-class ticker and degrades to "—"
      for an ETF.
- [ ] With no API keys and a populated snapshot: app shows real data with
      the "as of" stamp; with empty cache it falls back to mock data.
- [ ] Snapshot run stays under provider free-tier limits (assert chunk
      timing in test; observe one real run's logs).
- [ ] New endpoints covered by contract tests; all suites green.

## Risks

- **Free-tier data gaps** (fundamentals coverage varies by provider) — the
  R6 spike resolves this before UI work; worst case the card ships with
  fewer fields.
- **Cron availability on Railway plan** — fallback is an in-process
  scheduler (e.g. asyncio task on startup) with a lock so multiple replicas
  don't double-run; decide during R9.

## Estimate

~4 weeks part-time: 1 week watchlist v2, 1 week compare chart, 1 week
fundamentals (incl. spike), 1 week snapshot job.
