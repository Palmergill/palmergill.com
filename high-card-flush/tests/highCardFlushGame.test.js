const game = require('../highCardFlushGame');

const C = game.createCard;

function cards(spec) {
    return spec.map(([rank, suit]) => C(rank, suit));
}

function stateFor(player, dealer, options = {}) {
    return game.createState({
        bankroll: 1000,
        startingAnte: 25,
        deck: [...player, ...dealer],
        ...options
    });
}

const PLAYER_FOUR = cards([
    ['A', 'hearts'], ['K', 'hearts'], ['9', 'hearts'], ['6', 'hearts'],
    ['2', 'spades'], ['3', 'diamonds'], ['4', 'clubs']
]);

describe('High Card Flush deck and hand evaluation', () => {
    test('creates a unique 52-card deck and shuffles without changing its contents', () => {
        const deck = game.createDeck();
        const shuffled = game.shuffleDeck(deck, () => 0.25);

        expect(deck).toHaveLength(52);
        expect(new Set(deck.map((card) => `${card.rank}-${card.suit}`)).size).toBe(52);
        expect(shuffled).toHaveLength(52);
        expect(new Set(shuffled.map((card) => `${card.rank}-${card.suit}`)).size).toBe(52);
        expect(shuffled).not.toEqual(deck);
    });

    test('selects the higher flush when two suits have the same number of cards', () => {
        const hand = cards([
            ['A', 'hearts'], ['2', 'hearts'],
            ['K', 'spades'], ['Q', 'spades'],
            ['9', 'diamonds'], ['8', 'diamonds'],
            ['3', 'clubs']
        ]);

        expect(game.evaluateFlush(hand)).toMatchObject({
            length: 2,
            suit: 'hearts',
            rankValues: [14, 2]
        });
    });

    test('compares flush length first and then every card from high to low', () => {
        const fourLow = game.evaluateFlush(cards([
            ['6', 'clubs'], ['5', 'clubs'], ['4', 'clubs'], ['3', 'clubs']
        ]));
        const threeAces = game.evaluateFlush(cards([
            ['A', 'spades'], ['K', 'spades'], ['Q', 'spades']
        ]));
        const fourHigher = game.evaluateFlush(cards([
            ['6', 'hearts'], ['5', 'hearts'], ['4', 'hearts'], ['2', 'hearts']
        ]));

        expect(game.compareFlushes(fourLow, threeAces)).toBe(1);
        expect(game.compareFlushes(fourLow, fourHigher)).toBe(1);
        expect(game.compareFlushes(fourLow, fourLow)).toBe(0);
    });

    test('finds the longest straight flush with Ace high only', () => {
        const broadwayRun = game.evaluateStraightFlush(cards([
            ['10', 'hearts'], ['J', 'hearts'], ['Q', 'hearts'], ['K', 'hearts'], ['A', 'hearts'],
            ['3', 'clubs'], ['4', 'clubs']
        ]));
        const aceLowAttempt = game.evaluateStraightFlush(cards([
            ['A', 'spades'], ['2', 'spades'], ['3', 'spades'],
            ['7', 'clubs'], ['9', 'clubs']
        ]));

        expect(broadwayRun).toMatchObject({ length: 5, highCard: 14, suit: 'hearts' });
        expect(aceLowAttempt.length).toBe(2);
    });

    test('uses the correct dealer qualification boundary', () => {
        expect(game.dealerQualifies(cards([
            ['9', 'hearts'], ['5', 'hearts'], ['2', 'hearts']
        ]))).toBe(true);
        expect(game.dealerQualifies(cards([
            ['8', 'hearts'], ['7', 'hearts'], ['2', 'hearts']
        ]))).toBe(false);
        expect(game.dealerQualifies(cards([
            ['5', 'clubs'], ['4', 'clubs'], ['3', 'clubs'], ['2', 'clubs']
        ]))).toBe(true);
    });

    test('returns legal raise limits and the simplified T-8-6 strategy', () => {
        const five = game.evaluateFlush(cards([
            ['A', 'hearts'], ['K', 'hearts'], ['9', 'hearts'], ['4', 'hearts'], ['2', 'hearts']
        ]));
        const six = game.evaluateFlush(cards([
            ['A', 'clubs'], ['K', 'clubs'], ['Q', 'clubs'], ['J', 'clubs'], ['4', 'clubs'], ['2', 'clubs']
        ]));
        const threshold = game.evaluateFlush(cards([
            ['10', 'diamonds'], ['8', 'diamonds'], ['6', 'diamonds']
        ]));
        const below = game.evaluateFlush(cards([
            ['10', 'spades'], ['8', 'spades'], ['5', 'spades']
        ]));

        expect(game.maxRaiseMultiplier(five)).toBe(2);
        expect(game.maxRaiseMultiplier(six)).toBe(3);
        expect(game.strategyAdvice(five)).toMatchObject({ action: 'raise', multiplier: 2 });
        expect(game.strategyAdvice(threshold)).toMatchObject({ action: 'raise', multiplier: 1 });
        expect(game.strategyAdvice(below)).toMatchObject({ action: 'fold', multiplier: 0 });
    });
});

