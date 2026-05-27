# Poker Task List

This list tracks the poker app as it is currently wired into the root site. The active production API is the shared backend under `backend/app/`.

## Current Active Features

- [x] Static `/poker/` frontend with vanilla HTML/CSS/JS.
- [x] Single-player Texas Hold'em against five AI bots with named personality archetypes.
- [x] Single-table sit-and-go tournament mode with a 12-level blind schedule and elimination tracking.
- [x] Multiplayer lobby create/join/start flow.
- [x] WebSocket push channel for state-change notifications, with polling fallback.
- [x] Player actions: fold, check, call, raise.
- [x] Buy-back flow for busted players between hands.
- [x] Next-hand flow after showdown.
- [x] Database-backed game snapshots with an in-process cache; one-hour cleanup for inactive games.
- [x] PWA manifest and service worker.
- [x] Local browser stats via `localStorage`, including a per-session hand history panel.
- [x] Sound effects, haptic turn notification, themes, card deck themes, and mobile gestures.
- [x] Root Jest utility tests for poker frontend helpers.

## High Priority

- [ ] Add API tests for the active shared poker router in `backend/app/routers/poker.py`.
- [ ] Verify the production `/poker/` frontend against the shared backend after each API change.

## Product/Backend Improvements

- [x] Persist active games across backend restarts (DB snapshot per mutation).
- [ ] Add optional user accounts or durable player sessions.
- [x] Per-session hand history (client-side, last 20 hands).
- [ ] Add server-side hand history if it is still a product goal.
- [ ] Add chat only after defining the shared backend API surface.
- [x] WebSocket push channel for lower-latency multiplayer updates (polling stays as fallback).
- [ ] Consider Redis or another shared store before horizontal scaling.

## Documentation

- [x] Update API docs to match the active shared backend.
- [x] Update architecture docs to explain the shared backend.
- [x] Update contributor setup to use the root `./start.sh` and root Jest test flow.
