"""
AI Bot for Texas Hold'em Poker
"""
import random
import time
from typing import Optional
from app.poker_game import PokerGame, Player, Card, HandRank

# Personality archetypes. Each one bundles an aggression dial (how often the bot
# bets/raises when it could call/check) with a looseness dial (how thin the
# bot is willing to play marginal hands). A "name" surfaces in the UI as flavor.
PERSONALITIES: dict[str, dict] = {
    # Plays few hands, but punishes hard when in. Solid TAG.
    "tag": {"label": "Tight-Aggressive", "aggression": 0.7, "looseness": 0.25},
    # Limps and calls a lot, rarely raises. Easy money on the river.
    "lp":  {"label": "Loose-Passive",    "aggression": 0.2, "looseness": 0.7},
    # Wild bluffer who bets pots on air. High variance.
    "mn":  {"label": "Maniac",           "aggression": 0.95, "looseness": 0.85},
    # Balanced opponent — the default before personalities existed.
    "std": {"label": "Standard",         "aggression": 0.5, "looseness": 0.5},
    # Disciplined and risk-averse. Folds anything marginal.
    "rock": {"label": "Rock",            "aggression": 0.35, "looseness": 0.15},
}


class PokerAI:
    """Poker AI with adjustable aggression + looseness for distinct personalities"""

    def __init__(self, aggression: float = 0.5, looseness: float = 0.5, personality: str | None = None):
        self.aggression = max(0.0, min(1.0, aggression))
        self.looseness = max(0.0, min(1.0, looseness))
        self.personality = personality
    
    def make_decision(self, game: PokerGame, player: Player) -> dict:
        """Returns action dict with 'action' and optional 'amount'"""
        hand_strength = self._estimate_hand_strength(game, player)
        pot_odds = self._calculate_pot_odds(game, player)
        to_call = game.current_bet - player.bet

        # Looseness shifts the strength thresholds: a loose bot will call/raise
        # with weaker hands than a tight bot at the same hand strength.
        loose_shift = (self.looseness - 0.5) * 0.2  # +/-0.1 around the defaults

        very_strong = 0.85 - loose_shift
        strong = 0.7 - loose_shift
        medium = 0.45 - loose_shift

        # Very strong hand - raise or all-in
        if hand_strength > very_strong:
            if player.chips > to_call + game.min_raise:
                raise_amount = min(
                    player.chips - to_call,
                    max(game.min_raise, int(game.pot * 0.75))
                )
                return {'action': 'raise', 'amount': raise_amount}
            elif player.chips > to_call:
                return {'action': 'all-in'}
            else:
                return {'action': 'call'}

        # Strong hand - raise or call
        if hand_strength > strong:
            if random.random() < self.aggression and player.chips > to_call + game.min_raise:
                raise_amount = min(game.min_raise * 2, player.chips - to_call)
                return {'action': 'raise', 'amount': raise_amount}
            elif to_call == 0:
                return {'action': 'check'}
            else:
                return {'action': 'call'}

        # Medium hand - call if good pot odds, otherwise fold
        if hand_strength > medium:
            if to_call == 0:
                return {'action': 'check'}
            elif pot_odds > 0.3 or hand_strength > pot_odds * 1.5:
                return {'action': 'call'}
            else:
                return {'action': 'fold'}

        # Weak hand - fold unless free to check.
        # Maniacs bluff far more often here; rocks almost never do.
        if to_call == 0:
            bluff_freq = self.aggression * 0.15 + (self.looseness - 0.5) * 0.1
            if random.random() < max(0.0, bluff_freq):
                raise_amount = min(game.min_raise, player.chips)
                return {'action': 'raise', 'amount': raise_amount}
            return {'action': 'check'}

        # Facing a bet with a weak hand. Loose bots float occasionally.
        if random.random() < self.looseness * 0.1 and player.chips > to_call:
            return {'action': 'call'}
        return {'action': 'fold'}
    
    def _estimate_hand_strength(self, game: PokerGame, player: Player) -> float:
        """Estimate hand strength from 0-1 using Monte Carlo simulation"""
        from app.poker_game import Deck
        
        if game.phase == 'preflop':
            return self._preflop_strength(player.hand)
        
        # Run Monte Carlo simulation
        wins = 0
        trials = 100
        
        known_cards = player.hand + game.community_cards
        deck = Deck()
        deck.cards = [c for c in deck.cards if c not in known_cards]
        
        for _ in range(trials):
            deck_copy = deck.cards.copy()
            random.shuffle(deck_copy)
            
            # Complete community cards
            remaining_community = 5 - len(game.community_cards)
            simulated_community = game.community_cards + deck_copy[:remaining_community]
            
            # Opponent hand
            opponent_hand = deck_copy[remaining_community:remaining_community+2]
            
            # Compare hands
            my_best = game._get_best_hand(player.hand + simulated_community)
            opp_best = game._get_best_hand(opponent_hand + simulated_community)
            
            if my_best > opp_best:
                wins += 1
            elif my_best == opp_best:
                wins += 0.5
        
        return wins / trials
    
    def _preflop_strength(self, hand: list) -> float:
        """Quick estimate of preflop hand strength"""
        if len(hand) != 2:
            return 0.5
        
        r1, r2 = hand[0].rank.value, hand[1].rank.value
        suited = hand[0].suit == hand[1].suit
        
        # Premium pairs
        if r1 == r2:
            if r1 >= 10:
                return 0.9
            elif r1 >= 7:
                return 0.75
            else:
                return 0.5 + (r1 / 20)
        
        # High cards
        high = max(r1, r2)
        low = min(r1, r2)
        
        # AK, AQ, AJ, AT
        if high == 14:
            if low >= 10:
                return 0.8 if suited else 0.7
            elif low >= 8:
                return 0.65 if suited else 0.55
        
        # KQ, KJ, QJ
        if high == 13 and low >= 11:
            return 0.65 if suited else 0.55
        
        # Suited connectors
        if suited and abs(r1 - r2) <= 2 and high >= 10:
            return 0.6
        
        # Any suited
        if suited and high >= 10:
            return 0.5
        
        # Weak hand
        return 0.3 + (high / 50)
    
    def _calculate_pot_odds(self, game: PokerGame, player: Player) -> float:
        """Calculate pot odds (what % of pot we need to call)"""
        to_call = game.current_bet - player.bet
        if to_call <= 0:
            return 1.0  # Free to check
        
        return to_call / (game.pot + to_call)