describe('High Card Flush round settlement', () => {
    test('requires enough bankroll for initial wagers and a minimum Raise', () => {
        const state = game.createState({ bankroll: 50, startingAnte: 25 });
        expect(game.validateWagers(state).valid).toBe(true);

        game.setWager(state, 'flushBonus', 5);
        expect(game.validateWagers(state)).toMatchObject({ valid: false, minimumRequired: 55 });

        game.startRound(state);
        expect(state.status).toBe('betting');
        expect(state.balance).toBe(50);
    });

    test('supports wagers and bankrolls to the nearest cent', () => {
        const state = game.createState({ bankroll: 100.5, startingAnte: 12.5 });
        game.setWager(state, 'flushBonus', 7.5);

        expect(game.validateWagers(state).valid).toBe(true);
        expect(state.wagers).toMatchObject({ ante: 12.5, flushBonus: 7.5 });
    });

    test('pays the Ante and pushes the Raise when the dealer does not qualify', () => {
        const dealer = cards([
            ['8', 'clubs'], ['7', 'clubs'],
            ['A', 'spades'], ['2', 'spades'],
            ['K', 'diamonds'], ['3', 'diamonds'],
            ['4', 'hearts']
        ]);
        const state = stateFor(PLAYER_FOUR, dealer);

        game.startRound(state);
        game.raise(state, 1);

        expect(state.settlement.base.result).toBe('dealerNotQualified');
        expect(state.balance).toBe(1025);
        expect(state.netProfit).toBe(25);
    });

    test('pays both wagers when the player beats a qualifying dealer', () => {
        const dealer = cards([
            ['K', 'clubs'], ['9', 'clubs'], ['7', 'clubs'],
            ['A', 'spades'], ['2', 'spades'], ['3', 'diamonds'], ['4', 'hearts']
        ]);
        const state = stateFor(PLAYER_FOUR, dealer);

        game.startRound(state);
        game.raise(state, 1);

        expect(state.settlement.base.result).toBe('win');
        expect(state.balance).toBe(1050);
        expect(state.netProfit).toBe(50);
    });

    test('collects both wagers when the qualifying dealer wins', () => {
        const player = cards([
            ['K', 'hearts'], ['9', 'hearts'], ['7', 'hearts'],
            ['A', 'spades'], ['2', 'spades'], ['3', 'diamonds'], ['4', 'clubs']
        ]);
        const dealer = cards([
            ['A', 'clubs'], ['9', 'clubs'], ['7', 'clubs'],
            ['K', 'spades'], ['2', 'spades'], ['3', 'diamonds'], ['4', 'hearts']
        ]);
        const state = stateFor(player, dealer);

        game.startRound(state);
        game.raise(state, 1);

        expect(state.settlement.base.result).toBe('lose');
        expect(state.balance).toBe(950);
        expect(state.netProfit).toBe(-50);
    });

    test('pushes both wagers on an exact flush tie regardless of suit', () => {
        const player = cards([
            ['A', 'hearts'], ['K', 'hearts'], ['Q', 'hearts'],
            ['2', 'spades'], ['3', 'spades'], ['4', 'diamonds'], ['5', 'clubs']
        ]);
        const dealer = cards([
            ['A', 'clubs'], ['K', 'clubs'], ['Q', 'clubs'],
            ['2', 'hearts'], ['3', 'hearts'], ['4', 'diamonds'], ['5', 'spades']
        ]);
        const state = stateFor(player, dealer);

        game.startRound(state);
        game.raise(state, 1);

        expect(state.settlement.base.result).toBe('push');
        expect(state.balance).toBe(1000);
        expect(state.netProfit).toBe(0);
    });

    test('settles both bonuses after a fold using Paytable A', () => {
        const player = cards([
            ['5', 'hearts'], ['6', 'hearts'], ['7', 'hearts'], ['8', 'hearts'], ['9', 'hearts'],
            ['2', 'spades'], ['K', 'clubs']
        ]);
        const dealer = cards([
            ['A', 'clubs'], ['K', 'clubs'], ['Q', 'clubs'],
            ['2', 'spades'], ['3', 'spades'], ['4', 'diamonds'], ['5', 'hearts']
        ]);
        const state = stateFor(player, dealer);
        game.setWager(state, 'flushBonus', 5);
        game.setWager(state, 'straightFlushBonus', 5);

        game.startRound(state);
        game.fold(state);

        expect(state.settlement.base.result).toBe('fold');
        expect(state.settlement.bonuses.flush).toMatchObject({ result: 'win', odds: 10, profit: 50 });
        expect(state.settlement.bonuses.straightFlush).toMatchObject({ result: 'win', odds: 100, profit: 500 });
        expect(state.balance).toBe(1525);
        expect(state.netProfit).toBe(525);
    });

    test('collects losing bonus wagers independently of the base result', () => {
        const dealer = cards([
            ['K', 'clubs'], ['9', 'clubs'], ['7', 'clubs'],
            ['A', 'spades'], ['2', 'spades'], ['3', 'diamonds'], ['4', 'hearts']
        ]);
        const state = stateFor(PLAYER_FOUR, dealer);
        game.setWager(state, 'straightFlushBonus', 5);

        game.startRound(state);
        game.raise(state, 1);

        expect(state.settlement.base.result).toBe('win');
        expect(state.settlement.bonuses.straightFlush.result).toBe('lose');
        expect(state.balance).toBe(1045);
        expect(state.netProfit).toBe(45);
    });

    test('rejects illegal raises and cannot settle a round twice', () => {
        const player = cards([
            ['A', 'hearts'], ['K', 'hearts'], ['Q', 'hearts'], ['J', 'hearts'], ['9', 'hearts'],
            ['2', 'spades'], ['3', 'clubs']
        ]);
        const dealer = cards([
            ['K', 'clubs'], ['9', 'clubs'], ['7', 'clubs'],
            ['A', 'spades'], ['2', 'spades'], ['3', 'diamonds'], ['4', 'hearts']
        ]);
        const state = stateFor(player, dealer);

        game.startRound(state);
        game.raise(state, 3);
        expect(state.status).toBe('decision');
        expect(state.wagers.raise).toBe(0);

        game.raise(state, 2);
        const settledBalance = state.balance;
        const settledSettlement = JSON.parse(JSON.stringify(state.settlement));
        game.raise(state, 1);
        game.fold(state);

        expect(state.status).toBe('roundOver');
        expect(state.balance).toBe(settledBalance);
        expect(state.settlement).toEqual(settledSettlement);
    });
});
