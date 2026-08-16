"""Server-authoritative Fourth & Fortune draft-order game.

Every player gets a fresh deterministic 52-card deck for each round, derived
from the committed master seed, their normalized account name, and the round
number. The seed remains private until the room completes, at which point the
verification endpoint exposes everything needed to reproduce every shuffle.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from collections import defaultdict
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import accounts
from app.database import (
    FantasyDraftFlip,
    FantasyDraftPlayer,
    FantasyDraftRound,
    FantasyDraftSession,
    utc_now,
)

LEGACY_GAME_VERSION = "fourth-and-fortune-v1"
FRESH_DECK_GAME_VERSION = "fourth-and-fortune-v2"
GAME_VERSION = "fourth-and-fortune-v3"
# Every version from v2 on deals a fresh 52-card deck for each round. Version 1
# committed to one continuous deck and is still played and proved that way.
FRESH_ROUND_DECK_VERSIONS = frozenset({FRESH_DECK_GAME_VERSION, GAME_VERSION})
ROUNDS_PER_PLAYER = 5
# Version 3 pays the sealed final round double. A round tops out near 40 points,
# so under flat scoring anyone more than about 25 behind going into round 5 was
# already mathematically out while still being asked to play it behind the seal.
# Doubling keeps the last round live for the whole table without handing the
# draft to it: it is worth roughly a third of a winning total, not all of it.
# Only the total is doubled — the best-round tiebreak stays on raw scores, or a
# doubled round 5 would win it outright and the tiebreak would stop separating
# anyone. See _best_round.
FINAL_ROUND_MULTIPLIER = 2
# A round is over once it is banked, busted, written off by the host when a
# manager walks away mid-draft, or left with no deck to deal from. Forfeited and
# exhausted rounds both score zero.
ROUND_STATE_EXHAUSTED = "exhausted"
FINISHED_ROUND_STATES = frozenset({"banked", "busted", "forfeited", ROUND_STATE_EXHAUSTED})
TURN_STATE_PLAYING = "playing"
TURN_STATE_RESOLVED = "resolved"
# How long the table keeps a finished hand face up before the next manager is
# put on the clock. Turns used to advance inside the same transaction that
# ended them, so the card that busted or banked a round was already gone by the
# time anyone polled. This has to comfortably exceed the client's active poll
# interval (900ms) or a spectator can still miss it between two reads.
TURN_HOLD_SECONDS = 1.8
# How long a manager gets on the clock before the host may write them off. The
# skip exists for a closed laptop, not for a rival in the lead: without a floor
# the host could zero somebody's remaining rounds the instant their turn opened,
# which is the one thing in this game a person can decide rather than the seed.
FORFEIT_GRACE_SECONDS = 90
MIN_PLAYERS = 2
MAX_PLAYERS = 16
# Rooms are cheap to open and, until a host could clear their own lobby, nothing
# ever removed one. This is a guard rail, not a quota: a league runs one draft.
MAX_OPEN_ROOMS_PER_HOST = 10
# A bot game is opened on a whim and abandoned just as easily, so it gets a
# tighter guard rail than a league draft — and the host can clear their own at
# any point, so the cap is never a dead end. See delete_session.
MAX_OPEN_BOT_ROOMS_PER_HOST = 3
MODE_LEAGUE = "league"
MODE_PRACTICE = "practice"
MODE_TEST = "test"
# Any manager can open one of these: them against a table of bots, played under
# the same rules, scoring, and proof as a league draft.
MODE_BOTS = "bots"
ROOM_MODES = frozenset({MODE_LEAGUE, MODE_PRACTICE, MODE_TEST, MODE_BOTS})
# Rooms where bots sit at the table and the host's client drives their turns.
BOT_ROOM_MODES = frozenset({MODE_TEST, MODE_BOTS})
# Rooms with no other human in them. Nobody else's played hands are lost when
# the host clears one, so they can be deleted at any point in their life.
SOLO_ROOM_MODES = frozenset({MODE_PRACTICE, MODE_BOTS})
OPEN_ROOM_CAPS = {
    MODE_LEAGUE: MAX_OPEN_ROOMS_PER_HOST,
    MODE_BOTS: MAX_OPEN_BOT_ROOMS_PER_HOST,
}
OPEN_ROOM_CAP_NOUNS = {MODE_LEAGUE: "draft rooms", MODE_BOTS: "bot games"}
BOT_NAMES = (
    "Ace Bot",
    "Blitz Bot",
    "Clover Bot",
    "Dime Bot",
    "End Zone Bot",
    "Fumble Bot",
    "Gridiron Bot",
    "Huddle Bot",
    "Iceman Bot",
    "Juke Bot",
    "Kickoff Bot",
    "Lombardi Bot",
    "Mascot Bot",
    "Nickel Bot",
    "Overtime Bot",
)
JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SUITS = ("C", "D", "H", "S")
RANKS = tuple(str(value) for value in range(2, 11)) + ("J", "Q", "K", "A")
RANK_VALUES = {str(value): value for value in range(2, 11)} | {
    "J": 11,
    "Q": 12,
    "K": 13,
    "A": 14,
}
SUIT_NAMES = {"C": "clubs", "D": "diamonds", "H": "hearts", "S": "spades"}
SUIT_SYMBOLS = {"C": "♣", "D": "♦", "H": "♥", "S": "♠"}


def _identity_names(identity: dict[str, str]) -> tuple[str, str]:
    display_name = str(identity.get("username", "")).strip()
    username = accounts.normalize_username(display_name)
    if not username:
        raise HTTPException(status_code=401, detail="Sign in to play.")
    return username, display_name


def _master_seed_bytes(master_seed: str) -> bytes:
    return bytes.fromhex(master_seed)


def seed_commitment(master_seed: str) -> str:
    """SHA-256 of the raw 32-byte seed, encoded as lowercase hex."""
    return hashlib.sha256(_master_seed_bytes(master_seed)).hexdigest()


def _context_key(master_seed: str, context: str) -> bytes:
    return hmac.new(
        _master_seed_bytes(master_seed),
        context.encode("utf-8"),
        hashlib.sha256,
    ).digest()


class _HmacRandom:
    """Small deterministic CSPRNG stream with unbiased ``randbelow``."""

    def __init__(self, key: bytes):
        self.key = key
        self.counter = 0

    def _uint64(self) -> int:
        digest = hmac.new(
            self.key,
            self.counter.to_bytes(8, "big"),
            hashlib.sha256,
        ).digest()
        self.counter += 1
        return int.from_bytes(digest[:8], "big")

    def randbelow(self, upper: int) -> int:
        if upper <= 0:
            raise ValueError("upper must be positive")
        span = 1 << 64
        ceiling = span - (span % upper)
        while True:
            value = self._uint64()
            if value < ceiling:
                return value % upper


def _shuffle(values: Iterable[Any], master_seed: str, context: str) -> list[Any]:
    shuffled = list(values)
    random_stream = _HmacRandom(_context_key(master_seed, context))
    for index in range(len(shuffled) - 1, 0, -1):
        swap_index = random_stream.randbelow(index + 1)
        shuffled[index], shuffled[swap_index] = shuffled[swap_index], shuffled[index]
    return shuffled


def canonical_deck() -> list[str]:
    return [f"{rank}{suit}" for rank in RANKS for suit in SUITS]


def derive_player_deck(master_seed: str, username: str) -> list[str]:
    """Version 1's single continuous deck, retained for existing room proofs."""
    normalized = accounts.normalize_username(username)
    return _shuffle(canonical_deck(), master_seed, f"deck:v1:{normalized}")


def derive_round_deck(master_seed: str, username: str, round_number: int) -> list[str]:
    """Version 2's independent, reproducible deck for one player's round."""
    if round_number < 1:
        raise ValueError("round_number must be positive")
    normalized = accounts.normalize_username(username)
    return _shuffle(
        canonical_deck(),
        master_seed,
        f"deck:v2:{normalized}:round:{round_number}",
    )


