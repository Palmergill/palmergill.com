"""
Texas Hold'em Poker Game Logic
"""
from dataclasses import dataclass, field
from typing import List, Optional, Dict
from enum import Enum
import random
import time

class Suit(Enum):
    HEARTS = "♥"
    DIAMONDS = "♦"
    CLUBS = "♣"
    SPADES = "♠"

class Rank(Enum):
    TWO = 2
    THREE = 3
    FOUR = 4
    FIVE = 5
    SIX = 6
    SEVEN = 7
    EIGHT = 8
    NINE = 9
    TEN = 10
    JACK = 11
    QUEEN = 12
    KING = 13
    ACE = 14

@dataclass
class Card:
    suit: Suit
    rank: Rank

    def __str__(self):
        rank_str = {11: 'J', 12: 'Q', 13: 'K', 14: 'A'}.get(self.rank.value, str(self.rank.value))
        return f"{rank_str}{self.suit.value}"

    def to_dict(self):
        return {
            'suit': self.suit.name,
            'rank': self.rank.value,
            'display': str(self)
        }

class Deck:
    def __init__(self):
        self.cards: List[Card] = []
        self.reset()

    def reset(self):
        self.cards = [Card(suit, rank) for suit in Suit for rank in Rank]
        random.shuffle(self.cards)

    def deal(self, count: int = 1) -> List[Card]:
        dealt = self.cards[:count]
        self.cards = self.cards[count:]
        return dealt

class HandRank(Enum):
    HIGH_CARD = 1
    PAIR = 2
    TWO_PAIR = 3
    THREE_OF_A_KIND = 4
    STRAIGHT = 5
    FLUSH = 6
    FULL_HOUSE = 7
    FOUR_OF_A_KIND = 8
    STRAIGHT_FLUSH = 9
    ROYAL_FLUSH = 10

@dataclass
class Player:
    id: str
    name: str
    chips: int
    hand: List[Card] = field(default_factory=list)
    bet: int = 0
    total_bet: int = 0  # Total contributed to pot this hand (for side pots)
    folded: bool = False
    is_all_in: bool = False
    is_human: bool = False
    ai_personality: Optional[str] = None
    ai_personality_label: Optional[str] = None

    def to_dict(self, show_cards: bool = False):
        return {
            'id': self.id,
            'name': self.name,
            'chips': self.chips,
            'hand': [c.to_dict() for c in self.hand] if show_cards else [],
            'bet': self.bet,
            'total_bet': self.total_bet,
            'folded': self.folded,
            'is_all_in': self.is_all_in,
            'is_human': self.is_human,
            'ai_personality': self.ai_personality,
            'ai_personality_label': self.ai_personality_label,
        }


