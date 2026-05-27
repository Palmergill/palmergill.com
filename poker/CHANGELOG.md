# Changelog

All notable changes to the Texas Hold'em Poker app docs and active app wiring are tracked here.

The production poker app is currently the static frontend in `poker/` plus the shared backend router in `backend/app/routers/poker.py`.

## [Unreleased]

### Added
- Single-table sit-and-go tournament mode with a 12-level blind schedule and elimination tracking.
- AI personalities (TAG, LP, Maniac, Rock, Std) with looseness/aggression dials surfaced as opponent labels.
- WebSocket push channel `/api/poker/games/{game_id}/ws` for state-change notifications, with polling kept as a 3s-cadence fallback.
- Database-backed snapshots of active games so a fresh backend process can recover an in-flight game by `game_id` and player token until inactivity cleanup removes it.
- Per-session client-side hand history (last 20 hands) shown in the stats modal.

### Changed
- Updated docs for the current stock/Bitcoin public-demo auth model, mempool.space as Bitcoin Chat's default live provider, and the current poker AI/CSRF compatibility endpoints.
- Updated docs for player-token validation, poker write rate limiting, current local static mounts, and Bitcoin Chat environment variables.
- Removed references to the deleted standalone poker backend service.
- Updated API documentation to list only endpoints exposed by the active shared backend.
- Updated architecture and task docs to remove stale claims about inactive production endpoints.

## Current Active Feature Set

The active root deployment supports:

- Single-player poker against five named AI bots with distinct personality archetypes.
- Single-table sit-and-go tournament mode.
- Multiplayer lobby creation, joining, and host start.
- WebSocket push channel for state-change notifications, with polling fallback.
- Fold, check, call, raise, buy-back, and next-hand actions.
- Database-backed game snapshots with an in-process cache and one-hour inactivity cleanup.
- Static frontend themes, card deck themes, per-session hand history, stats stored in browser storage, generated sound effects, haptics, mobile gestures, PWA manifest, and service worker.