def _game_version(room: FantasyDraftSession) -> str:
    return room.game_version or LEGACY_GAME_VERSION


def _uses_fresh_round_decks(room: FantasyDraftSession) -> bool:
    return _game_version(room) in FRESH_ROUND_DECK_VERSIONS


def _final_round_multiplier(room: FantasyDraftSession) -> int:
    """What the last round pays in this room, by the version it committed to."""
    return FINAL_ROUND_MULTIPLIER if _game_version(room) == GAME_VERSION else 1


def _round_value(room: FantasyDraftSession, round_row: FantasyDraftRound) -> int:
    """What a finished round contributes to a manager's total.

    A stored round score is always the raw card total — the proof, the round
    lines, and every client read it that way — so the final-round multiplier is
    applied here, at the one place scores are added up.
    """
    if round_row.round_number == ROUNDS_PER_PLAYER:
        return round_row.score * _final_round_multiplier(room)
    return round_row.score


def _deck_for_round(
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    round_number: int,
) -> list[str]:
    if _uses_fresh_round_decks(room):
        return derive_round_deck(room.master_seed, player.username, round_number)
    return derive_player_deck(room.master_seed, player.username)


def derive_turn_order(master_seed: str, usernames: Iterable[str]) -> list[str]:
    normalized = sorted(accounts.normalize_username(name) for name in usernames)
    return _shuffle(normalized, master_seed, "turn-order:v1")