class AIManager:
    """Manages AI bots for a poker game"""
    
    def __init__(self, game: PokerGame):
        self.game = game
        self.bots: dict = {}
    
    def add_bot(
        self,
        name: str,
        aggression: float = 0.5,
        looseness: float = 0.5,
        personality: str | None = None,
    ) -> Player:
        """Add an AI bot to the game. If a personality key is given, it overrides
        the explicit aggression/looseness floats."""
        if personality and personality in PERSONALITIES:
            p = PERSONALITIES[personality]
            aggression = p["aggression"]
            looseness = p["looseness"]
        player = self.game.add_player(name, is_human=False)
        bot = PokerAI(aggression=aggression, looseness=looseness, personality=personality)
        self.bots[player.id] = bot
        # Stamp the personality label on the player so the frontend can show it.
        if personality and personality in PERSONALITIES:
            player.ai_personality = personality
            player.ai_personality_label = PERSONALITIES[personality]["label"]
        return player
    
    def process_bot_turn(self) -> Optional[dict]:
        """Process the current bot's turn if it's an AI"""
        import logging
        logger = logging.getLogger(__name__)
        
        current = self.game.get_current_player()
        
        if not current:
            logger.debug("No current player")
            return None
        
        if current.is_human:
            logger.debug(f"Current player {current.name} is human")
            return None
        
        if current.id not in self.bots:
            logger.debug(f"Player {current.name} not in bots dict")
            return None
        
        if current.folded or current.is_all_in:
            logger.debug(f"Player {current.name} folded or all-in, skipping")
            # Move to next player manually
            self.game._next_player()
            return {'action': 'skip', 'player': current.name}
        
        bot = self.bots[current.id]
        decision = bot.make_decision(self.game, current)
        
        logger.info(f"Bot {current.name} decision: {decision}")
        
        # Execute the decision
        success = False
        if decision['action'] == 'fold':
            success = self.game.action_fold(current.id)
        elif decision['action'] == 'check':
            success = self.game.action_check(current.id)
        elif decision['action'] == 'call':
            success = self.game.action_call(current.id)
        elif decision['action'] == 'raise':
            success = self.game.action_raise(current.id, decision['amount'])
        elif decision['action'] == 'all-in':
            to_call = self.game.current_bet - current.bet
            all_in_amount = current.chips - to_call
            success = self.game.action_raise(current.id, all_in_amount)
        
        if success:
            logger.info(f"Bot {current.name} successfully executed {decision['action']}")
            # Store the action for frontend display
            self.game.last_ai_action = {
                'player_name': current.name,
                'action': decision['action'],
                'amount': decision.get('amount'),
                'timestamp': time.monotonic()
            }
        else:
            logger.warning(f"Bot {current.name} failed to execute {decision['action']}")
            # Try to fold as fallback
            self.game.action_fold(current.id)
        
        return decision
