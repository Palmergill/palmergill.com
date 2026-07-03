# Spec 10 — Bitcoin Historical Views

- **Quarter:** Q1 2027 (Jan–Mar)
- **Status:** draft
- **Depends on:** Spec 2 (dashboard redesign shipped; reuses its chart, cache, and copy voice)
- **Areas:** `bitcoin-chat/`, `backend/app/routers/bitcoin.py`, `backend/app/services/bitcoin_*`

## Summary

Extend the Bitcoin dashboard with a "History" section: full price history
with halving-cycle annotations, long-run chain metrics (hashrate, fees), and
an "explain this metric" pattern that routes curiosity into the existing
chat helper.

## Background / current state

- Spec 2 delivers the live dashboard: price chart (1D–1Y), chain metrics
  grid, chat side panel, `GET /api/bitcoin/dashboard` + `price-history`
  endpoints with server-side caching, beginner-voice copy.
- Providers in place: CoinGecko (price/market), mempool.space (fees,
  blocks, hashrate), optional node RPC.

## Goals

1. A visitor can see Bitcoin's whole arc — price across halving cycles —
   and understand what the halvings are.
2. Long-run metric charts (hashrate, fees) tell the "network growth" story
   alongside price.
3. Every historical view has a one-tap path to "explain what I'm looking
   at" via chat.

## Non-goals

- No price predictions, projections, or stock-to-flow-style model overlays.
- No per-address/on-chain forensics.
- No data warehousing — long-run series come from providers, cached, not
  self-archived.

## Requirements

### Halving-cycle price view

- **R1.** "All time" and "Cycle" range tabs added to the Spec 2 price chart.
  All-time is log-scale (with a linear toggle); halving dates
  (2012, 2016, 2020, 2024, next-estimated) render as labeled vertical
  markers.
- **R2.** Cycle view: price rebased from each halving date, overlaid, x-axis
  in days-since-halving — the classic cycle-comparison chart, drawn from the
  same all-time series client-side.
- **R3.** A short explainer block under the chart: what a halving is, why
  the marker dates matter, in the beginner voice. No claims about future
  price behavior — describe, don't predict.

### Long-run chain metrics

- **R4.** History section adds two charts: hashrate over time (all
  available), and average transaction fee over time (both USD and sat/vB
  toggle). Source: mempool.space historical endpoints via
  `bitcoin_mempool_space.py`.
- **R5.** Each chart carries a 2–3 sentence narrative gloss ("rising
  hashrate means more computing power securing the network").

### Explain-this pattern

- **R6.** Every history chart and the halving explainer has an "Ask about
  this" affordance that opens the chat panel pre-filled with a specific
  question, passing chart context (metric name, current range) so
  `bitcoin_ai.py` tools can ground the answer.
- **R7.** Chat suggested-question chips update contextually when the
  history section is in view.

### Data & caching

- **R8.** New backend endpoint `GET /api/bitcoin/history?metric=price|hashrate|fees&range=`
  with aggressive caching: historical series are immutable except the tail,
  so cache full-range responses for 24h and only refresh the recent window.
- **R9.** Demo mode: ship a checked-in fixture snapshot of the three series
  (updated occasionally by hand or by the Spec 9-style snapshot pattern) so
  the history section renders without credentials.

## Technical design

- Chart reuse: the Spec 2 renderer gains log-scale and vertical-marker
  support — keep it one shared helper rather than forking per view.
- Cycle rebase (R2) is client-side arithmetic over the all-time series;
  halving dates are constants in the frontend with the next-halving estimate
  served by the existing dashboard endpoint (block-height derived).
- CoinGecko free tier limits daily granularity on long ranges — acceptable;
  document granularity per range in the endpoint docstring.
- Page structure: History is a section below the live dashboard (same page,
  anchor-linked `#history`), not a separate route — keeps the app one
  surface.

## Acceptance criteria

- [ ] All-time log chart renders with 5 labeled halving markers; linear
      toggle works.
- [ ] Cycle overlay shows one line per completed cycle plus the current
      one, rebased to 100 at halving.
- [ ] Hashrate and fee charts render with unit toggles and glosses.
- [ ] "Ask about this" opens chat pre-filled and the answer references the
      metric in view.
- [ ] Full history section renders in demo mode from fixtures.
- [ ] 24h-cached history responses verified (second request served from
      cache; check logs/timing).
- [ ] Mobile: charts remain legible at 375px (fewer axis labels, same
      data).

## Risks

- **Provider historical-endpoint instability** (mempool.space API changes) —
  isolate parsing in `bitcoin_mempool_space.py` and fail per-chart like the
  Spec 2 per-card degradation.
- **Editorial drift into price commentary** — R3's "describe, don't
  predict" rule is the line; review copy against it before ship.

## Estimate

~3 weeks part-time: 1 week backend history endpoint + fixtures, 1 week
charts (log/markers/cycle), 1 week glosses, chat integration, polish.
