# Spec 2 — Bitcoin Dashboard Redesign

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** draft
- **Depends on:** Spec 1 (warm tokens) for final styling; can develop in parallel
- **Areas:** `bitcoin-chat/` (index.html, app.js, style.css), `backend/app/routers/bitcoin.py`, `backend/app/services/bitcoin_*`

## Summary

Rework `/bitcoin-chat/` from a chat-first app into a live Bitcoin dashboard —
price chart and chain metrics as the primary surface, with the AI chat as a
side helper. Light fintech-editorial visual style, copy written for beginners.

## Background / current state

- The current app is chat-first: `bitcoin-chat/app.js` drives a conversation
  UI backed by `/api/bitcoin/*`.
- The backend already has the data plumbing the dashboard needs:
  `bitcoin_coingecko.py` (price/market data), `bitcoin_mempool_space.py`
  (mempool, fees, blocks), `bitcoin_rpc.py` (node data), `bitcoin_ai.py` +
  `bitcoin_tools.py` (chat with tool use), `bitcoin_formatting.py`.
- Demo mode works without credentials; live providers activate with keys.

## Goals

1. A visitor who knows nothing about Bitcoin can read the page and understand
   what each number means.
2. Price chart + core chain metrics load without any chat interaction.
3. Chat remains available as a contextual helper ("ask about this metric"),
   not the front door.

## Non-goals

- No portfolio tracking, alerts, or wallet features.
- No historical deep-dives beyond the price chart ranges (that is Spec 10).
- No new data providers — build on coingecko + mempool.space + existing RPC.

## Requirements

### Layout (top to bottom)

- **R1. Header strip:** current price, 24h change (signed, colored),
  market cap, last-updated timestamp.
- **R2. Price chart:** line chart with range tabs (1D / 7D / 30D / 1Y).
  Served from a new `GET /api/bitcoin/price-history?range=` endpoint that
  proxies and caches CoinGecko market-chart data.
- **R3. Chain metrics grid:** block height, avg fee (sat/vB with a
  plain-English cost estimate), mempool size, hashrate, next-halving
  countdown. Each card has a one-line beginner explanation and an
  "explain more" affordance that pre-fills the chat.
- **R4. Chat panel:** collapsible side panel (desktop) / bottom sheet
  (mobile). Existing chat endpoint unchanged. Suggested-question chips
  ("Why do fees change?", "What is the halving?").

### Behavior

- **R5.** Dashboard data refreshes on an interval (60s price, 5min chain
  metrics) with a visible "updated Ns ago" indicator; no refresh spinner
  takeover.
- **R6.** Demo mode (no credentials) serves cached/mock data through the
  existing mock plumbing so the page is never blank.
- **R7.** Provider failures degrade per-card (card shows "unavailable")
  rather than failing the whole page.

### Copy

- **R8.** All labels and explanations written at a beginner level; jargon
  (sat/vB, hashrate) always paired with a plain-English gloss. Copy reviewed
  in one pass at the end against a "would a first-time visitor get this"
  checklist.

## Technical design

- **Backend:** add `price-history` and a consolidated `GET /api/bitcoin/dashboard`
  endpoint to `routers/bitcoin.py` that fans out to coingecko/mempool services
  concurrently, caches for the refresh intervals in R5, and returns partial
  results with per-field status (supports R7).
- **Frontend:** keep vanilla JS in `bitcoin-chat/app.js` (consistent with the
  rest of the site). Chart rendered with a small dependency-free canvas/SVG
  renderer (the craps simulator already draws charts client-side — reuse the
  approach, or extract a tiny shared chart helper into `shared/` if both need
  it).
- **URL (decided Jul 2026):** `/bitcoin/` becomes the canonical path with a
  `vercel.json` redirect from `/bitcoin-chat/`, timed with this spec's ship;
  nav labels update to "Bitcoin Dashboard".

## Acceptance criteria

- [ ] Dashboard renders fully in demo mode with no credentials.
- [ ] All four chart ranges load in <1s from warm backend cache.
- [ ] Each metric card degrades independently when its provider is down
      (verify by pointing a provider at an invalid host locally).
- [ ] Chat opens pre-filled from a metric card's "explain" affordance.
- [ ] Mobile layout (375px): header, chart, cards stack; chat is a bottom
      sheet.
- [ ] README/ARCHITECTURE updated with the new endpoints.

## Risks

- **CoinGecko rate limits** on the free tier — mitigated by server-side
  caching (R5 intervals) so client count doesn't multiply upstream calls.
- **Chart scope creep** — the range tabs in R2 are the whole chart feature;
  candles, overlays, and indicators are explicitly out.

## Estimate

~3 weeks part-time: 1 week backend endpoints + caching, 2 weeks frontend
layout, chart, and copy.