def tie_break_value(master_seed: str, username: str) -> int:
    digest = hmac.new(
        _master_seed_bytes(master_seed),
        f"tiebreak:v1:{accounts.normalize_username(username)}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return int.from_bytes(digest[:8], "big")


def _card_rank(code: str) -> str:
    return code[:-1]


def card_value(code: str) -> int:
    return RANK_VALUES[_card_rank(code)]


def card_payload(code: str, deck_index: int | None = None) -> dict[str, Any]:
    suit = code[-1]
    payload: dict[str, Any] = {
        "code": code,
        "rank": _card_rank(code),
        "suit": SUIT_NAMES[suit],
        "symbol": SUIT_SYMBOLS[suit],
        "value": card_value(code),
        "red": suit in {"D", "H"},
    }
    if deck_index is not None:
        payload["deckIndex"] = deck_index
    return payload


def _new_join_code(db: Session) -> str:
    for _ in range(24):
        code = "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(6))
        exists = db.query(FantasyDraftSession.id).filter(FantasyDraftSession.join_code == code).first()
        if not exists:
            return code
    raise HTTPException(status_code=503, detail="Couldn't create a room code. Try again.")


def _session_or_404(db: Session, session_id: str, *, lock: bool = False) -> FantasyDraftSession:
    query = db.query(FantasyDraftSession).filter(FantasyDraftSession.id == session_id)
    if lock:
        query = query.with_for_update()
    room = query.first()
    if room is None:
        raise HTTPException(status_code=404, detail="Draft room not found.")
    return room


def _players(db: Session, session_id: str) -> list[FantasyDraftPlayer]:
    return (
        db.query(FantasyDraftPlayer)
        .filter(FantasyDraftPlayer.session_id == session_id)
        .order_by(FantasyDraftPlayer.joined_at, FantasyDraftPlayer.id)
        .all()
    )


def _rounds(db: Session, session_id: str) -> list[FantasyDraftRound]:
    return (
        db.query(FantasyDraftRound)
        .filter(FantasyDraftRound.session_id == session_id)
        .order_by(FantasyDraftRound.round_number, FantasyDraftRound.started_at)
        .all()
    )


def _player_flips(db: Session, player_id: str) -> list[FantasyDraftFlip]:
    return (
        db.query(FantasyDraftFlip)
        .filter(FantasyDraftFlip.player_id == player_id)
        .order_by(FantasyDraftFlip.deck_index)
        .all()
    )


def _minimum_players(room: FantasyDraftSession) -> int:
    """A solo warm-up needs one seat; a real draft needs someone to beat."""
    return 1 if room.mode == MODE_PRACTICE else MIN_PLAYERS


def _last_event(room: FantasyDraftSession) -> dict[str, Any] | None:
    try:
        value = json.loads(room.last_event_json or "null")
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _is_holding(room: FantasyDraftSession) -> bool:
    return room.turn_state == TURN_STATE_RESOLVED


def _hold_expired(room: FantasyDraftSession) -> bool:
    if room.resolved_at is None:
        return True
    return (utc_now() - room.resolved_at).total_seconds() >= TURN_HOLD_SECONDS


def _seconds_on_the_clock(room: FantasyDraftSession) -> float | None:
    """How long the current manager has had the turn, or None if unknown.

    Rooms that were mid-draft when the column arrived carry no turn start. An
    unknown start reads as "long enough ago", matching how they already behaved.
    """
    if room.turn_started_at is None:
        return None
    return (utc_now() - room.turn_started_at).total_seconds()


def _forfeit_grace_remaining(room: FantasyDraftSession) -> float:
    elapsed = _seconds_on_the_clock(room)
    if elapsed is None:
        return 0.0
    return max(0.0, FORFEIT_GRACE_SECONDS - elapsed)


def _reject_if_held(room: FantasyDraftSession) -> None:
    if _is_holding(room):
        raise HTTPException(status_code=409, detail="The table is still clearing that hand.")


def _cards(round_row: FantasyDraftRound) -> list[str]:
    try:
        value = json.loads(round_row.cards_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(card) for card in value if isinstance(card, str)]


def _round_score_total(
    room: FantasyDraftSession,
    rounds: list[FantasyDraftRound],
) -> int:
    return sum(
        _round_value(room, row) for row in rounds if row.state in FINISHED_ROUND_STATES
    )


def _best_round(rounds: list[FantasyDraftRound]) -> int:
    """The best raw round, deliberately ignoring the final-round multiplier.

    This is the first tiebreak after total score. Counting a doubled round five
    here would hand it to whoever had the best final round in nearly every game
    — the same thing the doubled total already rewards — so the tiebreak would
    stop separating managers who genuinely finished level.
    """
    return max(
        (row.score for row in rounds if row.state in FINISHED_ROUND_STATES),
        default=0,
    )


def _active_round(rounds: list[FantasyDraftRound]) -> FantasyDraftRound | None:
    return next((row for row in rounds if row.state == "active"), None)


def _round_payload(
    round_row: FantasyDraftRound,
    *,
    concealed: bool = False,
    final_multiplier: int = 1,
) -> dict[str, Any]:
    cards = _cards(round_row)
    # "score" stays the raw card total in every payload — it is what the cards
    # on the table add up to and what any verifier recomputes. "multiplier" is
    # what that round is then worth, so a reader never has to know the rules to
    # follow the arithmetic.
    multiplier = final_multiplier if round_row.round_number == ROUNDS_PER_PLAYER else 1
    if concealed:
        return {
            "number": round_row.round_number,
            "cards": [],
            "cardCount": len(cards),
            "concealed": True,
            "score": None,
            "multiplier": multiplier,
            "busted": None,
            "state": "active" if round_row.state == "active" else "sealed",
        }
    return {
        "number": round_row.round_number,
        "cards": [card_payload(code) for code in cards],
        "cardCount": len(cards),
        "concealed": False,
        "score": round_row.score,
        "multiplier": multiplier,
        "busted": bool(round_row.busted),
        "state": round_row.state,
    }


def standing_key(
    score: int,
    best_round: int,
    master_seed: str,
    username: str,
) -> tuple[int, int, int]:
    """The one ranking rule: total, then best round, then the seeded tiebreak.

    The live standings and the final draft order both sort on this. They used
    to disagree — the standings fell back to turn position on a tie — so a
    manager could watch themselves hold first place and then be handed the
    second pick.
    """
    return (-score, -best_round, -tie_break_value(master_seed, username))


def _final_order(
    players: list[FantasyDraftPlayer],
    rounds_by_player: dict[str, list[FantasyDraftRound]],
    master_seed: str,
) -> list[FantasyDraftPlayer]:
    return sorted(
        players,
        key=lambda player: standing_key(
            player.final_score,
            _best_round(rounds_by_player[player.id]),
            master_seed,
            player.username,
        ),
    )


def _round_play_order(
    players: list[FantasyDraftPlayer],
    rounds_by_player: dict[str, list[FantasyDraftRound]],
    room: FantasyDraftSession,
    round_number: int,
) -> list[FantasyDraftPlayer]:
    """Freeze each round's order from information known before it begins.

    Round one uses the committed seed order. Later rounds use the standings
    after the preceding round: total score, best round, then the existing
    seeded tiebreak. Recomputing from only earlier rounds keeps the sequence
    stable while the current round is being played.
    """
    if round_number == 1:
        return sorted(
            players,
            key=lambda player: (
                player.turn_position
                if player.turn_position is not None
                else MAX_PLAYERS + 1,
                player.id,
            ),
        )

    def prior_rounds(player: FantasyDraftPlayer) -> list[FantasyDraftRound]:
        return [
            row
            for row in rounds_by_player[player.id]
            if row.round_number < round_number and row.state in FINISHED_ROUND_STATES
        ]

    # Round five's multiplier never reaches this: the order for round N is built
    # from rounds before N, so the last round is only ever the one being ordered.
    return sorted(
        players,
        key=lambda player: standing_key(
            _round_score_total(room, prior_rounds(player)),
            _best_round(prior_rounds(player)),
            room.master_seed,
            player.username,
        ),
    )


def _bust_chance(
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    active_round: FantasyDraftRound | None,
    deck_position: int,
) -> float:
    if active_round is None:
        return 0.0
    held_ranks = {_card_rank(code) for code in _cards(active_round)}
    deck = _deck_for_round(room, player, active_round.round_number)
    remaining = deck[deck_position:]
    if not remaining or not held_ranks:
        return 0.0
    danger = sum(1 for code in remaining if _card_rank(code) in held_ranks)
    return round((danger / len(remaining)) * 100, 1)


def serialize_session(
    db: Session,
    room: FantasyDraftSession,
    viewer_username: str | None,
) -> dict[str, Any]:
    players = _players(db, room.id)
    all_rounds = _rounds(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in all_rounds:
        rounds_by_player[round_row.player_id].append(round_row)

    viewer_normalized = accounts.normalize_username(viewer_username)
    current_player = next((player for player in players if player.id == room.current_player_id), None)
    results_revealed = bool(room.revealed_at) or room.mode == MODE_PRACTICE
    holding = _is_holding(room)
    last_event = _last_event(room)
    current_round = None
    current_round_number = None
    if current_player is not None:
        current_round = _active_round(rounds_by_player[current_player.id])
        if current_round is None and holding and last_event is not None:
            # The hand that just ended is still the one on the table.
            current_round = next(
                (
                    row
                    for row in rounds_by_player[current_player.id]
                    if row.round_number == last_event.get("round")
                ),
                None,
            )
        completed_current = sum(
            1
            for row in rounds_by_player[current_player.id]
            if row.state in FINISHED_ROUND_STATES
        )
        current_round_number = (
            current_round.round_number
            if current_round is not None
            else min(completed_current + 1, ROUNDS_PER_PLAYER)
        )
    final_round_sealed = not results_revealed and (
        room.state == "complete" or current_round_number == ROUNDS_PER_PLAYER
    )
    final_multiplier = _final_round_multiplier(room)
    player_payloads = []
    scores: dict[str, int] = {}
    best_rounds: dict[str, int] = {}
    for player in players:
        player_rounds = rounds_by_player[player.id]
        scoring_rounds = (
            [row for row in player_rounds if row.round_number < ROUNDS_PER_PLAYER]
            if final_round_sealed
            else player_rounds
        )
        score = (
            player.final_score
            if room.state == "complete" and results_revealed
            else _round_score_total(room, scoring_rounds)
        )
        best_round = _best_round(scoring_rounds)
        final_round_finished = any(
            row.round_number == ROUNDS_PER_PLAYER and row.state in FINISHED_ROUND_STATES
            for row in player_rounds
        )
        scores[player.id] = score
        best_rounds[player.id] = best_round
        player_payloads.append({
            "id": player.id,
            "username": player.username,
            "displayName": player.display_name,
            "turnPosition": player.turn_position,
            "score": score,
            "scoreHidden": bool(final_round_sealed and final_round_finished),
            "bestRound": best_round,
            "roundsCompleted": sum(
                1 for row in player_rounds if row.state in FINISHED_ROUND_STATES
            ),
            "rounds": [
                _round_payload(
                    row,
                    concealed=bool(
                        row.round_number == ROUNDS_PER_PLAYER
                        and player.username != viewer_normalized
                        and not results_revealed
                    ),
                    final_multiplier=final_multiplier,
                )
                for row in player_rounds
            ],
            "isCurrent": player.id == room.current_player_id,
            "isHost": player.username == room.created_by,
            "isBot": bool(player.is_bot),
        })

    leaderboard = sorted(
        player_payloads,
        key=lambda player: standing_key(
            player["score"],
            player["bestRound"],
            room.master_seed,
            player["username"],
        ),
    )
    for place, player in enumerate(leaderboard, start=1):
        player["place"] = place

    current_round_payload = None
    decision = None
    if current_player is not None:
        total_flips_used = db.query(func.count(FantasyDraftFlip.id)).filter(
            FantasyDraftFlip.player_id == current_player.id
        ).scalar() or 0
        current_cards = _cards(current_round) if current_round is not None else []
        deck_position = (
            len(current_cards)
            if _uses_fresh_round_decks(room)
            else total_flips_used
        )
        spectator_final_round = bool(
            current_round_number == ROUNDS_PER_PLAYER
            and current_player.username != viewer_normalized
            and not results_revealed
        )
        # What the hand on the table is worth if it is banked. Public: the whole
        # room knows the last round pays double, sealed or not.
        current_multiplier = (
            final_multiplier if current_round_number == ROUNDS_PER_PLAYER else 1
        )
        if current_round is None:
            current_round_payload = {
                "number": current_round_number,
                "cards": [],
                "cardCount": 0,
                "concealed": spectator_final_round,
                "pot": None if spectator_final_round else 0,
                "multiplier": current_multiplier,
                "bustChance": None if spectator_final_round else 0.0,
                "deckRemaining": None if spectator_final_round else 52 - deck_position,
            }
        elif spectator_final_round:
            current_round_payload = {
                "number": current_round.round_number,
                "cards": [],
                "cardCount": len(_cards(current_round)),
                "concealed": True,
                "pot": None,
                "multiplier": current_multiplier,
                "bustChance": None,
                "deckRemaining": None,
            }
        else:
            current_round_payload = {
                "number": current_round.round_number,
                "cards": [card_payload(code) for code in current_cards],
                "cardCount": len(current_cards),
                "concealed": False,
                "pot": current_round.score,
                "multiplier": current_multiplier,
                # A hand that has already resolved has no next flip to price.
                "bustChance": (
                    None
                    if holding
                    else _bust_chance(room, current_player, current_round, deck_position)
                ),
                "deckRemaining": 52 - deck_position,
            }

        if not spectator_final_round and not holding:
            projected_score = (
                scores[current_player.id]
                + current_round_payload["pot"] * current_multiplier
            )
            decision = {
                "projectedScore": projected_score,
                # While the last hands are sealed, every other total here is
                # frozen at the standings from before the final round. A
                # position or a "you'd lead" read off them is a claim the room
                # cannot make: opponents who already played their final round
                # may have banked straight past this manager behind the seal.
                "standingsSealed": final_round_sealed,
                "bankPosition": None,
                "scoreToBeat": None,
                "isLeadingIfBanked": None,
            }
            if not final_round_sealed:
                hypothetical = dict(scores)
                hypothetical[current_player.id] = projected_score
                # Banking the pot can also raise the best-round tiebreak, so the
                # projection has to move both halves of the key.
                hypothetical_best = dict(best_rounds)
                hypothetical_best[current_player.id] = max(
                    best_rounds[current_player.id],
                    current_round_payload["pot"],
                )
                # One ranking rule everywhere. This used to sort on turn
                # position, so a manager tied for the lead could be told they'd
                # sit first while the standings beside it — and the final draft
                # order — had them second. See standing_key.
                projected_order = sorted(
                    players,
                    key=lambda player: standing_key(
                        hypothetical[player.id],
                        hypothetical_best[player.id],
                        room.master_seed,
                        player.username,
                    ),
                )
                other_scores = [
                    score for player_id, score in scores.items() if player_id != current_player.id
                ]
                score_to_beat = max(other_scores, default=0)
                decision["bankPosition"] = next(
                    index
                    for index, player in enumerate(projected_order, start=1)
                    if player.id == current_player.id
                )
                decision["scoreToBeat"] = score_to_beat
                decision["isLeadingIfBanked"] = projected_score > score_to_beat

    draft_order = None
    if room.state == "complete" and results_revealed:
        draft_order = []
        for pick, player in enumerate(_final_order(players, rounds_by_player, room.master_seed), start=1):
            draft_order.append({
                "pick": pick,
                "playerId": player.id,
                "displayName": player.display_name,
                "score": player.final_score,
                "bestRound": _best_round(rounds_by_player[player.id]),
                "isBot": bool(player.is_bot),
            })

    member = next((player for player in players if player.username == viewer_normalized), None)
    return {
        "id": room.id,
        "leagueName": room.league_name,
        "mode": room.mode or MODE_LEAGUE,
        "joinCode": (
            room.join_code
            if member is not None and room.mode == MODE_LEAGUE
            else None
        ),
        "seedHash": room.seed_hash,
        "state": room.state,
        "roundsPerPlayer": ROUNDS_PER_PLAYER,
        "createdAt": room.created_at.isoformat() if room.created_at else None,
        "startedAt": room.started_at.isoformat() if room.started_at else None,
        "completedAt": room.completed_at.isoformat() if room.completed_at else None,
        "revealedAt": room.revealed_at.isoformat() if room.revealed_at else None,
        "resultsRevealed": results_revealed,
        "isHost": viewer_normalized == room.created_by,
        "isMember": member is not None,
        # Lets the client tell "you banked 24" from "Ace Bot banked 24" without
        # having to re-derive account-name normalization in the browser.
        "viewerPlayerId": member.id if member is not None else None,
        "canReveal": bool(
            viewer_normalized == room.created_by
            and room.state == "complete"
            and not results_revealed
        ),
        "canStart": (
            viewer_normalized == room.created_by
            and room.state == "lobby"
            and len(players) >= _minimum_players(room)
        ),
        # Nobody acts while a finished hand is still face up on the table.
        "holdingTurn": holding,
        "canPlay": bool(
            member is not None
            and current_player is not None
            and member.id == current_player.id
            and room.state == "active"
            and not holding
        ),
        "canForfeit": bool(
            viewer_normalized == room.created_by
            and room.state == "active"
            and current_player is not None
            and not holding
            and _forfeit_grace_remaining(room) <= 0
        ),
        # Lets the host see the skip coming instead of watching a stalled room
        # with no affordance at all.
        "forfeitAvailableIn": (
            round(_forfeit_grace_remaining(room))
            if viewer_normalized == room.created_by and room.state == "active"
            else None
        ),
        "canRunBot": bool(
            viewer_normalized == room.created_by
            and room.mode in BOT_ROOM_MODES
            and room.state == "active"
            and current_player is not None
            and current_player.is_bot
            and not holding
        ),
        "currentPlayer": (
            {
                "id": current_player.id,
                "displayName": current_player.display_name,
                "turnPosition": current_player.turn_position,
                "isBot": bool(current_player.is_bot),
            }
            if current_player is not None
            else None
        ),
        "currentRound": current_round_payload,
        "lastEvent": _visible_event(last_event, viewer_normalized, results_revealed),
        "decision": decision,
        "players": player_payloads,
        "leaderboard": leaderboard,
        "draftOrder": draft_order,
    }


def create_session(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    *,
    mode: str = MODE_LEAGUE,
) -> FantasyDraftSession:
    username, display_name = _identity_names(identity)
    cleaned_name = " ".join(league_name.split())
    if len(cleaned_name) < 3 or len(cleaned_name) > 60:
        raise HTTPException(status_code=400, detail="League name must be 3–60 characters.")
    if mode not in ROOM_MODES:
        raise ValueError(f"Unsupported draft room mode: {mode}")
    cap = OPEN_ROOM_CAPS.get(mode)
    if cap is not None:
        open_rooms = db.query(func.count(FantasyDraftSession.id)).filter(
            FantasyDraftSession.created_by == username,
            FantasyDraftSession.mode == mode,
            FantasyDraftSession.state.in_(("lobby", "active")),
        ).scalar() or 0
        if open_rooms >= cap:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"You already have {cap} {OPEN_ROOM_CAP_NOUNS[mode]} open. "
                    "Finish or delete one before starting another."
                ),
            )

    master_seed = secrets.token_hex(32)
    room = FantasyDraftSession(
        id=str(uuid.uuid4()),
        league_name=cleaned_name,
        join_code=_new_join_code(db),
        master_seed=master_seed,
        seed_hash=seed_commitment(master_seed),
        game_version=GAME_VERSION,
        mode=mode,
        state="lobby",
        created_by=username,
    )
    db.add(room)
    # These models deliberately do not define ORM relationships. Without an
    # explicit flush SQLAlchemy may insert the host player before the room;
    # PostgreSQL then rejects the player's session_id foreign key. Persist the
    # parent row first so every supported database sees a valid room ID.
    db.flush()
    db.add(FantasyDraftPlayer(
        id=str(uuid.uuid4()),
        session_id=room.id,
        username=username,
        display_name=display_name,
        is_bot=False,
    ))
    db.commit()
    db.refresh(room)
    return room


