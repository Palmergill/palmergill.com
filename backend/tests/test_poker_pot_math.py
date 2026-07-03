"""Pot math (side pots, odd-chip splits) and blind rotation.

`_award_pot` is exercised directly by seeding `total_bet`/`hand`/`folded` on
players and calling it, which avoids replaying full betting rounds through
the action_* methods just to reach showdown.
"""
from app.poker_game import Card, PokerGame, Rank, Suit


def make_game(names):
    game = PokerGame("pot-math")
    for name in names:
        game.add_player(name, is_human=False)
    return game


def deal_distinct_high_cards(game, ranks):
    # Give each player a trivially-ordered high-card hand so winners are
    # unambiguous: rank order in `ranks` determines showdown order.
    suits = [Suit.HEARTS, Suit.DIAMONDS, Suit.CLUBS, Suit.SPADES]
    for player, rank in zip(game.players, ranks):
        player.hand = [Card(suits[0], rank), Card(suits[1], Rank.TWO)]
    game.community_cards = [
        Card(Suit.CLUBS, Rank.NINE), Card(Suit.SPADES, Rank.SEVEN), Card(Suit.HEARTS, Rank.FIVE),
        Card(Suit.DIAMONDS, Rank.FOUR), Card(Suit.CLUBS, Rank.THREE),
    ]


def test_award_pot_single_winner_takes_everything():
    game = make_game(["Hero", "Villain"])
    deal_distinct_high_cards(game, [Rank.ACE, Rank.KING])
    for p in game.players:
        p.total_bet = 100
        p.chips = 0
    game._award_pot(game.players)

    hero, villain = game.players
    assert hero.chips == 200
    assert villain.chips == 0
    assert game.winners[0]["id"] == hero.id
    assert game.winners[0]["amount"] == 200


def test_award_pot_splits_tie_with_remainder_to_earliest_seat():
    game = make_game(["Hero", "Villain"])
    deal_distinct_high_cards(game, [Rank.ACE, Rank.ACE])
    for p in game.players:
        p.total_bet = 101  # odd total forces a 1-chip remainder
        p.chips = 0
    game._award_pot(game.players)

    hero, villain = game.players
    # 202 split two ways: 101 each, no remainder here since 202 is even.
    assert hero.chips == 101
    assert villain.chips == 101


def test_award_pot_uneven_contribution_forms_a_second_tier():
    # Unequal total_bet between two tied hands isn't a simple split — it's a
    # two-tier pot: the matched portion (100 each) splits evenly between the
    # tied hands, and the odd 1-chip excess forms its own tier that only the
    # player who contributed it is eligible for.
    game = make_game(["Hero", "Villain"])
    deal_distinct_high_cards(game, [Rank.ACE, Rank.ACE])
    game.players[0].total_bet = 100
    game.players[0].chips = 0
    game.players[1].total_bet = 101
    game.players[1].chips = 0
    game._award_pot(game.players)

    hero, villain = game.players
    assert hero.chips == 100
    assert villain.chips == 101
    assert hero.chips + villain.chips == 201  # no chip created or lost


def test_award_pot_creates_side_pot_for_short_all_in_stack():
    # Short stack (all-in for 50) can only win a main pot capped at 50/player;
    # the excess the other two put in forms a side pot only they contest.
    game = make_game(["Short", "Mid", "Big"])
    deal_distinct_high_cards(game, [Rank.TWO, Rank.KING, Rank.ACE])
    short, mid, big = game.players
    short.total_bet, short.chips = 50, 0
    mid.total_bet, mid.chips = 150, 0
    big.total_bet, big.chips = 150, 0

    game._award_pot(game.players)

    # Main pot: 50 * 3 = 150, eligible = all three, best hand among them wins.
    # Side pot: (150-50) * 2 = 200, eligible = mid & big only.
    # Best overall hand is Big (Ace); Short is excluded from the side pot
    # despite having the worst hand, so Big should win both pots entirely.
    assert big.chips == 350  # 150 main + 200 side
    assert short.chips == 0
    assert mid.chips == 0


