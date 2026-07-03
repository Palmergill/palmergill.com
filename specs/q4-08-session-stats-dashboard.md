# Spec 8 — Session Stats Dashboard

- **Quarter:** Q4 2026 (Oct–Dec)
- **Status:** draft
- **Depends on:** Spec 5 (recordSession audit + lobby), Spec 11 (rate limiting, if analytics volume grows)
- **Areas:** `shared/casino-profile.js`, `shared/analytics.js`, `casino/`, `admin/`

## Summary

Turn the casino's existing per-game session stats into a player-facing
history view (P/L over time, per-game breakdowns) on the `/casino/` lobby,
and give the site owner an aggregate usage view in `/admin/` fed by the
existing analytics ingest.

## Background / current state

- `shared/casino-profile.js` already accumulates per-game totals
  (handsPlayed, netProfit, biggestWin, sessionsRecorded, lastPlayed) in
  localStorage — totals only, no time series.
- `shared/analytics.js` (113 lines) already posts client events to the
  public `POST /api/analytics/events` endpoint; `/admin/` is a protected
  log dashboard reading `/api/admin/*`.
- Spec 5's lobby shows the aggregate numbers; this spec adds *history*.

## Goals

1. A player can see their P/L trajectory across sessions, per game and
   combined.
2. The site owner can see which games get played and how much, without any
   third-party analytics.
3. Privacy stance stays clean: player history is local-only; server
   analytics are anonymous and aggregate.

## Non-goals

- No accounts, no server-side storage of individual player history.
- No real-time admin dashboards; daily granularity is enough.
- No cookie banners needed — verify the design keeps it that way (no
  cross-session identifiers server-side).

## Requirements

### Player-facing history (local)

- **R1.** Extend `casino-profile.js` with a bounded session log: each
  `recordSession` call appends `{game, ts, handsPlayed, netProfit}` to a
  capped ring buffer (last 200 sessions) under a new localStorage key.
  Existing totals behavior unchanged; the log is additive.
- **R2.** Lobby "Stats" view renders from the log: cumulative P/L line
  (combined + per-game toggle), sessions table (date, game, hands, net),
  and the existing lifetime totals. Chart reuses the site's client-side
  chart approach (craps simulator / bitcoin dashboard).
- **R3.** Export button downloads the log as JSON; clear-history affordance
  with confirm (independent of bankroll reset).
- **R4.** Storage safety: respect the existing corrupt-blob recovery pattern
  in `casino-profile.js` (freeze writes on parse failure, preserve a
  `-corrupt` copy).

### Owner-facing usage (server, anonymous)

- **R5.** Games emit coarse analytics events through the existing
  `shared/analytics.js`: `game_session_start`, `game_session_end`
  (game, duration bucket, hands bucket — bucketed values, no exact P/L, no
  player identifiers beyond what analytics.js already sends).
- **R6.** `/admin/` gains a "Usage" panel: sessions per game per day (last
  30 days), served by a new protected `GET /api/admin/usage` that aggregates
  stored analytics events server-side.
- **R7.** Analytics remain fire-and-forget: event failures never affect
  gameplay (already the analytics.js contract — preserve it).

## Technical design

- **Session log:** new key `casino-session-log`, versioned entry shape
  `{v:1, game, ts, hands, net}`. Ring-buffer trim on write. Migration: none
  needed (log starts empty; totals carry history's summary).
- **Chart:** cumulative sum over log entries ordered by ts. With <2 sessions,
  show an empty-state explaining what will appear.
- **Backend:** `routers/analytics.py` already ingests; add aggregation in
  `routers/admin.py` (SQL GROUP BY day/game over the events table via
  `database.py`). Cap the query window at 90 days.
- **Payload discipline:** analytics event schema for R5 documented in
  `shared/analytics.js` header; server-side validation rejects unknown
  event names (ties into Spec 4's R5 tests and Spec 11's rate limiting).

## Acceptance criteria

- [ ] Play sessions in two games; lobby chart shows a combined cumulative
      line and correct per-game toggles; reload persists.
- [ ] 201st session evicts the oldest entry; totals still include evicted
      sessions (totals ≠ sum of log — document this in the UI copy as
      "recent sessions").
- [ ] Export produces valid JSON matching the on-screen table.
- [ ] Admin usage panel shows per-day counts after test sessions; endpoint
      rejects anonymous access.
- [ ] No exact bankroll or P/L values appear in any network request
      (verify in the network tab during play).
- [ ] Blocking `POST /api/analytics/events` (devtools) leaves gameplay and
      local stats fully functional.

## Risks

- **localStorage quota** with the log added to existing keys — bounded by
  the 200-entry cap (~20KB worst case); the existing `safeWrite` swallow
  behavior degrades gracefully anyway.
- **Analytics event sprawl** — the documented schema (R5) plus server-side
  unknown-event rejection keeps the events table meaningful.

## Estimate

~2 weeks part-time: 1 week player-facing log + chart, 1 week analytics
events + admin panel.