class PokerGame:
    def __init__(self, game_id: str):
        self.game_id = game_id
        self.players: List[Player] = []
        self.deck = Deck()
        self.community_cards: List[Card] = []
        self.pot: int = 0
        self.current_bet: int = 0
        self.dealer_index: int = 0
        self.current_player_index: int = 0
        self.small_blind: int = 10
        self.big_blind: int = 20
        self.phase: str = 'waiting'  # waiting, preflop, flop, turn, river, showdown
        self.round_bets: Dict[str, int] = {}  # Track bets per player for this round
        self.min_raise: int = 20
        self.winners: List[Dict] = []
        self.last_action: Optional[Dict] = None
        self.last_ai_action: Optional[Dict] = None  # Track last AI action for display
        self.hand_number: int = 0
        self.acted_this_round: set = set()  # Track who has acted in current betting round
        self.round_start_player: int = 0  # Who started this betting round
        # Multiplayer support
        self.game_type = "single"  # "single", "multiplayer", or "tournament"
        self.max_players = 6
        self.waiting_for_players = False
        # Tournament state. Blinds escalate every `hands_per_level` hands using
        # a fixed schedule. Eliminated players stay in `players` (for ranking)
        # but with chips=0. Tournament ends when only one entrant has chips.
        self.tournament: Optional[Dict] = None

    def add_player(self, name: str, is_human: bool = False) -> Player:
        player_id = f"p{len(self.players)}"
        player = Player(
            id=player_id,
            name=name,
            chips=1000,
            is_human=is_human
        )
        self.players.append(player)
        return player

    # ── Tournament helpers ───────────────────────────────────────────────
    TOURNAMENT_BLIND_SCHEDULE = [
        (10, 20),
        (15, 30),
        (25, 50),
        (50, 100),
        (75, 150),
        (100, 200),
        (150, 300),
        (200, 400),
        (300, 600),
        (500, 1000),
        (750, 1500),
        (1000, 2000),
    ]
    TOURNAMENT_STARTING_CHIPS = 1500
    TOURNAMENT_HANDS_PER_LEVEL = 6

    def configure_tournament(self) -> None:
        """Switch the game into tournament mode. Must be called before start_hand."""
        self.game_type = "tournament"
        for player in self.players:
            player.chips = self.TOURNAMENT_STARTING_CHIPS
        sb, bb = self.TOURNAMENT_BLIND_SCHEDULE[0]
        self.small_blind = sb
        self.big_blind = bb
        self.tournament = {
            "level": 1,
            "hands_per_level": self.TOURNAMENT_HANDS_PER_LEVEL,
            "schedule": list(self.TOURNAMENT_BLIND_SCHEDULE),
            "eliminated": [],          # player ids in elimination order
            "started_at": time.time(),
        }

    def _advance_tournament_level(self) -> None:
        """Bump blinds based on hand number. Called at the top of start_hand."""
        if not self.tournament:
            return
        schedule = self.tournament.get("schedule") or list(self.TOURNAMENT_BLIND_SCHEDULE)
        per_level = max(1, int(self.tournament.get("hands_per_level") or self.TOURNAMENT_HANDS_PER_LEVEL))
        # hand_number was already incremented when this is called.
        level_idx = min(len(schedule) - 1, (self.hand_number - 1) // per_level)
        sb, bb = schedule[level_idx]
        self.small_blind = sb
        self.big_blind = bb
        self.tournament["level"] = level_idx + 1

    def _record_tournament_eliminations(self) -> None:
        """Mark any zero-chip players eliminated, preserving order."""
        if not self.tournament:
            return
        eliminated = self.tournament.setdefault("eliminated", [])
        for player in self.players:
            if player.chips <= 0 and player.id not in eliminated:
                eliminated.append(player.id)

    def tournament_is_over(self) -> bool:
        if not self.tournament:
            return False
        return sum(1 for p in self.players if p.chips > 0) <= 1

    def tournament_standings(self) -> List[Dict]:
        """Standings ordered from winner down. Eliminated players land last."""
        if not self.tournament:
            return []
        eliminated_ids = list(self.tournament.get("eliminated", []))
        # Survivors sorted by chips desc are the lead pack.
        survivors = sorted(
            [p for p in self.players if p.chips > 0],
            key=lambda p: -p.chips,
        )
        # Eliminations reversed: latest-out finishes higher than earliest-out.
        eliminated_players = []
        for pid in reversed(eliminated_ids):
            for p in self.players:
                if p.id == pid:
                    eliminated_players.append(p)
                    break
        ranked = survivors + eliminated_players
        return [
            {
                "rank": idx + 1,
                "player_id": p.id,
                "name": p.name,
                "chips": p.chips,
            }
            for idx, p in enumerate(ranked)
        ]

    def _eligible_player_indices(self) -> List[int]:
        # A zero-chip player (busted in a cash game, eliminated in a
        # tournament) can't post a blind or make a decision that means
        # anything, so they sit out until they buy back — in every game
        # mode, not just tournaments.
        return [idx for idx, player in enumerate(self.players) if player.chips > 0]

    def _normalize_dealer(self, eligible_indices: List[int]) -> None:
        if self.dealer_index in eligible_indices or not eligible_indices:
            return
        for offset in range(1, len(self.players) + 1):
            idx = (self.dealer_index + offset) % len(self.players)
            if idx in eligible_indices:
                self.dealer_index = idx
                return

    def start_hand(self):
        if len(self.players) < 2:
            return False

        # In tournaments, eliminated players can't take their seat. Bail early
        # if only one player has chips left.
        if self.tournament and self.tournament_is_over():
            self.phase = "showdown"
            self.winners = self.tournament_standings()[:1]
            return False

        eligible_indices = self._eligible_player_indices()
        if len(eligible_indices) < 2:
            self.phase = "showdown"
            self.winners = self.tournament_standings()[:1] if self.tournament else []
            return False

        self._normalize_dealer(eligible_indices)

        self.hand_number += 1
        if self.tournament:
            self._advance_tournament_level()
        self.deck.reset()
        self.community_cards = []
        self.pot = 0
        self.current_bet = 0
        self.phase = 'preflop'
        self.round_bets = {}
        self.winners = []
        self.last_action = None

        # Reset players
        eligible_set = set(eligible_indices)
        for idx, player in enumerate(self.players):
            player.hand = []
            player.bet = 0
            player.total_bet = 0
            if idx not in eligible_set:
                player.folded = True
                player.is_all_in = True
            else:
                player.folded = False
                player.is_all_in = False

        # Deal cards
        for _ in range(2):
            for idx in eligible_indices:
                self.players[idx].hand.extend(self.deck.deal(1))

        # Post blinds. Heads-up is special: the button posts the small blind
        # and acts first preflop.
        dealer_pos = eligible_indices.index(self.dealer_index)
        if len(eligible_indices) == 2:
            sb_index = self.dealer_index
            bb_index = eligible_indices[(dealer_pos + 1) % len(eligible_indices)]
        else:
            sb_index = eligible_indices[(dealer_pos + 1) % len(eligible_indices)]
            bb_index = eligible_indices[(dealer_pos + 2) % len(eligible_indices)]

        self._post_blind(self.players[sb_index], self.small_blind)
        self._post_blind(self.players[bb_index], self.big_blind)

        self.current_bet = self.big_blind
        bb_pos = eligible_indices.index(bb_index)
        self.current_player_index = (
            sb_index
            if len(eligible_indices) == 2
            else eligible_indices[(bb_pos + 1) % len(eligible_indices)]
        )
        self.min_raise = self.big_blind
        self.acted_this_round = set()
        self.round_start_player = self.current_player_index

        return True

    def _post_blind(self, player: Player, amount: int):
        actual_bet = min(amount, player.chips)
        player.chips -= actual_bet
        player.bet = actual_bet
        player.total_bet = actual_bet
        self.pot += actual_bet
        self.round_bets[player.id] = actual_bet

        if player.chips == 0:
            player.is_all_in = True

    def get_current_player(self) -> Optional[Player]:
        if not self.players:
            return None

        player = self.players[self.current_player_index]
        # Only skip folded players - all-in players need to be "current" for _is_round_complete
        if not player.folded:
            return player

        # If current player folded, find next non-folded player
        for _ in range(len(self.players)):
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            player = self.players[self.current_player_index]
            if not player.folded:
                return player

        return None

    def action_fold(self, player_id: str) -> bool:
        player = self._get_player(player_id)
        if not player or player.folded:
            return False

        player.folded = True
        self.acted_this_round.add(player_id)
        self.last_action = {'player': player.name, 'action': 'fold'}

        if self._is_round_complete():
            self._advance_phase()
        else:
            self._next_player()

        return True

    def action_check(self, player_id: str) -> bool:
        player = self._get_player(player_id)
        if not player or player.folded or player.is_all_in:
            return False

        if player.bet < self.current_bet:
            return False  # Can't check, must call or raise

        self.acted_this_round.add(player_id)
        self.last_action = {'player': player.name, 'action': 'check'}

        if self._is_round_complete():
            self._advance_phase()
        else:
            self._next_player()

        return True

    def action_call(self, player_id: str) -> bool:
        player = self._get_player(player_id)
        if not player or player.folded or player.is_all_in:
            return False

        call_amount = self.current_bet - player.bet
        if call_amount <= 0:
            return self.action_check(player_id)

        actual_call = min(call_amount, player.chips)
        player.chips -= actual_call
        player.bet += actual_call
        player.total_bet += actual_call
        self.pot += actual_call
        self.acted_this_round.add(player_id)

        if player.chips == 0:
            player.is_all_in = True
            self.last_action = {'player': player.name, 'action': 'all-in'}
        else:
            self.last_action = {'player': player.name, 'action': 'call', 'amount': actual_call}

        if self._is_round_complete():
            self._advance_phase()
        else:
            self._next_player()

        return True

    def action_raise(self, player_id: str, amount: int) -> bool:
        player = self._get_player(player_id)
        if not player or player.folded or player.is_all_in:
            return False

        call_amount = self.current_bet - player.bet
        total_needed = call_amount + amount

        # Strict inequality here is load-bearing: when chips == total_needed
        # the player can only commit by going all-in, so we accept under-min
        # amounts (handled in the all-in branch below). Flipping to >= would
        # silently reject legitimate all-ins.
        if amount < self.min_raise and player.chips > total_needed:
            return False  # Raise too small

        if player.chips <= total_needed:
            # All-in raise
            actual_raise = player.chips - call_amount
            player.chips = 0
            player.bet += call_amount + actual_raise
            player.total_bet += call_amount + actual_raise
            self.pot += call_amount + actual_raise
            player.is_all_in = True

            if player.bet > self.current_bet:
                self.current_bet = player.bet
                # An all-in that constitutes a full raise reopens action and
                # raises the min. An under-min all-in does neither: players
                # who already acted only get to call/fold the extra, not
                # re-raise. This matches standard no-limit hold'em rules.
                if actual_raise >= self.min_raise:
                    self.min_raise = actual_raise
                    self.acted_this_round = {player_id}
                else:
                    self.acted_this_round.add(player_id)
            else:
                # All-in for less than the call amount — not a raise at all.
                self.acted_this_round.add(player_id)

            self.last_action = {'player': player.name, 'action': 'all-in', 'amount': player.bet}
        else:
            # A full raise resets who has acted (everyone gets to act again)
            self.acted_this_round = {player_id}
            player.chips -= total_needed
            player.bet += total_needed
            player.total_bet += total_needed
            self.pot += total_needed
            self.current_bet = player.bet
            self.min_raise = amount
            self.last_action = {'player': player.name, 'action': 'raise', 'amount': amount}

        if self._is_round_complete():
            self._advance_phase()
        else:
            self._next_player()

        return True

    def _get_player(self, player_id: str) -> Optional[Player]:
        for p in self.players:
            if p.id == player_id:
                return p
        return None

    def _next_player(self):
        for _ in range(len(self.players)):
            self.current_player_index = (self.current_player_index + 1) % len(self.players)
            player = self.players[self.current_player_index]
            # Skip folded and all-in players (they don't need to act)
            if not player.folded and not player.is_all_in:
                break

    def _is_round_complete(self) -> bool:
        active_players = [p for p in self.players if not p.folded and not p.is_all_in]
        non_folded = [p for p in self.players if not p.folded]

        if len(non_folded) <= 1:
            return True

        # All-in players who could not cover the bet do not block the round.
        for p in active_players:
            if p.bet < self.current_bet:
                return False

        # Check if all active players have had a chance to act
        for p in active_players:
            if p.id not in self.acted_this_round:
                return False

        # If there's only one active player left and they've acted, round is complete
        # (everyone else is all-in or folded)
        return True

    def _betting_is_closed(self) -> bool:
        """Return True when no future betting action is possible."""
        non_folded = [p for p in self.players if not p.folded]
        players_who_can_bet = [p for p in non_folded if not p.is_all_in]
        return len(non_folded) > 1 and len(players_who_can_bet) <= 1

    def _advance_phase(self):
        active_players = [p for p in self.players if not p.folded]

        if len(active_players) == 1:
            # Everyone folded, hand is over
            self._award_pot([active_players[0]])
            self.phase = 'showdown'
            return

        if self._betting_is_closed():
            self._run_out_board()
            return

        # Reset bets for new round
        for p in self.players:
            p.bet = 0
        self.current_bet = 0
        self.min_raise = self.big_blind

        if self.phase == 'preflop':
            self.phase = 'flop'
            self.community_cards.extend(self.deck.deal(3))
        elif self.phase == 'flop':
            self.phase = 'turn'
            self.community_cards.extend(self.deck.deal(1))
        elif self.phase == 'turn':
            self.phase = 'river'
            self.community_cards.extend(self.deck.deal(1))
        elif self.phase == 'river':
            self.phase = 'showdown'
            self._evaluate_hands()
            return

        # Reset round tracking
        self.acted_this_round = set()

        # Defensive: if no one can act (everyone left is folded or all-in),
        # `_betting_is_closed()` should have routed us to `_run_out_board()`
        # already. If that invariant ever breaks we'd otherwise spin forever
        # looking for the next actor — run out the board instead.
        if not any(not p.folded and not p.is_all_in for p in self.players):
            self._run_out_board()
            return

        # Find first active player after dealer for next round (skip folded players only)
        # All-in players still get cards dealt, they just don't bet
        self.current_player_index = (self.dealer_index + 1) % len(self.players)
        while self.players[self.current_player_index].folded or self.players[self.current_player_index].is_all_in:
            self.current_player_index = (self.current_player_index + 1) % len(self.players)

        self.round_start_player = self.current_player_index

    def _run_out_board(self):
        """Deal remaining community cards and resolve the hand."""
        while len(self.community_cards) < 5:
            self.community_cards.extend(self.deck.deal(1))
        self.phase = 'showdown'
        self._evaluate_hands()

    def _evaluate_hands(self):
        active_players = [p for p in self.players if not p.folded]

        if len(active_players) == 1:
            self._award_pot([active_players[0]])
            return

        # Evaluate each hand
        hand_evaluations = []
        for player in active_players:
            best_hand = self._get_best_hand(player.hand + self.community_cards)
            hand_evaluations.append((player, best_hand))

        # Sort by hand strength (highest first)
        hand_evaluations.sort(key=lambda x: x[1], reverse=True)

        # Find winners (could be tie)
        best_hand = hand_evaluations[0][1]
        winners = [p for p, h in hand_evaluations if h == best_hand]

        self._award_pot(winners)

    def _get_best_hand(self, cards: List[Card]) -> tuple:
        """Returns tuple (hand_rank, tiebreakers) for comparing hands"""
        from itertools import combinations

        best = (HandRank.HIGH_CARD.value, [0])

        for combo in combinations(cards, 5):
            rank = self._evaluate_five_card_hand(list(combo))
            if rank > best:
                best = rank

        return best

    def _get_best_hand_cards(self, cards: List[Card]) -> List[Card]:
        """Returns the actual 5 cards that make up the best hand"""
        from itertools import combinations

        best_rank = (HandRank.HIGH_CARD.value, [0])
        best_cards = cards[:5]  # Default to first 5

        for combo in combinations(cards, 5):
            rank = self._evaluate_five_card_hand(list(combo))
            if rank > best_rank:
                best_rank = rank
                best_cards = list(combo)

        return best_cards

    def _evaluate_five_card_hand(self, cards: List[Card]) -> tuple:
        """Evaluate a 5-card hand and return (rank, tiebreakers)"""
        ranks = sorted([c.rank.value for c in cards], reverse=True)
        suits = [c.suit for c in cards]

        is_flush = len(set(suits)) == 1
        straight_high = self._straight_high(ranks)
        is_straight = straight_high is not None

        # Royal Flush / Straight Flush
        if is_flush and is_straight:
            if straight_high == 14:
                return (HandRank.ROYAL_FLUSH.value, [])
            return (HandRank.STRAIGHT_FLUSH.value, [straight_high])

        # Count ranks
        rank_counts = {}
        for r in ranks:
            rank_counts[r] = rank_counts.get(r, 0) + 1

        counts = sorted(rank_counts.values(), reverse=True)

        # Four of a Kind
        if counts[0] == 4:
            quad_rank = [r for r, c in rank_counts.items() if c == 4][0]
            kicker = [r for r in ranks if r != quad_rank][0]
            return (HandRank.FOUR_OF_A_KIND.value, [quad_rank, kicker])

        # Full House
        if counts[0] == 3 and counts[1] == 2:
            trip_rank = [r for r, c in rank_counts.items() if c == 3][0]
            pair_rank = [r for r, c in rank_counts.items() if c == 2][0]
            return (HandRank.FULL_HOUSE.value, [trip_rank, pair_rank])

        # Flush
        if is_flush:
            return (HandRank.FLUSH.value, ranks)

        # Straight
        if is_straight:
            return (HandRank.STRAIGHT.value, [straight_high])

        # Three of a Kind
        if counts[0] == 3:
            trip_rank = [r for r, c in rank_counts.items() if c == 3][0]
            kickers = [r for r in ranks if r != trip_rank]
            return (HandRank.THREE_OF_A_KIND.value, [trip_rank] + kickers)

        # Two Pair
        if counts[0] == 2 and counts[1] == 2:
            pairs = sorted([r for r, c in rank_counts.items() if c == 2], reverse=True)
            kicker = [r for r in ranks if r not in pairs][0]
            return (HandRank.TWO_PAIR.value, pairs + [kicker])

        # Pair
        if counts[0] == 2:
            pair_rank = [r for r, c in rank_counts.items() if c == 2][0]
            kickers = [r for r in ranks if r != pair_rank]
            return (HandRank.PAIR.value, [pair_rank] + kickers)

        # High Card
        return (HandRank.HIGH_CARD.value, ranks)

    def _straight_high(self, ranks: List[int]) -> Optional[int]:
        unique = sorted(set(ranks), reverse=True)
        if len(unique) < 5:
            return None

        # Check for regular straight
        for i in range(len(unique) - 4):
            if unique[i] - unique[i+4] == 4:
                return unique[i]

        # Check for A-5 straight (wheel) - Ace counts as 1
        if 14 in unique and 2 in unique and 3 in unique and 4 in unique and 5 in unique:
            return 5

        return None

    def _award_pot(self, winners: List[Player]):
        """Award pot with proper side pot calculation"""
        active_players = [p for p in self.players if not p.folded]
        # Include folded players for size calculation so their chips aren't lost
        all_sorted = sorted(self.players, key=lambda p: p.total_bet)

        # Calculate side pots
        side_pots = []
        previous_bet = 0

        for player in all_sorted:
            if player.total_bet > previous_bet:
                # Contributors to this tier: everyone who put in at least this much
                contributors = [p for p in all_sorted if p.total_bet >= player.total_bet]
                pot_size = (player.total_bet - previous_bet) * len(contributors)
                # Only non-folded players can win this tier
                eligible_players = [p for p in active_players if p.total_bet >= player.total_bet]
                if not eligible_players:
                    eligible_players = active_players
                side_pots.append({
                    'size': pot_size,
                    'eligible': eligible_players,
                    'bet_level': player.total_bet
                })
                previous_bet = player.total_bet

        # Award each side pot
        total_winnings = {p.id: 0 for p in active_players}

        for pot in side_pots:
            # Find the best hand among eligible players
            eligible = pot['eligible']
            if len(eligible) == 1:
                # Only one eligible player, they win the whole pot
                pot_winners = eligible
            else:
                # Evaluate hands and find winner(s)
                hand_evaluations = []
                for p in eligible:
                    best = self._get_best_hand(p.hand + self.community_cards)
                    hand_evaluations.append((p, best))
                hand_evaluations.sort(key=lambda x: x[1], reverse=True)
                best_hand = hand_evaluations[0][1]
                pot_winners = [p for p, h in hand_evaluations if h == best_hand]

            # Split the pot among winners
            split = pot['size'] // len(pot_winners)
            remainder = pot['size'] % len(pot_winners)
            for i, w in enumerate(pot_winners):
                amount = split + (1 if i < remainder else 0)
                total_winnings[w.id] += amount
                w.chips += amount

        # Set winners for display with best 5-card hand
        self.winners = []
        for p in active_players:
            if total_winnings[p.id] > 0:
                # Get the best 5-card hand for this player
                best_hand_cards = self._get_best_hand_cards(p.hand + self.community_cards)
                self.winners.append({
                    'id': p.id,
                    'name': p.name,
                    'amount': total_winnings[p.id],
                    'hand': [c.to_dict() for c in best_hand_cards]
                })

        # Tournament: mark any newly busted player eliminated. Order matters
        # for final standings, so capture this right after winnings settle.
        self._record_tournament_eliminations()

    def to_dict(self, for_player: Optional[str] = None) -> dict:
        """Convert game state to dict for API response"""
        # get_current_player mutates current_player_index when the current
        # slot is folded — avoid calling it twice from a serializer.
        current = self.get_current_player()
        hands_per_level = (
            self.tournament.get('hands_per_level', self.TOURNAMENT_HANDS_PER_LEVEL)
            if self.tournament else self.TOURNAMENT_HANDS_PER_LEVEL
        )
        return {
            'game_id': self.game_id,
            'phase': self.phase,
            'pot': self.pot,
            'current_bet': self.current_bet,
            'community_cards': [c.to_dict() for c in self.community_cards],
            'players': [
                p.to_dict(show_cards=for_player == p.id or (self.phase == 'showdown' and not p.folded))
                for p in self.players
            ],
            'current_player': current.id if current else None,
            'dealer_index': self.dealer_index,
            'winners': self.winners,
            'last_action': self.last_action,
            'last_ai_action': self.last_ai_action,
            'hand_number': self.hand_number,
            'min_raise': self.min_raise,
            'game_type': getattr(self, 'game_type', 'single'),
            'max_players': getattr(self, 'max_players', 6),
            'waiting_for_players': getattr(self, 'waiting_for_players', False),
            'small_blind': self.small_blind,
            'big_blind': self.big_blind,
            'tournament': {
                'level': self.tournament.get('level', 1),
                'hands_per_level': hands_per_level,
                # When hand_number is an exact multiple of hands_per_level
                # the next hand starts a new level (0 hands remaining), not
                # a full level away.
                'next_level_in': (hands_per_level - self.hand_number % hands_per_level) % hands_per_level,
                'eliminated': list(self.tournament.get('eliminated', [])),
                'standings': self.tournament_standings(),
                'over': self.tournament_is_over(),
            } if self.tournament else None,
        }
