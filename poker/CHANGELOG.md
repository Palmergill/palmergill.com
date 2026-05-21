# Changelog

All notable changes to the Texas Hold'em Poker app docs and active app wiring are tracked here.

The production poker app is currently the static frontend in `poker/` plus the shared backend router in `backend/app/routers/poker.py`.

## [Unreleased]

### Changed
- Updated docs for player-token validation, poker write rate limiting, current local static mounts, and Bitcoin Chat environment variables.
- Removed references to the deleted standalone poker backend service.
- Updated API documentation to list only endpoints exposed by the active shared backend.
- Updated architecture and task docs to remove stale claims about inactive production endpoints.

## Current Active Feature Set

The active root deployment supports:

- Single-player poker against five AI bots.
- Multiplayer lobby creation, joining, and host start.
- Polling-based game state updates.
- Fold, check, call, raise, buy-back, and next-hand actions.
- In-memory game state with one-hour inactivity cleanup.
- Static frontend themes, card deck themes, stats stored in browser storage, generated sound effects, haptics, mobile gestures, PWA manifest, and service worker.