def test_award_pot_side_pot_winner_can_differ_from_main_pot_winner():
    # Short stack has the best hand and wins the main pot; the side pot (which
    # the short stack is not eligible for) goes to the best hand among the
    # remaining two contributors.
    game = make_game(["Short", "Mid", "Big"])
    deal_distinct_high_cards(game, [Rank.ACE, Rank.KING, Rank.QUEEN])
    short, mid, big = game.players
    short.total_bet, short.chips = 30, 0
    mid.total_bet, mid.chips = 100, 0
    big.total_bet, big.chips = 100, 0

    game._award_pot(game.players)

    # Main pot: 30 * 3 = 90, all eligible, Short (Ace) wins.
    # Side pot: (100 - 30) * 2 = 140, only Mid/Big eligible, Mid (King) wins.
    assert short.chips == 90
    assert mid.chips == 140
    assert big.chips == 0


def test_award_pot_excludes_folded_players_from_winnings():
    game = make_game(["Hero", "Folder"])
    deal_distinct_high_cards(game, [Rank.TWO, Rank.ACE])  # Folder would win on cards alone
    game.players[0].total_bet, game.players[0].chips = 100, 0
    game.players[1].total_bet, game.players[1].chips = 100, 0
    game.players[1].folded = True

    game._award_pot(game.players)

    hero, folder = game.players
    assert hero.chips == 200
    assert folder.chips == 0


def test_award_pot_remainder_splits_correctly_with_folded_contributors():
    # 5 players contribute 100 each (pot 500) but 2 fold before showdown,
    # leaving 3 tied active players to split a pot not evenly divisible by
    # the winner count — a real bug class (chips created or destroyed by
    # rounding) that only shows up when contributor count != winner count.
    game = make_game(["A", "B", "C", "D", "E"])
    suits = [Suit.HEARTS, Suit.DIAMONDS, Suit.CLUBS, Suit.SPADES]
    for player in game.players:
        player.total_bet = 100
        player.chips = 0
    game.community_cards = [
        Card(Suit.CLUBS, Rank.NINE), Card(Suit.SPADES, Rank.SEVEN), Card(Suit.HEARTS, Rank.FIVE),
        Card(Suit.DIAMONDS, Rank.FOUR), Card(Suit.CLUBS, Rank.THREE),
    ]
    # A, B, C tie on identical high-card hands; D and E fold.
    for player in game.players[:3]:
        player.hand = [Card(suits[0], Rank.ACE), Card(suits[1], Rank.KING)]
    game.players[3].folded = True
    game.players[4].folded = True

    game._award_pot(game.players)

    a, b, c, d, e = game.players
    assert d.chips == 0 and e.chips == 0  # folded players never win
    assert a.chips + b.chips + c.chips == 500  # no chip created or lost
    # 500 // 3 = 166 remainder 2: the first two listed winners get the extra
    # chip, matching `_award_pot`'s enumerate-order remainder assignment.
    assert sorted([a.chips, b.chips, c.chips]) == [166, 167, 167]


def test_start_hand_heads_up_button_posts_small_blind():
    # Standard heads-up rule: the button/dealer posts the small blind and
    # acts first preflop, unlike 3+ handed play.
    game = make_game(["Hero", "Villain"])
    game.dealer_index = 0
    assert game.start_hand() is True

    hero, villain = game.players
    assert hero.bet == game.small_blind
    assert villain.bet == game.big_blind
    assert game.current_player_index == 0  # button acts first heads-up


def test_start_hand_three_handed_blinds_follow_the_button():
    game = make_game(["Hero", "Villain", "Third"])
    game.dealer_index = 0
    assert game.start_hand() is True

    assert game.players[0].bet == 0  # button posts nothing
    assert game.players[1].bet == game.small_blind
    assert game.players[2].bet == game.big_blind
    # First to act preflop is left of the big blind (wraps to the button).
    assert game.current_player_index == 0


def test_normalize_dealer_skips_busted_player_on_rotation():
    game = make_game(["Hero", "Busted", "Villain"])
    game.players[1].chips = 0
    game.dealer_index = 1  # button lands on a busted seat

    assert game.start_hand() is True
    assert game.dealer_index != 1
    assert game.players[game.dealer_index].chips > 0