def create_practice_session(db: Session, identity: dict[str, str]) -> FantasyDraftSession:
    """Create or resume a private five-round solo warm-up."""
    username, display_name = _identity_names(identity)
    existing = (
        db.query(FantasyDraftSession)
        .join(FantasyDraftPlayer, FantasyDraftPlayer.session_id == FantasyDraftSession.id)
        .filter(
            FantasyDraftSession.mode == MODE_PRACTICE,
            FantasyDraftSession.created_by == username,
            FantasyDraftSession.state.in_(("lobby", "active")),
            FantasyDraftPlayer.username == username,
        )
        .order_by(FantasyDraftSession.created_at.desc())
        .first()
    )
    if existing is not None:
        if existing.state == "lobby":
            player = db.query(FantasyDraftPlayer).filter(
                FantasyDraftPlayer.session_id == existing.id,
                FantasyDraftPlayer.username == username,
            ).one()
            player.turn_position = 1
            existing.current_player_id = player.id
            existing.state = "active"
            existing.started_at = utc_now()
            existing.turn_started_at = existing.started_at
            db.commit()
            db.refresh(existing)
        return existing

    room = create_session(
        db,
        identity,
        f"{display_name} practice",
        mode=MODE_PRACTICE,
    )
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.session_id == room.id,
        FantasyDraftPlayer.username == username,
    ).one()
    player.turn_position = 1
    room.current_player_id = player.id
    room.state = "active"
    room.started_at = utc_now()
    room.turn_started_at = room.started_at
    db.commit()
    db.refresh(room)
    return room


