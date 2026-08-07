(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.HighCardFlushGame = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const SUITS = ["spades", "hearts", "diamonds", "clubs"];
    const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
    const RANK_VALUES = Object.freeze({
        "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
        "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14
    });
    const FLUSH_BONUS_PAYTABLE = Object.freeze({ 4: 1, 5: 10, 6: 100, 7: 300 });
    const STRAIGHT_FLUSH_PAYTABLE = Object.freeze({ 3: 7, 4: 60, 5: 100, 6: 1000, 7: 8000 });
    const DEFAULTS = Object.freeze({
        minBet: 5,
        maxBet: 500,
        bankroll: 1000,
        startingAnte: 25
    });

    function roundMoney(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return Math.round(number * 100) / 100;
    }

    function money(value) {
        return Math.max(0, roundMoney(value));
    }

    function formatMoney(value) {
        const rounded = roundMoney(Math.abs(Number(value) || 0));
        const sign = Number(value) < 0 ? "-" : "";
        return `${sign}$${rounded.toLocaleString(undefined, {
            minimumFractionDigits: rounded % 1 === 0 ? 0 : 2,
            maximumFractionDigits: 2
        })}`;
    }

    function createCard(rank, suit) {
        if (!(rank in RANK_VALUES) || !SUITS.includes(suit)) {
            throw new Error("Invalid card");
        }
        return { rank, suit };
    }

    function createDeck() {
        const deck = [];
        SUITS.forEach((suit) => {
            RANKS.forEach((rank) => deck.push(createCard(rank, suit)));
        });
        return deck;
    }

    function shuffleDeck(deck = createDeck(), rng = Math.random) {
        const shuffled = [...deck];
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
            const j = Math.floor(rng() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    function cardValue(card) {
        return card ? RANK_VALUES[card.rank] || 0 : 0;
    }

    function compareRankValues(left = [], right = []) {
        const length = Math.max(left.length, right.length);
        for (let i = 0; i < length; i += 1) {
            const difference = (left[i] || 0) - (right[i] || 0);
            if (difference !== 0) return difference > 0 ? 1 : -1;
        }
        return 0;
    }

    function sortedCards(cards) {
        return [...cards].sort((a, b) => cardValue(b) - cardValue(a));
    }

    function emptyEvaluation() {
        return { length: 0, suit: null, cards: [], rankValues: [], highCard: 0 };
    }

    function evaluateFlush(cards = []) {
        if (!Array.isArray(cards) || cards.length === 0) return emptyEvaluation();

        const groups = new Map(SUITS.map((suit) => [suit, []]));
        cards.forEach((card) => {
            if (card && groups.has(card.suit) && card.rank in RANK_VALUES) {
                groups.get(card.suit).push(card);
            }
        });

        let best = emptyEvaluation();
        SUITS.forEach((suit) => {
            const suited = sortedCards(groups.get(suit));
            const rankValues = suited.map(cardValue);
            if (
                suited.length > best.length ||
                (suited.length === best.length && compareRankValues(rankValues, best.rankValues) > 0)
            ) {
                best = {
                    length: suited.length,
                    suit,
                    cards: suited,
                    rankValues,
                    highCard: rankValues[0] || 0
                };
            }
        });
        return best;
    }

    function asEvaluation(value) {
        return Array.isArray(value) ? evaluateFlush(value) : (value || emptyEvaluation());
    }

    function compareFlushes(left, right) {
        const a = asEvaluation(left);
        const b = asEvaluation(right);
        if (a.length !== b.length) return a.length > b.length ? 1 : -1;
        return compareRankValues(a.rankValues, b.rankValues);
    }

    function straightCandidate(cards, suit) {
        const byValue = new Map();
        cards.forEach((card) => {
            if (card && card.suit === suit && card.rank in RANK_VALUES) {
                byValue.set(cardValue(card), card);
            }
        });
        const values = [...byValue.keys()].sort((a, b) => a - b);
        let current = [];
        let best = [];
        values.forEach((value) => {
            if (!current.length || value === current[current.length - 1] + 1) {
                current.push(value);
            } else {
                current = [value];
            }
            if (
                current.length > best.length ||
                (current.length === best.length && (current[current.length - 1] || 0) > (best[best.length - 1] || 0))
            ) {
                best = [...current];
            }
        });
        const descending = [...best].sort((a, b) => b - a);
        return {
            length: descending.length,
            suit,
            cards: descending.map((value) => byValue.get(value)),
            rankValues: descending,
            highCard: descending[0] || 0
        };
    }

    function evaluateStraightFlush(cards = []) {
        if (!Array.isArray(cards) || cards.length === 0) return emptyEvaluation();
        let best = emptyEvaluation();
        SUITS.forEach((suit) => {
            const candidate = straightCandidate(cards, suit);
            if (
                candidate.length > best.length ||
                (candidate.length === best.length && candidate.highCard > best.highCard)
            ) {
                best = candidate;
            }
        });
        return best;
    }

    function dealerQualifies(value) {
        const evaluation = asEvaluation(value);
        return evaluation.length > 3 || (evaluation.length === 3 && evaluation.highCard >= 9);
    }

    function maxRaiseMultiplier(value) {
        const length = asEvaluation(value).length;
        if (length >= 6) return 3;
        if (length === 5) return 2;
        return 1;
    }

    function strategyAdvice(value) {
        const evaluation = asEvaluation(value);
        const multiplier = maxRaiseMultiplier(evaluation);
        if (evaluation.length >= 4) {
            return { action: "raise", multiplier, reason: `${evaluation.length}-card flush: raise the maximum.` };
        }
        if (evaluation.length === 3 && compareRankValues(evaluation.rankValues, [10, 8, 6]) >= 0) {
            return { action: "raise", multiplier: 1, reason: "Three-card flush is T-8-6 or better." };
        }
        return { action: "fold", multiplier: 0, reason: "Below the simplified T-8-6 raising threshold." };
    }

    function normalizeRules(options = {}) {
        return {
            minBet: money(options.minBet ?? DEFAULTS.minBet),
            maxBet: money(options.maxBet ?? DEFAULTS.maxBet),
            bankroll: money(options.bankroll ?? DEFAULTS.bankroll),
            startingAnte: money(options.startingAnte ?? DEFAULTS.startingAnte)
        };
    }

    function createState(options = {}) {
        const rules = normalizeRules(options.rules || {
            minBet: options.minBet,
            maxBet: options.maxBet,
            startingAnte: options.startingAnte
        });
        const startingAnte = Math.min(rules.maxBet, Math.max(rules.minBet, money(options.startingAnte ?? rules.startingAnte)));
        return {
            rules,
            balance: money(options.bankroll ?? rules.bankroll),
            wagers: {
                ante: startingAnte,
                flushBonus: 0,
                straightFlushBonus: 0,
                raise: 0
            },
            status: "betting",
            message: "Set your wagers and deal.",
            playerCards: [],
            dealerCards: [],
            playerFlush: null,
            dealerFlush: null,
            playerStraightFlush: null,
            dealerQualified: null,
            decision: null,
            settlement: null,
            netProfit: 0,
            roundStartBalance: null,
            round: 0,
            rng: typeof options.rng === "function" ? options.rng : Math.random,
            nextDeck: Array.isArray(options.deck) ? [...options.deck] : null
        };
    }

    function normalizeWager(state, type, amount) {
        const value = money(amount);
        if (type === "ante") {
            return value >= state.rules.minBet && value <= state.rules.maxBet ? value : null;
        }
        if (type === "flushBonus" || type === "straightFlushBonus") {
            return value === 0 || (value >= state.rules.minBet && value <= state.rules.maxBet) ? value : null;
        }
        return null;
    }

    function setWager(state, type, amount) {
        if (state.status !== "betting" || !(type in state.wagers) || type === "raise") return state;
        const normalized = normalizeWager(state, type, amount);
        if (normalized === null) {
            state.message = type === "ante"
                ? `Ante must be ${formatMoney(state.rules.minBet)} to ${formatMoney(state.rules.maxBet)}.`
                : `Bonus must be zero or ${formatMoney(state.rules.minBet)} to ${formatMoney(state.rules.maxBet)}.`;
            return state;
        }
        state.wagers[type] = normalized;
        state.message = validateWagers(state).message;
        return state;
    }

    function initialStake(state) {
        return money(state.wagers.ante + state.wagers.flushBonus + state.wagers.straightFlushBonus);
    }

    function validateWagers(state) {
        const stake = initialStake(state);
        const required = money(stake + state.wagers.ante);
        if (state.wagers.ante < state.rules.minBet || state.wagers.ante > state.rules.maxBet) {
            return { valid: false, initialStake: stake, minimumRequired: required, message: "Choose a valid Ante." };
        }
        if (state.balance < required) {
            return {
                valid: false,
                initialStake: stake,
                minimumRequired: required,
                message: `Keep ${formatMoney(state.wagers.ante)} available for the minimum Raise.`
            };
        }
        return { valid: true, initialStake: stake, minimumRequired: required, message: "Ready to deal." };
    }

    function drawHands(state) {
        const source = state.nextDeck && state.nextDeck.length >= 14
            ? [...state.nextDeck]
            : shuffleDeck(createDeck(), state.rng);
        state.nextDeck = null;
        return { player: source.slice(0, 7), dealer: source.slice(7, 14) };
    }

    function describeFlush(evaluation) {
        if (!evaluation || !evaluation.length) return "No flush";
        const rankNames = Object.fromEntries(Object.entries(RANK_VALUES).map(([rank, value]) => [value, rank]));
        return `${evaluation.length}-card, ${rankNames[evaluation.highCard]}-high`;
    }

    function startRound(state) {
        if (state.status !== "betting") return state;
        const validation = validateWagers(state);
        if (!validation.valid) {
            state.message = validation.message;
            return state;
        }

        const hands = drawHands(state);
        state.roundStartBalance = state.balance;
        state.balance = money(state.balance - validation.initialStake);
        state.wagers.raise = 0;
        state.playerCards = hands.player;
        state.dealerCards = hands.dealer;
        state.playerFlush = evaluateFlush(hands.player);
        state.dealerFlush = evaluateFlush(hands.dealer);
        state.playerStraightFlush = evaluateStraightFlush(hands.player);
        state.dealerQualified = dealerQualifies(state.dealerFlush);
        state.decision = null;
        state.settlement = null;
        state.netProfit = 0;
        state.round += 1;
        state.status = "decision";
        state.message = `Your best hand is ${describeFlush(state.playerFlush)}. Raise or fold.`;
        return state;
    }

    function settleBonus(wager, evaluation, paytable) {
        if (!wager) return { result: "notBet", wager: 0, odds: 0, returned: 0, profit: 0 };
        const odds = paytable[evaluation.length] || 0;
        if (!odds) return { result: "lose", wager, odds: 0, returned: 0, profit: roundMoney(-wager) };
        const returned = money(wager * (odds + 1));
        return { result: "win", wager, odds, returned, profit: money(wager * odds) };
    }

    function settleBonuses(state) {
        return {
            flush: settleBonus(state.wagers.flushBonus, state.playerFlush, FLUSH_BONUS_PAYTABLE),
            straightFlush: settleBonus(
                state.wagers.straightFlushBonus,
                state.playerStraightFlush,
                STRAIGHT_FLUSH_PAYTABLE
            )
        };
    }

    function bonusMessage(bonuses) {
        const messages = [];
        if (bonuses.flush.result === "win") messages.push(`Flush Bonus pays ${bonuses.flush.odds}:1.`);
        if (bonuses.straightFlush.result === "win") {
            messages.push(`Straight Flush Bonus pays ${bonuses.straightFlush.odds}:1.`);
        }
        return messages.join(" ");
    }

    function finishRound(state, base, bonuses) {
        const totalReturn = money(base.anteReturn + base.raiseReturn + bonuses.flush.returned + bonuses.straightFlush.returned);
        state.balance = money(state.balance + totalReturn);
        state.netProfit = roundMoney(state.balance - state.roundStartBalance);
        state.settlement = { base, bonuses, totalReturn, netProfit: state.netProfit };
        state.status = "roundOver";
        const extra = bonusMessage(bonuses);
        if (extra) state.message = `${state.message} ${extra}`;
        return state;
    }

    function fold(state) {
        if (state.status !== "decision") return state;
        state.decision = "fold";
        state.message = "Hand folded. Ante forfeited.";
        return finishRound(state, {
            result: "fold",
            anteReturn: 0,
            raiseReturn: 0,
            comparison: null
        }, settleBonuses(state));
    }

    function raise(state, multiplier = 1) {
        if (state.status !== "decision") return state;
        const cleanMultiplier = Math.trunc(Number(multiplier));
        const maximum = maxRaiseMultiplier(state.playerFlush);
        if (cleanMultiplier < 1 || cleanMultiplier > maximum) {
            state.message = `This hand allows a Raise up to ${maximum}×.`;
            return state;
        }
        const raiseWager = money(state.wagers.ante * cleanMultiplier);
        if (state.balance < raiseWager) {
            state.message = "Not enough bankroll for that Raise.";
            return state;
        }

        state.balance = money(state.balance - raiseWager);
        state.wagers.raise = raiseWager;
        state.decision = "raise";
        const comparison = compareFlushes(state.playerFlush, state.dealerFlush);
        let result;
        let anteReturn = 0;
        let raiseReturn = 0;

        if (!state.dealerQualified) {
            result = "dealerNotQualified";
            anteReturn = money(state.wagers.ante * 2);
            raiseReturn = raiseWager;
            state.message = "Dealer does not qualify. Ante wins; Raise pushes.";
        } else if (comparison > 0) {
            result = "win";
            anteReturn = money(state.wagers.ante * 2);
            raiseReturn = money(raiseWager * 2);
            state.message = "Your flush beats the dealer. Ante and Raise win.";
        } else if (comparison === 0) {
            result = "push";
            anteReturn = state.wagers.ante;
            raiseReturn = raiseWager;
            state.message = "Exact tie. Ante and Raise push.";
        } else {
            result = "lose";
            state.message = "Dealer has the stronger flush.";
        }

        return finishRound(state, { result, anteReturn, raiseReturn, comparison }, settleBonuses(state));
    }

    function clearRound(state, message) {
        state.status = "betting";
        state.message = message;
        state.wagers.raise = 0;
        state.playerCards = [];
        state.dealerCards = [];
        state.playerFlush = null;
        state.dealerFlush = null;
        state.playerStraightFlush = null;
        state.dealerQualified = null;
        state.decision = null;
        state.settlement = null;
        state.netProfit = 0;
        state.roundStartBalance = null;
        return state;
    }

    function newRound(state) {
        if (state.status !== "roundOver") return state;
        return clearRound(state, "Wagers kept. Deal when ready.");
    }

    function resetBankroll(state) {
        state.balance = money(state.rules.bankroll);
        return clearRound(state, "Bankroll reset. Set your wagers and deal.");
    }

    return {
        DEFAULTS,
        FLUSH_BONUS_PAYTABLE,
        RANKS,
        RANK_VALUES,
        STRAIGHT_FLUSH_PAYTABLE,
        SUITS,
        cardValue,
        compareFlushes,
        compareRankValues,
        createCard,
        createDeck,
        createState,
        dealerQualifies,
        describeFlush,
        evaluateFlush,
        evaluateStraightFlush,
        fold,
        formatMoney,
        initialStake,
        maxRaiseMultiplier,
        newRound,
        raise,
        resetBankroll,
        setWager,
        shuffleDeck,
        startRound,
        strategyAdvice,
        validateWagers
    };
});
