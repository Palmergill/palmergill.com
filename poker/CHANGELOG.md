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
- Hover/focus tooltips (`data-tip`) across the table, dock, and stats — betting round, pot, dealer and blind chips, AI style tags, stack sizes, call pot odds, raise sizing, and the act timer.
- `is_dealer` / `is_small_blind` / `is_big_blind` flags on each player in the game state, so the table can mark the button and blinds.

### Changed
- Redesigned the front end: a real oval table with seats placed around the rail, a compact HUD, and a fixed action dock. Copy is pared back to numbers and short labels, with explanations moved into tooltips.
- Replaced the layered retheme passes in `poker/style.css` with a single stylesheet, dropping the unused felt-colour themes, card-deck themes, light mode, and chip-stack graphics.
- Hand history now renders cards as `A♠` rather than raw rank/suit values.
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
- Per-session hand history, stats stored in browser storage, generated sound effects, haptics, mobile gestures, PWA manifest, and service worker.