def _seat_bots(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    bot_count: int,
    mode: str,
) -> FantasyDraftSession:
    if bot_count < 1 or bot_count > len(BOT_NAMES):
        raise HTTPException(
            status_code=400,
            detail=f"Choose between 1 and {len(BOT_NAMES)} bot opponents.",
        )

    room = create_session(db, identity, league_name, mode=mode)
    for index, display_name in enumerate(BOT_NAMES[:bot_count], start=1):
        db.add(FantasyDraftPlayer(
            id=str(uuid.uuid4()),
            session_id=room.id,
            username=f"__bot_{index:02d}",
            display_name=display_name,
            is_bot=True,
        ))
    db.commit()
    db.refresh(room)
    return room


def create_bot_session(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    bot_count: int,
) -> FantasyDraftSession:
    """Create a room where one manager plays a full draft against bots.

    Identical to a league draft in every way that matters — same decks, same
    scoring, same sealed final round, same proof — so a manager can learn the
    game against opponents who press their luck back, without needing a league
    to show up. Practice is the solo warm-up; this is the whole game.
    """
    return _seat_bots(db, identity, league_name, bot_count, MODE_BOTS)


def create_test_session(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    bot_count: int,
) -> FantasyDraftSession:
    """Create an admin-only production test room with marked bot players."""
    if identity.get("role") != accounts.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only the site admin can create bot test rooms.")
    return _seat_bots(db, identity, league_name, bot_count, MODE_TEST)


def join_session(db: Session, identity: dict[str, str], join_code: str) -> FantasyDraftSession:
    username, display_name = _identity_names(identity)
    code = "".join(str(join_code).upper().split())
    room = (
        db.query(FantasyDraftSession)
        .filter(FantasyDraftSession.join_code == code)
        .with_for_update()
        .first()
    )
    if room is None:
        raise HTTPException(status_code=404, detail="That room code doesn't exist.")
    if room.mode != MODE_LEAGUE:
        raise HTTPException(status_code=409, detail="That room isn't open to league managers.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="That draft room has already started.")
    existing = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.session_id == room.id,
        FantasyDraftPlayer.username == username,
    ).first()
    if existing:
        return room
    player_count = db.query(func.count(FantasyDraftPlayer.id)).filter(
        FantasyDraftPlayer.session_id == room.id
    ).scalar() or 0
    if player_count >= MAX_PLAYERS:
        raise HTTPException(status_code=409, detail="That draft room is full.")

    db.add(FantasyDraftPlayer(
        id=str(uuid.uuid4()),
        session_id=room.id,
        username=username,
        display_name=display_name,
        is_bot=False,
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # A double-click or two browser tabs racing to join should be
        # idempotent when this account already won the unique constraint.
        existing = db.query(FantasyDraftPlayer.id).filter(
            FantasyDraftPlayer.session_id == room.id,
            FantasyDraftPlayer.username == username,
        ).first()
        if not existing:
            raise HTTPException(status_code=409, detail="Unable to join that room.")
    return _session_or_404(db, room.id)


def remove_player(
    db: Session,
    identity: dict[str, str],
    session_id: str,
    player_id: str,
) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can remove a player.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="The roster is already locked.")
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    if player.username == room.created_by:
        raise HTTPException(status_code=409, detail="The host can't remove themself.")
    db.delete(player)
    db.commit()
    return room


def leave_session(db: Session, identity: dict[str, str], session_id: str) -> None:
    """Let a manager out of a lobby they joined by mistake.

    Only before the roster locks. Once the draft starts, the seat is part of the
    record: the turn order and every deck are derived from who was sitting in it.
    """
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="The roster is already locked.")
    if username == room.created_by:
        raise HTTPException(
            status_code=409,
            detail="The host can't leave their own room. Delete it instead.",
        )
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.session_id == room.id,
        FantasyDraftPlayer.username == username,
    ).first()
    if player is None:
        raise HTTPException(status_code=404, detail="You aren't in this draft room.")
    db.delete(player)
    db.commit()


def delete_session(db: Session, identity: dict[str, str], session_id: str) -> None:
    """Tear down a room and everything dealt inside it.

    The admin can clear anything. A host can clear their own room only while it
    is still a lobby: no hand has been played yet, so nothing is being erased out
    from under the managers who played it — and without this, an account that
    filled MAX_OPEN_ROOMS_PER_HOST would have no way to open another.

    A practice run or a bot game is the exception at any point in its life: the
    only human hands in it are the host's own.

    The child tables declare ON DELETE CASCADE, but SQLite only honours that
    with foreign keys switched on per connection, so the rows are cleared here
    rather than trusting the database to do it.
    """
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if identity.get("role") != accounts.ROLE_ADMIN:
        if username != room.created_by:
            raise HTTPException(
                status_code=403,
                detail="Only the host or the site admin can delete a room.",
            )
        if room.state != "lobby" and room.mode not in SOLO_ROOM_MODES:
            raise HTTPException(
                status_code=409,
                detail="Cards have already been dealt here. Ask the site admin to clear it.",
            )
    for model in (FantasyDraftFlip, FantasyDraftRound, FantasyDraftPlayer):
        db.query(model).filter(model.session_id == room.id).delete(synchronize_session=False)
    db.delete(room)
    db.commit()


def start_session(db: Session, identity: dict[str, str], session_id: str) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can start the draft.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="This draft room has already started.")
    players = _players(db, room.id)
    minimum_players = _minimum_players(room)
    if len(players) < minimum_players:
        raise HTTPException(
            status_code=409,
            detail=f"At least {minimum_players} player{'' if minimum_players == 1 else 's'} needed.",
        )

    by_username = {player.username: player for player in players}
    ordered_names = derive_turn_order(room.master_seed, by_username)
    for position, ordered_name in enumerate(ordered_names, start=1):
        by_username[ordered_name].turn_position = position
    room.current_player_id = by_username[ordered_names[0]].id
    room.state = "active"
    room.started_at = utc_now()
    room.turn_started_at = room.started_at
    db.commit()
    return room


def _current_player_or_error(
    db: Session,
    room: FantasyDraftSession,
    username: str,
) -> FantasyDraftPlayer:
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This draft room isn't accepting plays.")
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=409, detail="The current player is unavailable.")
    if player.username != username:
        raise HTTPException(status_code=403, detail=f"It's {player.display_name}'s turn.")
    return player


def _get_or_create_active_round(
    db: Session,
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
) -> FantasyDraftRound:
    round_row = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state == "active",
    ).first()
    if round_row:
        return round_row
    completed = db.query(func.count(FantasyDraftRound.id)).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state.in_(tuple(FINISHED_ROUND_STATES)),
    ).scalar() or 0
    if completed >= ROUNDS_PER_PLAYER:
        raise HTTPException(status_code=409, detail="This player's rounds are complete.")
    round_row = FantasyDraftRound(
        id=str(uuid.uuid4()),
        session_id=room.id,
        player_id=player.id,
        round_number=completed + 1,
        cards_json="[]",
        score=0,
        state="active",
    )
    db.add(round_row)
    db.flush()
    return round_row


