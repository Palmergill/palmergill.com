#!/usr/bin/env python3
"""Verify a Fourth & Fortune proof downloaded from the API.

Usage:
    python backend/scripts/verify_draft_order.py proof.json
    curl -s https://example/api/fantasy/draft/sessions/ROOM/verify | \
        python backend/scripts/verify_draft_order.py -
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services import draft_order_game as game  # noqa: E402


def _round_score(cards: list[str]) -> tuple[int, bool]:
    ranks = [code[:-1] for code in cards]
    busted = len(ranks) != len(set(ranks))
    return (0 if busted else sum(game.card_value(code) for code in cards), busted)


def verify_proof(proof: dict) -> list[str]:
    errors: list[str] = []
    seed = str(proof.get("masterSeed", ""))
    try:
        computed_hash = game.seed_commitment(seed)
    except (ValueError, TypeError):
        return ["Master seed is not valid lowercase hexadecimal data."]

    published_hash = proof.get("publishedSeedHash")
    if computed_hash != published_hash:
        errors.append("Published seed commitment does not match the master seed.")

    players = proof.get("players")
    if not isinstance(players, list) or not players:
        return errors + ["Proof contains no players."]

    usernames = [str(player.get("username", "")) for player in players]
    expected_names = game.derive_turn_order(seed, usernames)
    actual_names = [
        player["username"]
        for player in sorted(players, key=lambda player: int(player.get("turnPosition", 10_000)))
    ]
    if actual_names != expected_names:
        errors.append("Turn order does not match the committed seed.")

    fresh_round_decks = proof.get("game") == game.GAME_VERSION
    rounds_per_player = int(proof.get("roundsPerPlayer", game.ROUNDS_PER_PLAYER))

    for player in players:
        label = player.get("displayName") or player.get("username") or "Unknown player"
        username = str(player.get("username", ""))
        expected_decks: dict[int, list[str]] = {}
        deck_mismatch = False
        if fresh_round_decks:
            actual_decks = {
                int(deck_row.get("round", -1)): [
                    card.get("code") for card in deck_row.get("cards", [])
                ]
                for deck_row in player.get("decks", [])
            }
            if (
                len(player.get("decks", [])) != rounds_per_player
                or set(actual_decks) != set(range(1, rounds_per_player + 1))
            ):
                errors.append(f"{label}: proof does not contain one full deck for every round.")
                continue
            for round_number in range(1, rounds_per_player + 1):
                expected_deck = game.derive_round_deck(seed, username, round_number)
                expected_decks[round_number] = expected_deck
                if actual_decks[round_number] != expected_deck:
                    errors.append(
                        f"{label}: round {round_number} full deck does not match the committed seed."
                    )
                    deck_mismatch = True
        else:
            expected_deck = game.derive_player_deck(seed, username)
            expected_decks[0] = expected_deck
            actual_deck = [card.get("code") for card in player.get("deck", [])]
            if actual_deck != expected_deck:
                errors.append(f"{label}: full deck does not match the committed seed.")
                deck_mismatch = True
        if deck_mismatch:
            continue

        draw_sort_key = (
            (lambda draw: (int(draw.get("round", -1)), int(draw.get("deckIndex", -1))))
            if fresh_round_decks
            else (lambda draw: int(draw.get("deckIndex", -1)))
        )
        draws = sorted(player.get("draws", []), key=draw_sort_key)
        next_index_by_round: dict[int, int] = defaultdict(int)
        for draw in draws:
            round_number = int(draw.get("round", -1))
            expected_index = (
                next_index_by_round[round_number]
                if fresh_round_decks
                else sum(next_index_by_round.values())
            )
            index = draw.get("deckIndex")
            code = (draw.get("card") or {}).get("code")
            expected_deck = expected_decks.get(round_number if fresh_round_decks else 0)
            if (
                index != expected_index
                or expected_deck is None
                or expected_index >= len(expected_deck)
                or expected_deck[expected_index] != code
            ):
                errors.append(
                    f"{label}: round {round_number} draw at deck index {expected_index} does not match."
                )
                break
            next_index_by_round[round_number] += 1

        # Every round has to be scored on the cards this manager was actually
        # dealt. Checking the deck and the draws alone leaves the two halves of
        # the proof unjoined: a rewritten hand still reproduces from the seed
        # while the round it belongs to quietly grows a better score.
        dealt_by_round: dict[Any, list[str]] = defaultdict(list)
        for draw in draws:
            dealt_by_round[draw.get("round")].append((draw.get("card") or {}).get("code"))

        final_score = 0
        for round_row in player.get("rounds", []):
            number = round_row.get("number")
            cards = [card.get("code") for card in round_row.get("cards", [])]
            if cards != dealt_by_round.pop(number, []):
                errors.append(
                    f"{label}: round {number} was scored on cards that were never "
                    "dealt to this manager."
                )
            if round_row.get("state") == "forfeited":
                # The host wrote this round off when the manager stopped
                # playing; it is worth nothing whatever was on the table.
                expected_score, expected_bust = 0, False
            else:
                try:
                    expected_score, expected_bust = _round_score(cards)
                except (KeyError, TypeError):
                    errors.append(f"{label}: round {round_row.get('number')} contains an invalid card.")
                    continue
            if expected_score != round_row.get("score") or expected_bust != round_row.get("busted"):
                errors.append(f"{label}: round {round_row.get('number')} score or bust flag is wrong.")
            final_score += expected_score
        # Anything left over was dealt into a round the proof never lists, which
        # is the same tampering seen from the other side.
        for number in sorted(dealt_by_round, key=lambda value: (value is None, value)):
            errors.append(f"{label}: cards were dealt into round {number}, which the proof omits.")
        if final_score != player.get("finalScore"):
            errors.append(f"{label}: final score should be {final_score}, not {player.get('finalScore')}.")

    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: verify_draft_order.py PROOF.json (or - for stdin)", file=sys.stderr)
        return 2
    source = sys.argv[1]
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        proof = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        print(f"Could not read proof: {error}", file=sys.stderr)
        return 2

    errors = verify_proof(proof)
    if errors:
        print("VERIFICATION FAILED")
        for error in errors:
            print(f"- {error}")
        return 1

    print("VERIFIED")
    print(f"League: {proof.get('leagueName', 'Unknown league')}")
    print(f"Seed hash: {proof['publishedSeedHash']}")
    print("Turn order: " + " → ".join(proof.get("turnOrder", [])))
    for player in sorted(proof["players"], key=lambda item: item["turnPosition"]):
        print(f"{player['turnPosition']}. {player['displayName']}: {player['finalScore']} points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
