# Poker Task List

This list tracks the poker app as it is currently wired into the root site. The active production API is the shared backend under `backend/app/`.

## Current Active Features

- [x] Static `/poker/` frontend with vanilla HTML/CSS/JS.
- [x] Single-player Texas Hold'em against five AI bots.
- [x] Multiplayer lobby create/join/start flow.
- [x] Polling-based game updates.
- [x] Player actions: fold, check, call, raise.
- [x] Buy-back flow for busted players between hands.
- [x] Next-hand flow after showdown.
- [x] In-memory game cleanup after one hour of inactivity.
- [x] PWA manifest and service worker.
- [x] Local browser stats via `localStorage`.
- [x] Sound effects, haptic turn notification, themes, card deck themes, and mobile gestures.
- [x] Root Jest utility tests for poker frontend helpers.

## High Priority

- [ ] Add API tests for the active shared poker router in `backend/app/routers/poker.py`.
- [ ] Verify the production `/poker/` frontend against the shared backend after each API change.

## Product/Backend Improvements

- [ ] Persist active games across backend restarts.
- [ ] Add optional user accounts or durable player sessions.
- [ ] Add server-side hand history if it is still a product goal.
- [ ] Add chat only after defining the shared backend API surface.
- [ ] Evaluate WebSockets for lower-latency multiplayer updates.
- [ ] Consider Redis or another shared store before horizontal scaling.

## Documentation

- [x] Update API docs to match the active shared backend.
- [x] Update architecture docs to explain the shared backend.
- [x] Update contributor setup to use the root `./start.sh` and root Jest test flow.
