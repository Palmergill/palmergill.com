"""Hand evaluation: every HandRank category plus the kicker tiebreaks that
decide ties within a category. `_evaluate_five_card_hand` is exercised
directly since it needs no game/player setup; `_get_best_hand` is exercised
for the 7-card (2 hole + 5 board) best-of-combinations path used at
showdown.
"""
from app.poker_game import Card, HandRank, PokerGame, Rank, Suit


def five(cards):
    game = PokerGame("hand-eval")
    return game._evaluate_five_card_hand(cards)


def C(rank, suit):
    return Card(suit, rank)


def test_royal_flush():
    hand = [C(Rank.ACE, Suit.SPADES), C(Rank.KING, Suit.SPADES), C(Rank.QUEEN, Suit.SPADES),
            C(Rank.JACK, Suit.SPADES), C(Rank.TEN, Suit.SPADES)]
    assert five(hand) == (HandRank.ROYAL_FLUSH.value, [])


def test_straight_flush():
    hand = [C(Rank.NINE, Suit.HEARTS), C(Rank.EIGHT, Suit.HEARTS), C(Rank.SEVEN, Suit.HEARTS),
            C(Rank.SIX, Suit.HEARTS), C(Rank.FIVE, Suit.HEARTS)]
    assert five(hand) == (HandRank.STRAIGHT_FLUSH.value, [9])


def test_straight_flush_wheel_ace_plays_low():
    # A-2-3-4-5 straight flush: the ace counts as 1, so the high card is 5,
    # not 14 — a hand that once ranked above a 6-high straight flush by
    # mistake would corrupt every ace-low comparison.
    hand = [C(Rank.ACE, Suit.CLUBS), C(Rank.TWO, Suit.CLUBS), C(Rank.THREE, Suit.CLUBS),
            C(Rank.FOUR, Suit.CLUBS), C(Rank.FIVE, Suit.CLUBS)]
    assert five(hand) == (HandRank.STRAIGHT_FLUSH.value, [5])


def test_four_of_a_kind_kicker_breaks_tie():
    quad = [C(Rank.NINE, Suit.HEARTS), C(Rank.NINE, Suit.DIAMONDS), C(Rank.NINE, Suit.CLUBS),
            C(Rank.NINE, Suit.SPADES)]
    high_kicker = five(quad + [C(Rank.ACE, Suit.HEARTS)])
    low_kicker = five(quad + [C(Rank.TWO, Suit.HEARTS)])

    assert high_kicker == (HandRank.FOUR_OF_A_KIND.value, [9, 14])
    assert low_kicker == (HandRank.FOUR_OF_A_KIND.value, [9, 2])
    assert high_kicker > low_kicker


def test_full_house_ranks_by_triple_then_pair():
    hand = [C(Rank.SEVEN, Suit.HEARTS), C(Rank.SEVEN, Suit.DIAMONDS), C(Rank.SEVEN, Suit.CLUBS),
            C(Rank.THREE, Suit.HEARTS), C(Rank.THREE, Suit.DIAMONDS)]
    assert five(hand) == (HandRank.FULL_HOUSE.value, [7, 3])


def test_full_house_beats_flush():
    full_house = five([C(Rank.TWO, Suit.HEARTS), C(Rank.TWO, Suit.DIAMONDS), C(Rank.TWO, Suit.CLUBS),
                        C(Rank.THREE, Suit.HEARTS), C(Rank.THREE, Suit.DIAMONDS)])
    flush = five([C(Rank.ACE, Suit.SPADES), C(Rank.KING, Suit.SPADES), C(Rank.NINE, Suit.SPADES),
                  C(Rank.SEVEN, Suit.SPADES), C(Rank.TWO, Suit.SPADES)])
    assert full_house > flush


def test_flush_ranks_by_full_card_order_not_just_high_card():
    higher_second_card = five([C(Rank.ACE, Suit.SPADES), C(Rank.QUEEN, Suit.SPADES), C(Rank.NINE, Suit.SPADES),
                                C(Rank.SEVEN, Suit.SPADES), C(Rank.TWO, Suit.SPADES)])
    lower_second_card = five([C(Rank.ACE, Suit.HEARTS), C(Rank.JACK, Suit.HEARTS), C(Rank.NINE, Suit.HEARTS),
                               C(Rank.SEVEN, Suit.HEARTS), C(Rank.TWO, Suit.HEARTS)])
    assert higher_second_card > lower_second_card


def test_straight_beats_three_of_a_kind():
    straight = five([C(Rank.SIX, Suit.HEARTS), C(Rank.FIVE, Suit.DIAMONDS), C(Rank.FOUR, Suit.CLUBS),
                      C(Rank.THREE, Suit.SPADES), C(Rank.TWO, Suit.HEARTS)])
    trips = five([C(Rank.KING, Suit.HEARTS), C(Rank.KING, Suit.DIAMONDS), C(Rank.KING, Suit.CLUBS),
                  C(Rank.QUEEN, Suit.HEARTS), C(Rank.JACK, Suit.DIAMONDS)])
    assert straight > trips


