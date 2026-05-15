# Poker API Documentation

This documents the active poker API served by the shared backend at `backend/app/routers/poker.py`.

**Base URL:** `https://palmergill.com/api/poker`

**Local URL:** `http://127.0.0.1:8000/api/poker` when running `./start.sh` from the repo root.

## Important Note

The repository also contains `poker/backend/`, a standalone FastAPI poker service with many additional endpoints such as tournaments, persistence, CSRF, analytics, detailed health, backups, and spectators. The root Railway deployment does not run that service. Production uses the shared backend in `backend/`.

## Authentication

`/api/poker/*` is public in both Vercel middleware and the shared FastAPI auth middleware. The API identifies and authorizes players with the `player_id` and `player_token` returned when creating or joining a game. Keep the token client-side; mutating requests and state polling require it.

Write endpoints use a simple per-IP sliding-window rate limit of 60 requests per minute.

## Game Storage

Games are stored in memory in the shared backend process and expire after one hour without access. A backend restart clears active games.

## Endpoints

### Create Game

```http
POST /api/poker/games
```

Creates either a single-player game with five AI bots or a multiplayer lobby.

Request:

```json
{
  "player_name": "Alice",
  "game_type": "single",
  "max_players": 6
}
```

Fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_name` | string | No | Defaults to `Player`. |
| `game_type` | string | No | `single` starts immediately with AI bots; `multiplayer` creates a lobby. |
| `max_players` | integer | No | Defaults to 6 for multiplayer games. |

`game_type` must be `single` or `multiplayer`.

Response includes `game_id`, `player_id`, `player_token`, `state`, and `game_type`. Multiplayer lobby responses also include `players` and `waiting`.

### Join Multiplayer Game

```http
POST /api/poker/games/join
```

Request:

```json
{
  "game_id": "abc12345",
  "player_name": "Bob"
}
```

Only multiplayer games in the `waiting` phase can be joined.

### Start Multiplayer Game

```http
POST /api/poker/games/{game_id}/start?player_id={player_id}&player_token={player_token}
```

Starts a multiplayer game. Only the first player in the lobby can start it, and at least two players are required.

### Get Game State

```http
GET /api/poker/games/{game_id}?player_id={player_id}&player_token={player_token}&process_ai=true
```

Returns the current game state for the requesting player. Cards are only visible to the requesting player until showdown.

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_id` | string | Yes | Player identifier returned by create/join. |
| `player_token` | string | Yes | Player token returned by create/join. |
| `process_ai` | boolean | No | Defaults to `true`; the frontend passes `false` in multiplayer/lobby polling. |

### Player Action

```http
POST /api/poker/games/{game_id}/action
```

Request:

```json
{
  "player_id": "p0",
  "player_token": "secret-token",
  "action": "raise",
  "amount": 100
}
```

Actions:

| Action | Notes |
| --- | --- |
| `fold` | Gives up the hand. |
| `check` | Allowed only when the player has no amount to call. |
| `call` | Matches the current bet or goes all-in if the stack is smaller. |
| `raise` | Requires `amount`; the shared backend treats it as the raise amount on top of the call amount. |

### Buy Back

```http
POST /api/poker/games/{game_id}/buy-back
```

Request:

```json
{
  "player_id": "p0",
  "player_token": "secret-token",
  "amount": 1000
}
```

Adds chips to a busted player between hands. Available only during `showdown` or `waiting`.

### Next Hand

```http
POST /api/poker/games/{game_id}/next-hand?player_id={player_id}&player_token={player_token}
```

Starts the next hand after showdown or while waiting. The dealer button advances before the hand starts.

### Health

```http
GET /api/poker/health
```

Response:

```json
{
  "status": "ok",
  "active_games": 1,
  "cleaned_games": 0
}
```

## Game State Shape

The shared backend returns a `state` object shaped like:

| Field | Notes |
| --- | --- |
| `game_id` | 8-character game identifier. |
| `phase` | `waiting`, `preflop`, `flop`, `turn`, `river`, or `showdown`. |
| `pot` | Total pot in chips. |
| `current_bet` | Current bet to call. |
| `community_cards` | Visible board cards. |
| `players` | Player summaries. Hole cards are in each player's `hand` only when visible to the requester. |
| `current_player` | Player ID whose turn it is. |
| `dealer_index` | Current dealer-button index. |
| `winners` | Winners after showdown. |
| `last_action` | Last human/player action. |
| `last_ai_action` | Last AI action for display. |
| `hand_number` | Current hand number. |
| `min_raise` | Minimum raise amount. |
| `game_type` | `single` or `multiplayer`. |
| `max_players` | Multiplayer seat limit. |
| `waiting_for_players` | Lobby/waiting flag. |

## Errors

Errors use FastAPI's default format:

```json
{
  "detail": "Game not found"
}
```

Common status codes:

| Code | Meaning |
| --- | --- |
| `400` | Invalid action, not your turn, game already started, game full, or buy-back unavailable. |
| `403` | Invalid player token or non-host attempted to start a multiplayer game. |
| `404` | Game or player not found. |
| `429` | Per-IP rate limit exceeded on create, join, or action requests. |
| `422` | Request body/query validation error. |

## Frontend Notes

The current frontend includes compatibility code for CSRF/action-token flows from the standalone backend. The shared backend ignores the extra `action_token` field and does not expose `/api/poker/csrf-token`.
