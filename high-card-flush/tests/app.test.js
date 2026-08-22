const TABLE_MARKUP = `
<div id="casino-header-mount"></div>
<main data-rules-app>
  <button id="strategyToggle" type="button" aria-pressed="false"></button>
  <strong id="statHands"></strong><strong id="statWins"></strong><strong id="statFolds"></strong><strong id="statNet"></strong>
  <span id="dealerHandLabel"></span><div id="dealerCards"></div>
  <span id="playerHandLabel"></span><div id="playerCards"></div>
  <div id="hintPanel" hidden></div><div id="statusText"></div>
  <strong id="tableAnte"></strong><strong id="tableRaise"></strong>
  <section id="wagerPanel">
    <p id="wagerHelp"></p>
    <strong id="anteAmount"></strong><strong id="flushBonusAmount"></strong><strong id="straightFlushBonusAmount"></strong>
    <button type="button" data-wager="ante" data-delta="-5"></button>
    <button type="button" data-wager="ante" data-delta="5"></button>
    <button type="button" data-wager="flushBonus" data-delta="-5"></button>
    <button type="button" data-wager="flushBonus" data-delta="5"></button>
    <button type="button" data-wager="straightFlushBonus" data-delta="-5"></button>
    <button type="button" data-wager="straightFlushBonus" data-delta="5"></button>
    <button id="dealButton" type="button">Deal</button>
  </section>
  <section id="decisionPanel" hidden>
    <p id="raiseHelp"></p>
    <button id="foldButton" type="button">Fold</button>
    <button type="button" data-raise="1">Raise 1<small></small></button>
    <button type="button" data-raise="2">Raise 2<small></small></button>
    <button type="button" data-raise="3">Raise 3<small></small></button>
  </section>
  <section id="settlementPanel" hidden>
    <h2 id="settlementTitle"></h2><p id="settlementSummary"></p><div id="settlementBreakdown"></div>
    <button id="newRoundButton" type="button">Next</button>
  </section>
  <button id="resetButton" type="button">Reset</button>
</main>
`;

function loadApp() {
    document.body.innerHTML = TABLE_MARKUP;
    localStorage.clear();
    jest.resetModules();

    const game = require('../highCardFlushGame');
    const C = game.createCard;
    const player = [
        C('5', 'hearts'), C('6', 'hearts'), C('7', 'hearts'), C('8', 'hearts'), C('9', 'hearts'),
        C('2', 'spades'), C('K', 'clubs')
    ];
    const dealer = [
        C('K', 'clubs'), C('9', 'clubs'), C('7', 'clubs'),
        C('A', 'spades'), C('2', 'spades'), C('3', 'diamonds'), C('4', 'hearts')
    ];
    const originalCreateState = game.createState;
    game.createState = (options = {}) => originalCreateState({ ...options, deck: [...player, ...dealer] });
    window.HighCardFlushGame = game;

    delete window.CasinoProfile;
    require('../../shared/casino-profile.js');
    window.pgAnalytics = { track: jest.fn() };
    jest.isolateModules(() => require('../app.js'));
    return { game, profile: window.CasinoProfile };
}