def test_wheel_straight_ace_plays_low():
    wheel = five([C(Rank.ACE, Suit.HEARTS), C(Rank.TWO, Suit.DIAMONDS), C(Rank.THREE, Suit.CLUBS),
                  C(Rank.FOUR, Suit.SPADES), C(Rank.FIVE, Suit.HEARTS)])
    assert wheel == (HandRank.STRAIGHT.value, [5])

    six_high = five([C(Rank.SIX, Suit.HEARTS), C(Rank.FIVE, Suit.DIAMONDS), C(Rank.FOUR, Suit.CLUBS),
                      C(Rank.THREE, Suit.SPADES), C(Rank.TWO, Suit.HEARTS)])
    assert six_high > wheel


def test_no_straight_across_the_ace_on_both_ends():
    # Q-K-A-2-3 is not a straight — the ace does not wrap from high to low.
    hand = [C(Rank.QUEEN, Suit.HEARTS), C(Rank.KING, Suit.DIAMONDS), C(Rank.ACE, Suit.CLUBS),
            C(Rank.TWO, Suit.SPADES), C(Rank.THREE, Suit.HEARTS)]
    assert five(hand)[0] == HandRank.HIGH_CARD.value


def test_three_of_a_kind_kickers_break_tie():
    trip = [C(Rank.FIVE, Suit.HEARTS), C(Rank.FIVE, Suit.DIAMONDS), C(Rank.FIVE, Suit.CLUBS)]
    better_kickers = five(trip + [C(Rank.ACE, Suit.HEARTS), C(Rank.KING, Suit.HEARTS)])
    worse_kickers = five(trip + [C(Rank.TEN, Suit.HEARTS), C(Rank.NINE, Suit.HEARTS)])
    assert better_kickers == (HandRank.THREE_OF_A_KIND.value, [5, 14, 13])
    assert better_kickers > worse_kickers


def test_two_pair_ranks_high_pair_then_low_pair_then_kicker():
    higher_pairs = five([C(Rank.KING, Suit.HEARTS), C(Rank.KING, Suit.DIAMONDS), C(Rank.FOUR, Suit.CLUBS),
                          C(Rank.FOUR, Suit.SPADES), C(Rank.TWO, Suit.HEARTS)])
    lower_pairs = five([C(Rank.QUEEN, Suit.HEARTS), C(Rank.QUEEN, Suit.DIAMONDS), C(Rank.JACK, Suit.CLUBS),
                         C(Rank.JACK, Suit.SPADES), C(Rank.ACE, Suit.HEARTS)])
    assert higher_pairs == (HandRank.TWO_PAIR.value, [13, 4, 2])
    assert higher_pairs > lower_pairs


def test_pair_kickers_break_tie_in_descending_order():
    pair = [C(Rank.EIGHT, Suit.HEARTS), C(Rank.EIGHT, Suit.DIAMONDS)]
    better = five(pair + [C(Rank.ACE, Suit.HEARTS), C(Rank.KING, Suit.HEARTS), C(Rank.TWO, Suit.HEARTS)])
    worse = five(pair + [C(Rank.ACE, Suit.HEARTS), C(Rank.QUEEN, Suit.HEARTS), C(Rank.THREE, Suit.HEARTS)])
    assert better == (HandRank.PAIR.value, [8, 14, 13, 2])
    assert better > worse


def test_high_card_ranks_by_full_descending_order():
    better = five([C(Rank.ACE, Suit.HEARTS), C(Rank.JACK, Suit.DIAMONDS), C(Rank.NINE, Suit.CLUBS),
                   C(Rank.SEVEN, Suit.SPADES), C(Rank.TWO, Suit.HEARTS)])
    worse = five([C(Rank.ACE, Suit.HEARTS), C(Rank.JACK, Suit.DIAMONDS), C(Rank.EIGHT, Suit.CLUBS),
                  C(Rank.SEVEN, Suit.SPADES), C(Rank.THREE, Suit.HEARTS)])
    assert better == (HandRank.HIGH_CARD.value, [14, 11, 9, 7, 2])
    assert better > worse


def test_best_hand_picks_best_five_of_seven_cards():
    # Two hole cards plus five community cards: the best five-card
    # combination must be found, not just the first five dealt.
    game = PokerGame("best-of-seven")
    hole = [C(Rank.ACE, Suit.HEARTS), C(Rank.ACE, Suit.DIAMONDS)]
    board = [C(Rank.ACE, Suit.CLUBS), C(Rank.ACE, Suit.SPADES), C(Rank.KING, Suit.HEARTS),
             C(Rank.TWO, Suit.CLUBS), C(Rank.THREE, Suit.DIAMONDS)]
    rank, tiebreak = game._get_best_hand(hole + board)
    assert rank == HandRank.FOUR_OF_A_KIND.value
    assert tiebreak == [14, 13]


def test_hand_rank_ordering_matches_standard_poker_ranking():
    # Sanity check that the enum's declared order is the real ranking order,
    # since every comparison in the engine relies on it.
    ordered = [
        HandRank.HIGH_CARD, HandRank.PAIR, HandRank.TWO_PAIR, HandRank.THREE_OF_A_KIND,
        HandRank.STRAIGHT, HandRank.FLUSH, HandRank.FULL_HOUSE, HandRank.FOUR_OF_A_KIND,
        HandRank.STRAIGHT_FLUSH, HandRank.ROYAL_FLUSH,
    ]
    assert [r.value for r in ordered] == sorted(r.value for r in ordered)
