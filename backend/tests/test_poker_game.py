"""Hold'em rules the engine has got wrong before (2026-11-13 review)."""
from app.poker_ai import AIManager
from app.poker_game import PokerGame


def _table(*names, game_type="multiplayer"):
    game = PokerGame("t")
    game.game_type = game_type
    players = [game.add_player(name, is_human=True) for name in names]
    return game, players


def test_a_small_blind_all_in_on_the_blind_does_not_strand_the_hand():
    # Heads-up, the button posts the small blind. With fewer chips than the
    # blind, that put an all-in player on the clock, where only a fold was
    # accepted. Nobody can bet against them, so the board runs out.
    game, (ann, bo) = _table("Ann", "Bo")
    ann.chips = 6
    game.start_hand()
    assert game.phase == "showdown"
    assert len(game.community_cards) == 5
    assert ann.chips + bo.chips == 1006


def test_a_short_blind_three_handed_passes_the_turn_to_someone_who_can_act():
    game, (ann, bo, cy) = _table("Ann", "Bo", "Cy")
    bo.chips = 5  # small blind, all in on the post
    game.start_hand()
    assert game.phase == "preflop"
    assert not game.get_current_player().is_all_in


def test_a_short_all_in_does_not_reopen_raising_for_those_who_acted():
    game, (a, b, c) = _table("A", "B", "C")
    game.start_hand()  # A on the button acts first, then the blinds B and C
    assert game.action_raise("p0", 100)  # A raises to 120
    b.chips = 125 - b.bet  # B can put in 125 in all: 5 over the raise
    assert game.action_raise("p1", 1000)  # an all-in for less than a full raise
    assert game.action_call("p2")
    assert game.get_current_player().id == "p0"
    assert game.to_dict(for_player="p0")["raise_allowed"] is False
    assert not game.action_raise("p0", 200)
    assert game.action_call("p0")  # calling the extra 5 is still fine
    assert game.phase == "flop"


def test_a_full_raise_still_reopens_raising():
    game, _ = _table("A", "B", "C")
    game.start_hand()
    assert game.action_raise("p0", 100)
    assert game.action_raise("p1", 200)  # a full re-raise
    assert game.action_call("p2")
    assert game.to_dict(for_player="p0")["raise_allowed"] is True
    assert game.action_raise("p0", 300)


def test_a_bot_answering_a_short_all_in_calls_instead_of_folding():
    # A rejected bot action falls back to a fold, so a bot that "raised"
    # here would have thrown its hand away.
    game = PokerGame("b")
    game.game_type = "single"
    manager = AIManager(game)
    bot = manager.add_bot("Alex", personality="mn")
    human = game.add_player("Ann", is_human=True)
    other = game.add_player("Bo", is_human=True)
    game.dealer_index = 0
    game.start_hand()  # Alex on the button acts first
    manager.bots[bot.id].make_decision = lambda g, p: {"action": "raise", "amount": g.min_raise}
    manager.process_bot_turn()  # Alex raises
    human.chips = game.current_bet + 5 - human.bet
    assert game.action_raise(human.id, 1000)  # short all-in
    assert game.action_call(other.id)
    assert game.get_current_player().id == bot.id
    manager.process_bot_turn()
    assert not bot.folded


def test_an_uncalled_winner_keeps_their_cards_hidden():
    game, _ = _table("Ann", "Bo", "Cy")
    game.start_hand()
    while game.phase != "showdown":
        game.action_fold(game.get_current_player().id)
    winner = game.winners[0]
    assert winner["hand"] == []
    view = game.to_dict(for_player="p0")
    shown = {p["id"]: len(p["hand"]) for p in view["players"]}
    assert shown == {"p0": 2, "p1": 0, "p2": 0}


def test_a_contested_showdown_still_shows_the_hands():
    game, _ = _table("Ann", "Bo")
    game.start_hand()
    while game.phase != "showdown":
        current = game.get_current_player()
        assert game.action_call(current.id) or game.action_check(current.id)
    view = game.to_dict(for_player="p0")
    assert all(len(p["hand"]) == 2 for p in view["players"])