def _play_event(
    kind: str,
    player: FantasyDraftPlayer,
    round_row: FantasyDraftRound | None,
    *,
    card: dict[str, Any] | None = None,
    turn_complete: bool = False,
    final_multiplier: int = 1,
) -> dict[str, Any]:
    """One shape for every action, so actor and spectator render the same line."""
    cards = _cards(round_row) if round_row is not None else []
    return {
        "type": kind,
        "playerId": player.id,
        # Normalized name, already public in the roster. Used to decide whether
        # this viewer is allowed to see a sealed final-round card.
        "username": player.username,
        "displayName": player.display_name,
        "isBot": bool(player.is_bot),
        "round": round_row.round_number if round_row is not None else None,
        "card": card,
        "cardCount": len(cards),
        "score": round_row.score if round_row is not None else 0,
        # Raw score plus what the round pays, so "24 points banked" can become
        # "24 doubled to 48" in the last round without the client re-deriving
        # which round the multiplier lands on.
        "multiplier": (
            final_multiplier
            if round_row is not None and round_row.round_number == ROUNDS_PER_PLAYER
            else 1
        ),
        "busted": bool(round_row.busted) if round_row is not None else False,
        "turnComplete": turn_complete,
    }


def _visible_event(
    event: dict[str, Any] | None,
    viewer_normalized: str,
    results_revealed: bool,
) -> dict[str, Any] | None:
    """Same concealment rule the final round applies to cards and scores."""
    if event is None:
        return None
    sealed = (
        event.get("round") == ROUNDS_PER_PLAYER
        and event.get("username") != viewer_normalized
        and not results_revealed
    )
    if not sealed:
        return event
    # The card count stays visible — the play stage already advertises how many
    # cards a sealed hand holds — but nothing that implies a score.
    return {**event, "card": None, "score": None, "busted": None, "sealed": True}


def _record_event(
    db: Session,
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    event: dict[str, Any],
) -> None:
    """Publish what just happened so every poller sees it, not just the actor.

    Before this the event only came back on the acting player's own POST, so a
    spectator polling the room had no way to know a card had been dealt at all.
    """
    room.last_event_json = json.dumps(event, separators=(",", ":"))
    if not event.get("turnComplete"):
        return
    # Recompute here rather than at release time: the score is settled the
    # moment the round ends, and the hold is only about what the table shows.
    finished = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state.in_(tuple(FINISHED_ROUND_STATES)),
    ).all()
    player.final_score = sum(_round_value(room, row) for row in finished)
    room.turn_state = TURN_STATE_RESOLVED
    room.resolved_at = utc_now()


def _close_unplayable_rounds(
    db: Session,
    room: FantasyDraftSession,
    players: list[FantasyDraftPlayer],
    rounds_by_player: dict[str, list[FantasyDraftRound]],
) -> None:
    """Write off legacy rounds a manager could never deal a single card into.

    Version 2 starts every round with a full deck and can never reach this path.
    A version 1 deck holds 52 cards across all five rounds, so a manager who
    presses their luck can run dry. Recording the round at zero keeps an older
    in-flight room moving under the rules it committed to.
    """
    if _uses_fresh_round_decks(room):
        return
    deck_size = len(canonical_deck())
    for player in players:
        player_rounds = rounds_by_player[player.id]
        if sum(len(_cards(row)) for row in player_rounds) < deck_size:
            continue
        settled = {
            row.round_number
            for row in player_rounds
            # A round already holding cards is still playable — it can be banked.
            if row.state in FINISHED_ROUND_STATES or _cards(row)
        }
        closed = False
        for number in range(1, ROUNDS_PER_PLAYER + 1):
            if number in settled:
                continue
            existing = next(
                (row for row in player_rounds if row.round_number == number),
                None,
            )
            if existing is None:
                existing = FantasyDraftRound(
                    id=str(uuid.uuid4()),
                    session_id=room.id,
                    player_id=player.id,
                    round_number=number,
                    cards_json="[]",
                )
                db.add(existing)
                player_rounds.append(existing)
            existing.state = ROUND_STATE_EXHAUSTED
            existing.score = 0
            existing.busted = False
            existing.ended_at = utc_now()
            closed = True
        if closed:
            player.final_score = _round_score_total(room, player_rounds)
            db.flush()


