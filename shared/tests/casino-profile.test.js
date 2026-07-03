// casino-profile.js is a browser IIFE (window.CasinoProfile = {...}), not a
// CommonJS module — reset the module registry and localStorage before each
// test so the closure's module-level state (listeners, statsBlocked) and
// storage don't leak between tests.
function loadFreshProfile() {
    jest.resetModules();
    window.localStorage.clear();
    delete window.CasinoProfile;
    require('../casino-profile.js');
    return window.CasinoProfile;
}

describe('CasinoProfile', () => {
    let profile;

    beforeEach(() => {
        profile = loadFreshProfile();
    });

    test('bankroll defaults to 1000 and clamps on write', () => {
        expect(profile.getBankroll()).toBe(1000);
        expect(profile.setBankroll(1450.9)).toBe(1450);
        expect(profile.getBankroll()).toBe(1450);
        expect(profile.setBankroll(-50)).toBe(0);
    });

    test('resetBankroll restores the default', () => {
        profile.setBankroll(0);
        expect(profile.resetBankroll()).toBe(1000);
        expect(profile.getBankroll()).toBe(1000);
    });

    test('display name trims and clips to max length', () => {
        expect(profile.setDisplayName('  Sam  ')).toBe('Sam');
        expect(profile.getDisplayName()).toBe('Sam');

        const long = 'x'.repeat(40);
        expect(profile.setDisplayName(long)).toBe('x'.repeat(profile.DEFAULTS.maxNameLength));
    });

    test('recordSession accumulates per-game stats', () => {
        profile.recordSession('blackjack', { handsPlayed: 3, netProfit: 120, biggestWin: 80 });
        profile.recordSession('blackjack', { handsPlayed: 2, netProfit: -40, biggestWin: 10 });

        const stats = profile.getGameStats('blackjack');
        expect(stats.handsPlayed).toBe(5);
        expect(stats.netProfit).toBe(80);
        expect(stats.biggestWin).toBe(80); // biggest across both calls, not the latest
        expect(stats.sessionsRecorded).toBe(2);
        expect(stats.lastPlayed).not.toBeNull();
    });

    test('recordSession ignores unknown game keys', () => {
        profile.recordSession('roulette', { handsPlayed: 1, netProfit: 100 });
        expect(profile.getGameStats('roulette')).toMatchObject({ handsPlayed: 0, netProfit: 0 });
    });

    test('getAggregateStats sums across games and finds the biggest win', () => {
        profile.recordSession('blackjack', { handsPlayed: 2, netProfit: 50, biggestWin: 50 });
        profile.recordSession('craps', { handsPlayed: 1, netProfit: -20, biggestWin: 0 });
        profile.recordSession('poker', { handsPlayed: 1, netProfit: 300, biggestWin: 300 });

        const agg = profile.getAggregateStats();
        expect(agg.totalHands).toBe(4);
        expect(agg.netProfit).toBe(330);
        expect(agg.biggestWin).toBe(300);
        expect(agg.biggestWinGame).toBe('poker');
        expect(agg.byGame.blackjack.handsPlayed).toBe(2);
    });

    test('resetAll clears bankroll, stats, and display name', () => {
        profile.setDisplayName('Sam');
        profile.setBankroll(5000);
        profile.recordSession('craps', { handsPlayed: 1, netProfit: 10 });

        profile.resetAll();

        expect(profile.getDisplayName()).toBe('');
        expect(profile.getBankroll()).toBe(1000);
        expect(profile.getAggregateStats().totalHands).toBe(0);
    });

    test('a corrupted stats blob is preserved for recovery and blocks further writes', () => {
        window.localStorage.setItem('casino-session-stats', '{not json');

        expect(profile.getGameStats('blackjack')).toMatchObject({ handsPlayed: 0 });
        profile.recordSession('blackjack', { handsPlayed: 1, netProfit: 10 });

        // The corrupt blob is preserved under a recovery key...
        expect(window.localStorage.getItem('casino-session-stats-corrupt')).toBe('{not json');
        // ...and no further writes happen this session, so the corrupt value
        // is never silently overwritten with a fresh (data-losing) blob.
        expect(window.localStorage.getItem('casino-session-stats')).toBe('{not json');
    });

    describe('onChange', () => {
        test('fires after bankroll, name, and session writes', () => {
            const calls = [];
            profile.onChange(() => calls.push('changed'));

            profile.setBankroll(500);
            profile.setDisplayName('Sam');
            profile.recordSession('craps', { handsPlayed: 1, netProfit: 5 });

            expect(calls.length).toBe(3);
        });

        test('returns an unsubscribe function', () => {
            const calls = [];
            const unsubscribe = profile.onChange(() => calls.push('changed'));

            profile.setBankroll(500);
            unsubscribe();
            profile.setBankroll(600);

            expect(calls.length).toBe(1);
        });

        test('one listener throwing does not stop other listeners or the write', () => {
            const calls = [];
            profile.onChange(() => { throw new Error('boom'); });
            profile.onChange(() => calls.push('second'));

            expect(() => profile.setBankroll(700)).not.toThrow();
            expect(calls).toEqual(['second']);
            expect(profile.getBankroll()).toBe(700);
        });
    });
});