describe('High Card Flush table app', () => {
    afterEach(() => {
        window.dispatchEvent(new Event('pagehide'));
        delete window.HighCardFlushGame;
        delete window.CasinoProfile;
        delete window.pgAnalytics;
        document.body.innerHTML = '';
        jest.restoreAllMocks();
    });

    test('deals the player face up, hides the dealer, and enables only legal raises', () => {
        loadApp();

        document.getElementById('dealButton').click();

        expect(document.querySelectorAll('#playerCards .playing-card')).toHaveLength(7);
        expect(document.querySelectorAll('#playerCards .is-best-flush')).toHaveLength(5);
        expect(document.querySelectorAll('#dealerCards .playing-card--back')).toHaveLength(7);
        expect(document.querySelector('[data-raise="1"]').disabled).toBe(false);
        expect(document.querySelector('[data-raise="2"]').disabled).toBe(false);
        expect(document.querySelector('[data-raise="3"]').disabled).toBe(true);
        expect(document.getElementById('decisionPanel').hidden).toBe(false);
    });

    test('groups the dealt hand by suit with the high card first', () => {
        loadApp();

        document.getElementById('dealButton').click();

        const dealt = [...document.querySelectorAll('#playerCards .playing-card')].map((card) => card.dataset.card);
        expect(dealt).toEqual([
            '2-spades',
            '9-hearts', '8-hearts', '7-hearts', '6-hearts', '5-hearts',
            'K-clubs'
        ]);
    });

    test('shows optional strategy guidance for the current hand', () => {
        loadApp();
        document.getElementById('dealButton').click();

        document.getElementById('strategyToggle').click();

        expect(document.getElementById('strategyToggle').getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('hintPanel').hidden).toBe(false);
        expect(document.getElementById('hintPanel').textContent).toContain('Raise 2×');
    });

    test('reveals and settles the dealer while persisting bankroll before stats', () => {
        const { profile } = loadApp();
        document.getElementById('dealButton').click();

        document.querySelector('[data-raise="2"]').click();

        expect(document.querySelectorAll('#dealerCards .playing-card--back')).toHaveLength(0);
        expect(document.getElementById('settlementPanel').hidden).toBe(false);
        expect(document.getElementById('settlementTitle').textContent).toBe('Player wins');
        expect(profile.getBankroll()).toBe(1075);
        expect(profile.getGameStats('high-card-flush')).toMatchObject({ handsPlayed: 1, netProfit: 75, biggestWin: 75 });
        expect(document.getElementById('statHands').textContent).toBe('1');
        expect(document.getElementById('statNet').textContent).toBe('+$75');

        // A hidden, already-settled Raise button cannot record the hand twice.
        document.querySelector('[data-raise="1"]').click();
        expect(profile.getGameStats('high-card-flush').handsPlayed).toBe(1);

        expect(window.pgAnalytics.track).toHaveBeenCalledWith(
            'high_card_flush_round_completed',
            expect.objectContaining({ result: 'win', raise_multiplier: 2, net_profit: 75 })
        );
    });

    test('pays both optional bonuses even when the player folds', () => {
        const { profile } = loadApp();
        document.querySelector('[data-wager="flushBonus"][data-delta="5"]').click();
        document.querySelector('[data-wager="straightFlushBonus"][data-delta="5"]').click();
        document.getElementById('dealButton').click();

        document.getElementById('foldButton').click();

        expect(profile.getBankroll()).toBe(1525);
        expect(document.getElementById('settlementTitle').textContent).toBe('Hand folded');
        expect(document.getElementById('settlementSummary').textContent).toContain('Flush Bonus pays 10:1');
        expect(document.getElementById('settlementSummary').textContent).toContain('Straight Flush Bonus pays 100:1');
        // The dealer is revealed on a fold too, sorted the same way as the player's hand.
        expect(document.querySelectorAll('#dealerCards .playing-card--back')).toHaveLength(0);
        expect(document.getElementById('dealerHandLabel').textContent).toBe('3-card, K-high clubs · would have qualified');
    });

    test('keeps a dealt hand alive when the bankroll changes mid-round', () => {
        const { profile } = loadApp();
        document.getElementById('dealButton').click();
        expect(profile.getBankroll()).toBe(975);

        // A rebuy from the shared header (or another tab) lands during the decision.
        profile.setBankroll(1975);

        expect(document.body.dataset.gameStatus).toBe('decision');
        expect(document.querySelectorAll('#playerCards .playing-card')).toHaveLength(7);
        expect(document.getElementById('decisionPanel').hidden).toBe(false);

        // The round still reports only what the wagers won, not the deposit.
        document.querySelector('[data-raise="2"]').click();
        expect(document.getElementById('statNet').textContent).toBe('+$75');
        expect(profile.getGameStats('high-card-flush')).toMatchObject({ handsPlayed: 1, netProfit: 75 });
        // $1,000 start + $1,000 deposit + $75 won on the hand.
        expect(profile.getBankroll()).toBe(2075);
    });

    test('resets the shared bankroll and returns the app to betting', () => {
        const { profile } = loadApp();
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        document.getElementById('dealButton').click();
        expect(profile.getBankroll()).toBe(975);

        document.getElementById('resetButton').click();

        expect(profile.getBankroll()).toBe(1000);
        expect(document.getElementById('wagerPanel').hidden).toBe(false);
        expect(window.pgAnalytics.track).toHaveBeenCalledWith('high_card_flush_bankroll_reset');

        document.getElementById('dealButton').click();
        document.querySelector('[data-raise="2"]').click();
        expect(profile.getGameStats('high-card-flush').handsPlayed).toBe(1);
    });
});