def _advance_turn(db: Session, room: FantasyDraftSession) -> None:
    """Put the next manager on the clock, or close the room out."""
    players = _players(db, room.id)
    all_rounds = _rounds(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in all_rounds:
        rounds_by_player[round_row.player_id].append(round_row)
    _close_unplayable_rounds(db, room, players, rounds_by_player)

    for round_number in range(1, ROUNDS_PER_PLAYER + 1):
        ordered_players = _round_play_order(
            players,
            rounds_by_player,
            room,
            round_number,
        )
        for candidate in ordered_players:
            round_finished = any(
                row.round_number == round_number and row.state in FINISHED_ROUND_STATES
                for row in rounds_by_player[candidate.id]
            )
            if not round_finished:
                room.current_player_id = candidate.id
                room.turn_started_at = utc_now()
                return

    room.current_player_id = None
    room.turn_started_at = None
    room.state = "complete"
    room.completed_at = utc_now()
    if room.mode == MODE_PRACTICE:
        room.revealed_at = room.completed_at


def release_due_turn(db: Session, session_id: str) -> bool:
    """Advance a held turn once the table has shown the result long enough.

    There is no scheduler in this app, so the release rides on whatever request
    arrives next — a spectator's poll, the next player's action, or the host
    opening the room. A held room is therefore never stuck for longer than it
    takes someone to look at it.
    """
    room = db.query(FantasyDraftSession).filter(FantasyDraftSession.id == session_id).first()
    if room is None or not _is_holding(room) or not _hold_expired(room):
        return False
    # Re-read under the row lock so two concurrent polls can't both advance.
    db.expire(room)
    room = _session_or_404(db, session_id, lock=True)
    if not _is_holding(room) or not _hold_expired(room):
        return False
    room.turn_state = TURN_STATE_PLAYING
    room.resolved_at = None
    _advance_turn(db, room)
    db.commit()
    return True


def reveal_results(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> FantasyDraftSession:
    """Open the final scores and proof for the whole room at once."""
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can reveal the final order.")
    if room.state != "complete":
        raise HTTPException(status_code=409, detail="The final round must finish before the reveal.")
    if room.revealed_at is None:
        room.revealed_at = utc_now()
        db.commit()
        db.refresh(room)
    return room


def flip_card(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    release_due_turn(db, session_id)
    room = _session_or_404(db, session_id, lock=True)
    _reject_if_held(room)
    player = _current_player_or_error(db, room, username)
    round_row = _get_or_create_active_round(db, room, player)
    total_flips_used = db.query(func.count(FantasyDraftFlip.id)).filter(
        FantasyDraftFlip.player_id == player.id
    ).scalar() or 0
    previous_cards = _cards(round_row)
    deck_index = (
        len(previous_cards)
        if _uses_fresh_round_decks(room)
        else total_flips_used
    )
    deck = _deck_for_round(room, player, round_row.round_number)
    if deck_index >= len(deck):
        raise HTTPException(status_code=409, detail="No cards remain in this player's deck.")

    code = deck[deck_index]
    busted = _card_rank(code) in {_card_rank(card) for card in previous_cards}
    cards = previous_cards + [code]
    round_row.cards_json = json.dumps(cards, separators=(",", ":"))
    round_row.score = 0 if busted else sum(card_value(card) for card in cards)
    round_row.busted = busted
    db.add(FantasyDraftFlip(
        session_id=room.id,
        player_id=player.id,
        round_id=round_row.id,
        card=code,
        # This column is the player's durable deal sequence. Version 2 exposes
        # the round-local index above while keeping this legacy uniqueness key
        # monotonic, avoiding a destructive schema rewrite for existing rooms.
        deck_index=total_flips_used,
    ))
    if busted:
        round_row.state = "busted"
        round_row.ended_at = utc_now()
    db.flush()
    _record_event(db, room, player, _play_event(
        "flip",
        player,
        round_row,
        card=card_payload(code, deck_index),
        turn_complete=busted,
        final_multiplier=_final_round_multiplier(room),
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="That card was already dealt. Refresh the room.")
    return room


def bank_round(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    release_due_turn(db, session_id)
    room = _session_or_404(db, session_id, lock=True)
    _reject_if_held(room)
    player = _current_player_or_error(db, room, username)
    round_row = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state == "active",
    ).first()
    if round_row is None or not _cards(round_row):
        raise HTTPException(status_code=409, detail="Flip at least one card before banking.")

    round_row.state = "banked"
    round_row.ended_at = utc_now()
    db.flush()
    _record_event(db, room, player, _play_event(
        "bank",
        player,
        round_row,
        turn_complete=True,
        final_multiplier=_final_round_multiplier(room),
    ))
    db.commit()
    return room


def forfeit_current_player(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> tuple[FantasyDraftSession, dict[str, Any]]:
    """Host-only escape hatch for a manager who never comes back.

    Without this a closed laptop strands the room forever: the roster is
    locked, only the current player may act, and the seed stays sealed because
    verification waits on a final score. Every unplayed round is written down
    as a zero so the turn order and each deck still reproduce exactly.
    """
    username, _ = _identity_names(identity)
    release_due_turn(db, session_id)
    room = _session_or_404(db, session_id, lock=True)
    _reject_if_held(room)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can skip a manager.")
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This draft room isn't in play.")
    remaining = _forfeit_grace_remaining(room)
    if remaining > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Give them another {round(remaining)} seconds before skipping them.",
        )
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=409, detail="The current player is unavailable.")

    existing = (
        db.query(FantasyDraftRound)
        .filter(FantasyDraftRound.player_id == player.id)
        .order_by(FantasyDraftRound.round_number)
        .all()
    )
    finished = {row.round_number for row in existing if row.state in FINISHED_ROUND_STATES}
    forfeited_round = None
    for round_row in existing:
        if round_row.state == "active":
            # Cards already dealt stay on the record — the proof should show
            # what was in front of them — but the round is worth nothing.
            round_row.state = "forfeited"
            round_row.score = 0
            round_row.busted = False
            round_row.ended_at = utc_now()
            finished.add(round_row.round_number)
            forfeited_round = round_row
    for number in range(1, ROUNDS_PER_PLAYER + 1):
        if number in finished:
            continue
        db.add(FantasyDraftRound(
            id=str(uuid.uuid4()),
            session_id=room.id,
            player_id=player.id,
            round_number=number,
            cards_json="[]",
            score=0,
            busted=False,
            state="forfeited",
            ended_at=utc_now(),
        ))
    db.flush()
    _record_event(db, room, player, _play_event(
        "forfeit",
        player,
        forfeited_round,
        turn_complete=True,
    ))
    db.commit()
    return room


def _bot_should_bank(
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    round_row: FantasyDraftRound,
) -> bool:
    cards = _cards(round_row)
    context = f"bot-strategy:v1:{player.username}:{round_row.round_number}"
    target = 18 + (int.from_bytes(_context_key(room.master_seed, context)[:2], "big") % 10)
    # A doubled last round is worth pressing for. Left on the normal line, bots
    # bank their usual ~22 in the one round where the bigger half of the prize
    # is still on the table, and a bot table would flatter the leader's odds of
    # holding on compared with a table of managers who can see the multiplier.
    if round_row.round_number == ROUNDS_PER_PLAYER and _final_round_multiplier(room) > 1:
        return len(cards) >= 5 or (len(cards) >= 3 and round_row.score >= target + 6)
    return len(cards) >= 4 or (len(cards) >= 2 and round_row.score >= target)


def play_bot_step(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> FantasyDraftSession:
    """Play a single bot action — one flip, or the bank that ends the round.

    A bot round used to resolve inside one request, so a spectator only ever saw
    the finished result: the cards were dealt and cleared before the board
    rendered. One action per call lets the client pace a bot like a person
    sitting at the table, with every card visible on the way. The bank that ends
    a round then holds the table like any other turn.
    """
    username, _ = _identity_names(identity)
    release_due_turn(db, session_id)
    room = _session_or_404(db, session_id, lock=True)
    _reject_if_held(room)
    if room.mode not in BOT_ROOM_MODES:
        raise HTTPException(status_code=409, detail="There are no bots at this table.")
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can run the bots.")
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This room isn't waiting on a bot.")

    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None or not player.is_bot:
        raise HTTPException(status_code=409, detail="The current turn belongs to a real player.")

    bot_identity = {"username": player.username, "role": accounts.ROLE_MEMBER}
    active_round = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state == "active",
    ).first()
    held = _cards(active_round) if active_round is not None else []
    banking = bool(held) and (
        _bot_should_bank(room, player, active_round)
        # Defensive only: the strategy always banks by card four, or by card
        # five in a doubled final round.
        or len(held) >= 6
    )

    # Both paths publish their own event, and the room's own concealment rules
    # decide what each viewer is allowed to see of it.
    return bank_round(db, bot_identity, session_id) if banking else flip_card(db, bot_identity, session_id)


def list_sessions_for_user(db: Session, identity: dict[str, str]) -> list[dict[str, Any]]:
    """Room cards for the home screen.

    Deliberately not serialize_session: the launcher only needs a name, a state,
    and who's up. Building the full view for a dozen rooms meant a few hundred
    queries and a dozen 52-card shuffles to render text nobody reads.
    """
    username, _ = _identity_names(identity)
    rooms = (
        db.query(FantasyDraftSession)
        .join(FantasyDraftPlayer, FantasyDraftPlayer.session_id == FantasyDraftSession.id)
        .filter(
            FantasyDraftPlayer.username == username,
            # A bot game belongs here for the same reason a league draft does:
            # it is a full five-round game the manager can walk away from and
            # come back to. The solo practice warm-up still stays out.
            FantasyDraftSession.mode.in_((MODE_LEAGUE, MODE_BOTS)),
        )
        .order_by(FantasyDraftSession.created_at.desc())
        .limit(12)
        .all()
    )
    if not rooms:
        return []

    room_ids = [room.id for room in rooms]
    counts = dict(
        db.query(FantasyDraftPlayer.session_id, func.count(FantasyDraftPlayer.id))
        .filter(FantasyDraftPlayer.session_id.in_(room_ids))
        .group_by(FantasyDraftPlayer.session_id)
        .all()
    )
    current_ids = [room.current_player_id for room in rooms if room.current_player_id]
    current_names = dict(
        db.query(FantasyDraftPlayer.id, FantasyDraftPlayer.display_name)
        .filter(FantasyDraftPlayer.id.in_(current_ids))
        .all()
    ) if current_ids else {}

    return [
        {
            "id": room.id,
            "leagueName": room.league_name,
            "mode": room.mode or MODE_LEAGUE,
            "state": room.state,
            "resultsRevealed": bool(room.revealed_at) or room.mode == MODE_PRACTICE,
            "isHost": username == room.created_by,
            "playerCount": counts.get(room.id, 0),
            "currentPlayerName": current_names.get(room.current_player_id),
            "createdAt": room.created_at.isoformat() if room.created_at else None,
        }
        for room in rooms
    ]


def list_all_sessions(db: Session, identity: dict[str, str]) -> list[dict[str, Any]]:
    """Every room on the site, for the admin's cleanup list.

    The launcher above it is scoped to rooms you actually sit in, so this is the
    only place a practice run, a bot test, or somebody else's league is
    reachable — and the only way the admin can clear one out.
    """
    if identity.get("role") != accounts.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only the site admin can list every room.")
    rooms = (
        db.query(FantasyDraftSession)
        .order_by(FantasyDraftSession.created_at.desc())
        .limit(60)
        .all()
    )
    if not rooms:
        return []

    counts = dict(
        db.query(FantasyDraftPlayer.session_id, func.count(FantasyDraftPlayer.id))
        .filter(FantasyDraftPlayer.session_id.in_([room.id for room in rooms]))
        .group_by(FantasyDraftPlayer.session_id)
        .all()
    )
    return [
        {
            "id": room.id,
            "leagueName": room.league_name,
            "mode": room.mode or MODE_LEAGUE,
            "state": room.state,
            "createdBy": room.created_by,
            "playerCount": counts.get(room.id, 0),
            "createdAt": room.created_at.isoformat() if room.created_at else None,
        }
        for room in rooms
    ]


def career_record(db: Session, identity: dict[str, str]) -> dict[str, Any]:
    """What an account has to show for every game it has finished.

    Only rooms whose scores are open count. A completed league draft keeps every
    final-round score sealed until the host reveals it, and a personal best on
    the home screen would be a way around that seal.

    Score is the one number that compares cleanly across modes: it comes only
    from the cards a manager took and when they chose to stop, never from who
    else was at the table. A best set against bots is the same feat as one set
    on draft night.
    """
    username, _ = _identity_names(identity)
    finished = (
        db.query(FantasyDraftPlayer, FantasyDraftSession)
        .join(FantasyDraftSession, FantasyDraftSession.id == FantasyDraftPlayer.session_id)
        .filter(
            FantasyDraftPlayer.username == username,
            FantasyDraftSession.state == "complete",
            or_(
                FantasyDraftSession.revealed_at.isnot(None),
                FantasyDraftSession.mode == MODE_PRACTICE,
            ),
        )
        .all()
    )
    if not finished:
        return {"gamesCompleted": 0, "best": None}

    # Ties on score go to the most recent run, so a repeat of a personal best
    # reads as something that just happened rather than old news.
    player, room = max(
        finished,
        key=lambda row: (row[0].final_score, row[1].completed_at or row[1].created_at),
    )
    players = _players(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in _rounds(db, room.id):
        rounds_by_player[round_row.player_id].append(round_row)
    final_order = _final_order(players, rounds_by_player, room.master_seed)
    return {
        "gamesCompleted": len(finished),
        "best": {
            "score": player.final_score,
            "bestRound": _best_round(rounds_by_player[player.id]),
            "pick": next(
                (
                    place
                    for place, row in enumerate(final_order, start=1)
                    if row.id == player.id
                ),
                None,
            ),
            "playerCount": len(players),
            "sessionId": room.id,
            "leagueName": room.league_name,
            "mode": room.mode or MODE_LEAGUE,
            "completedAt": (room.completed_at or room.created_at).isoformat(),
        },
    }


def verification(db: Session, room: FantasyDraftSession) -> dict[str, Any]:
    if room.state != "complete":
        raise HTTPException(
            status_code=409,
            detail="Verification unlocks after the final score is locked.",
        )
    if room.mode != MODE_PRACTICE and room.revealed_at is None:
        raise HTTPException(
            status_code=409,
            detail="Verification unlocks with the final reveal.",
        )
    players = sorted(_players(db, room.id), key=lambda player: player.turn_position or MAX_PLAYERS + 1)
    all_rounds = _rounds(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in all_rounds:
        rounds_by_player[round_row.player_id].append(round_row)

    fresh_round_decks = _uses_fresh_round_decks(room)
    final_multiplier = _final_round_multiplier(room)
    verification_players = []
    for player in players:
        flips = _player_flips(db, player.id)
        round_number_by_id = {row.id: row.round_number for row in rounds_by_player[player.id]}
        round_draw_counts: dict[int, int] = defaultdict(int)
        draw_payloads = []
        for flip in flips:
            round_number = round_number_by_id[flip.round_id]
            deck_index = round_draw_counts[round_number] if fresh_round_decks else flip.deck_index
            round_draw_counts[round_number] += 1
            draw_payloads.append({
                "round": round_number,
                "deckIndex": deck_index,
                "card": card_payload(flip.card, deck_index),
            })

        player_payload = {
            "playerId": player.id,
            "username": player.username,
            "displayName": player.display_name,
            "turnPosition": player.turn_position,
            "finalScore": player.final_score,
            "tieBreakValue": f"{tie_break_value(room.master_seed, player.username):016x}",
            "draws": draw_payloads,
            "rounds": [
                _round_payload(row, final_multiplier=final_multiplier)
                for row in rounds_by_player[player.id]
            ],
        }
        if fresh_round_decks:
            player_payload["decks"] = [
                {
                    "round": round_number,
                    "cards": [
                        card_payload(code, index)
                        for index, code in enumerate(
                            derive_round_deck(room.master_seed, player.username, round_number)
                        )
                    ],
                }
                for round_number in range(1, ROUNDS_PER_PLAYER + 1)
            ]
        else:
            deck = derive_player_deck(room.master_seed, player.username)
            player_payload["deck"] = [
                card_payload(code, index) for index, code in enumerate(deck)
            ]
        verification_players.append(player_payload)

    draft_order = [
        {
            "pick": pick,
            "playerId": player.id,
            "displayName": player.display_name,
            "score": player.final_score,
            "bestRound": _best_round(rounds_by_player[player.id]),
        }
        for pick, player in enumerate(
            _final_order(players, rounds_by_player, room.master_seed),
            start=1,
        )
    ]

    return {
        "game": _game_version(room),
        "sessionId": room.id,
        "leagueName": room.league_name,
        "roundsPerPlayer": ROUNDS_PER_PLAYER,
        # Published for readers, but a verifier should derive this from "game"
        # rather than believe it — a room that could name its own multiplier
        # could name one that flatters the result.
        "finalRoundMultiplier": final_multiplier,
        "masterSeed": room.master_seed,
        "publishedSeedHash": room.seed_hash,
        "computedSeedHash": seed_commitment(room.master_seed),
        "hashMatches": secrets.compare_digest(room.seed_hash, seed_commitment(room.master_seed)),
        "turnOrder": [player.display_name for player in players],
        "draftOrder": draft_order,
        "players": verification_players,
        "algorithm": {
            "commitment": "SHA-256 of the raw 32-byte master seed, displayed as lowercase hex.",
            "canonicalDeck": "Ranks 2 through A; within each rank: clubs, diamonds, hearts, spades.",
            "derivation": (
                "HMAC-SHA256(master_seed, context) creates a context key. Each random 64-bit "
                "word is the first 8 bytes of HMAC-SHA256(context_key, counter as 8-byte big-endian)."
            ),
            "shuffle": (
                "Fisher-Yates from index 51 down to 1. Rejection sampling removes modulo bias "
                "before choosing swap_index = word mod (index + 1)."
            ),
            "contexts": {
                "turnOrder": "turn-order:v1 over account names sorted lowercase first",
                "playerDeck": (
                    "deck:v2:{normalized account name}:round:{round number} — a fresh deck each round"
                    if fresh_round_decks
                    else "deck:v1:{normalized account name} — one continuous legacy deck"
                ),
                "tieBreak": "first 8 bytes of HMAC-SHA256(master_seed, tiebreak:v1:{normalized account name})",
            },
            "scoring": (
                f"Every round's published score is the raw card total. Round {ROUNDS_PER_PLAYER} "
                f"then counts {final_multiplier}× toward the final score."
                if final_multiplier > 1
                else "Every round's published score is the raw card total and counts once."
            ),
            "tieBreakRule": (
                "Total score (final round doubled), then the best raw round score with no "
                "multiplier applied, then higher seeded tie-break value."
                if final_multiplier > 1
                else "Total score, then best round, then higher seeded tie-break value."
            ),
            "forfeit": (
                "A round in state 'forfeited' was written off by the host after the manager "
                "stopped playing. It scores zero regardless of any cards already dealt."
            ),
            "exhausted": (
                "Only a version 1 room can contain an 'exhausted' round. Its one continuous "
                "deck ran out, so the round scores zero and holds no cards."
            ),
        },
    }


def get_session(db: Session, session_id: str) -> FantasyDraftSession:
    # Reads are what drive the clock: whoever looks at the room next is the one
    # who releases a hand that has been face up long enough.
    release_due_turn(db, session_id)
    return _session_or_404(db, session_id)
