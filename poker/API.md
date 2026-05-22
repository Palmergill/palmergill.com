# Poker API Documentation

This documents the active poker API served by the shared backend at `backend/app/routers/poker.py`.

**Base URL:** `https://palmergill.com/api/poker`

**Local URL:** `http://127.0.0.1:8000/api/poker` when running `./start.sh` from the repo root.

## Authentication

`/api/poker/*` is public in both Vercel middleware and the shared FastAPI auth middleware. The API identifies and authorizes players with the `player_id` and `player_token` returned when creating or joining a game. Keep the token client-side and do not put it in URLs. State polling sends the token in `X-Player-Token`; mutating requests send it in the JSON body.

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
POST /api/poker/games/{game_id}/start
```

Request:

```json
{
  "player_id": "p0",
  "player_token": "secret-token"
}
```

Starts a multiplayer game. Only the first player in the lobby can start it, and at least two players are required.

### Get Game State

```http
GET /api/poker/games/{game_id}?player_id={player_id}&process_ai=false
X-Player-Token: secret-token
```

Returns the current game state for the requesting player. Cards are only visible to the requesting player until showdown. This endpoint is read-only; it does not advance AI turns. The `process_ai` query parameter is retained for older clients, but the active frontend sends `process_ai=false` and advances AI turns through `POST /process-ai`.

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_id` | string | Yes | Player identifier returned by create/join. |

Headers:

| Header | Required | Notes |
| --- | --- | --- |
| `X-Player-Token` | Yes | Player token returned by create/join. |

### Process AI Turn

```http
POST /api/poker/games/{game_id}/process-ai
```

Request:

```json
{
  "player_id": "p0",
  "player_token": "secret-token"
}
```

Advances at most one AI bot turn for a single-player game and returns the updated game state. Multiplayer games and human turns are returned unchanged.

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
  "player_token": "secret-token"
}
```

Sets a busted player back to the server-defined buy-back stack between hands. Available only during `showdown` or `waiting`.

### Next Hand

```http
POST /api/poker/games/{game_id}/next-hand
```

Request:

```json
{
  "player_id": "p0",
  "player_token": "secret-token"
}
```

Starts the next hand after showdown or while waiting. The dealer button advances before the hand starts.

### CSRF Compatibility Token

```http
GET /api/poker/csrf-token
```

Returns `{ "ok": true }` and sets a `csrf_token` cookie for frontend compatibility with older double-submit flows. The active shared backend authorizes game actions with `player_token`; CSRF tokens are not required for poker API calls.

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

The current frontend includes compatibility code for CSRF/action-token flows from the old standalone backend. The shared backend ignores the extra `action_token` field and exposes `/api/poker/csrf-token` only as a compatibility helper.
