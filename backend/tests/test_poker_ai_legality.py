"""Poker AI decision legality — not strategy quality. For every game-state
category the AI can face (facing a bet, checked to, short-stack forced
all-in), `make_decision`'s output must be a legal move according to the
engine's own `action_*` validators. We dispatch the decision through those
methods directly (never through AIManager's fold-on-failure fallback) so an
illegal decision surfaces as a failed assertion, not a silently-corrected
fold.
"""
import random

import pytest

from app.poker_ai import PERSONALITIES, PokerAI
from app.poker_game import Card, Deck, PokerGame, Rank, Suit

PERSONALITY_KEYS = list(PERSONALITIES.keys())


def dispatch(game: PokerGame, player, decision: dict) -> bool:
    """Apply an AI decision via the same action_* methods the router uses,
    returning whether the engine accepted it as legal."""
    action = decision["action"]
    if action == "fold":
        return game.action_fold(player.id)
    if action == "check":
        return game.action_check(player.id)
    if action == "call":
        return game.action_call(player.id)
    if action == "raise":
        return game.action_raise(player.id, decision["amount"])
    if action == "all-in":
        to_call = game.current_bet - player.bet
        if player.chips <= to_call:
            return game.action_call(player.id)
        return game.action_raise(player.id, player.chips - to_call)
    raise AssertionError(f"unknown action {action!r}")


def make_bot(personality: str) -> PokerAI:
    p = PERSONALITIES[personality]
    return PokerAI(aggression=p["aggression"], looseness=p["looseness"], personality=personality)


def random_hand(deck: Deck, n=2):
    return deck.deal(n)


def new_heads_up_game(rng: random.Random, actor_chips: int, opponent_bet: int, pot: int, phase="flop"):
    """A minimal heads-up state at the point the AI is about to act: the
    opponent has already bet, the actor has `actor_chips` behind."""
    game = PokerGame(f"legality-{rng.random()}")
    actor = game.add_player("Bot", is_human=False)
    opponent = game.add_player("Opponent", is_human=False)

    actor.chips = actor_chips
    opponent.chips = 1000
    actor.bet = 0
    opponent.bet = opponent_bet
    game.current_bet = opponent_bet
    game.pot = pot
    game.min_raise = game.big_blind
    game.phase = phase

    deck = Deck()
    actor.hand = random_hand(deck)
    opponent.hand = random_hand(deck)
    game.community_cards = deck.deal(3 if phase == "flop" else 5)
    return game, actor


@pytest.mark.parametrize("personality", PERSONALITY_KEYS)
@pytest.mark.parametrize("trial", range(15))
def test_facing_a_bet_produces_a_legal_action(personality, trial):
    rng = random.Random(f"{personality}-{trial}")
    game, actor = new_heads_up_game(rng, actor_chips=800, opponent_bet=100, pot=200)
    bot = make_bot(personality)

    decision = bot.make_decision(game, actor)

    assert dispatch(game, actor, decision) is True
    assert actor.chips >= 0


@pytest.mark.parametrize("personality", PERSONALITY_KEYS)
@pytest.mark.parametrize("trial", range(15))
def test_checked_to_produces_a_legal_action(personality, trial):
    rng = random.Random(f"checked-{personality}-{trial}")
    game, actor = new_heads_up_game(rng, actor_chips=800, opponent_bet=0, pot=200)
    actor.bet = 0
    game.current_bet = 0
    bot = make_bot(personality)

    decision = bot.make_decision(game, actor)

    # Checked to: legal responses are check or raise, never call/fold-on-air
    # since folding a free option is legal but strategically odd — the
    # engine still permits it, so only assert the dispatch succeeds.
    assert dispatch(game, actor, decision) is True
    assert actor.chips >= 0


@pytest.mark.parametrize("personality", PERSONALITY_KEYS)
@pytest.mark.parametrize("trial", range(15))
def test_short_stack_forced_all_in_produces_a_legal_action(personality, trial):
    # Actor has fewer chips than the bet facing them — any call is
    # necessarily all-in, and any raise must be capped at their whole stack.
    rng = random.Random(f"short-{personality}-{trial}")
    game, actor = new_heads_up_game(rng, actor_chips=40, opponent_bet=100, pot=250)
    bot = make_bot(personality)

    decision = bot.make_decision(game, actor)

    assert dispatch(game, actor, decision) is True
    assert actor.chips == 0 or decision["action"] == "fold"


def test_all_in_player_is_never_asked_to_decide():
    # AIManager must not call make_decision for a player who is already
    # all-in; process_bot_turn should skip straight to advancing the turn.
    from app.poker_ai import AIManager

    game = PokerGame("skip-all-in")
    hero = game.add_player("Hero", is_human=False)
    villain = game.add_player("Villain", is_human=False)
    manager = AIManager(game)
    manager.bots[hero.id] = make_bot("std")
    manager.bots[villain.id] = make_bot("std")

    hero.is_all_in = True
    game.current_player_index = 0

    result = manager.process_bot_turn()

    assert result == {"action": "skip", "player": "Hero"}
