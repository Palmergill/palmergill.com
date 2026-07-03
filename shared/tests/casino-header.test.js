function loadFresh() {
    jest.resetModules();
    window.localStorage.clear();
    delete window.CasinoProfile;
    delete window.CasinoHeader;
    require('../casino-profile.js');
    require('../casino-header.js');
    return { profile: window.CasinoProfile, CasinoHeader: window.CasinoHeader };
}

function makeMount() {
    document.body.innerHTML = '<div id="mount"></div>';
    return document.getElementById('mount');
}

describe('CasinoHeader', () => {
    let profile;
    let CasinoHeader;
    let mount;

    beforeEach(() => {
        ({ profile, CasinoHeader } = loadFresh());
        mount = makeMount();
    });

    test('renders game label, name, bankroll, and hides rebuy above zero', () => {
        profile.setDisplayName('Sam');
        profile.setBankroll(750);

        CasinoHeader.mount({ game: 'craps', label: 'Craps', mount });

        expect(mount.querySelector('.casino-header__game').textContent).toBe('Craps');
        expect(mount.querySelector('[data-role="name"]').textContent).toBe('Sam');
        expect(mount.querySelector('[data-role="bankroll-value"]').textContent).toBe('$750');
        expect(mount.querySelector('[data-role="rebuy"]').hidden).toBe(true);
    });

    test('bankroll re-renders live when CasinoProfile changes elsewhere', () => {
        CasinoHeader.mount({ game: 'blackjack', label: 'Blackjack', mount });
        profile.setBankroll(42);

        expect(mount.querySelector('[data-role="bankroll-value"]').textContent).toBe('$42');
    });

    test('rebuy button appears at zero bankroll for blackjack/craps and resets on click', () => {
        profile.setBankroll(0);
        CasinoHeader.mount({ game: 'blackjack', label: 'Blackjack', mount });

        const rebuyBtn = mount.querySelector('[data-role="rebuy"]');
        expect(rebuyBtn.hidden).toBe(false);

        rebuyBtn.click();

        expect(profile.getBankroll()).toBe(profile.DEFAULTS.bankroll);
        expect(rebuyBtn.hidden).toBe(true);
    });

    test('rebuy never appears in chips mode (poker)', () => {
        profile.setBankroll(0);
        CasinoHeader.mount({ game: 'poker', label: 'Poker', mount, chips: true });

        expect(mount.querySelector('[data-role="rebuy"]').hidden).toBe(true);
    });

    test('chips mode is driven by setChips(), not the shared bankroll', () => {
        profile.setBankroll(1000);
        const instance = CasinoHeader.mount({ game: 'poker', label: 'Poker', mount, chips: true });

        expect(mount.querySelector('[data-role="bankroll-value"]').textContent).toBe('$0');

        instance.setChips(2450);
        expect(mount.querySelector('[data-role="bankroll-value"]').textContent).toBe('$2,450');

        // Shared bankroll changes must not leak into the chips display.
        profile.setBankroll(9999);
        expect(mount.querySelector('[data-role="bankroll-value"]').textContent).toBe('$2,450');
    });

    test('session P/L is measured from mount time, not lifetime net profit', () => {
        profile.recordSession('craps', { handsPlayed: 5, netProfit: 200 });

        CasinoHeader.mount({ game: 'craps', label: 'Craps', mount });
        expect(mount.querySelector('[data-role="pnl-value"]').textContent).toBe('$0');

        profile.recordSession('craps', { handsPlayed: 1, netProfit: -30 });
        expect(mount.querySelector('[data-role="pnl-value"]').textContent).toBe('−$30');
    });

    test('destroy unsubscribes from CasinoProfile changes', () => {
        const instance = CasinoHeader.mount({ game: 'craps', label: 'Craps', mount });
        instance.destroy();

        expect(() => profile.setBankroll(123)).not.toThrow();
        expect(mount.innerHTML).toBe('');
    });

    test('clicking the name badge opens a prompt and saves the result', () => {
        const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('Alex');
        CasinoHeader.mount({ game: 'craps', label: 'Craps', mount });

        mount.querySelector('[data-role="name"]').click();

        expect(promptSpy).toHaveBeenCalled();
        expect(profile.getDisplayName()).toBe('Alex');
        expect(mount.querySelector('[data-role="name"]').textContent).toBe('Alex');

        promptSpy.mockRestore();
    });

    test('mounting with no CasinoProfile on the page still renders without throwing', () => {
        delete window.CasinoProfile;
        expect(() => CasinoHeader.mount({ game: 'craps', label: 'Craps', mount })).not.toThrow();
        expect(mount.querySelector('[data-role="name"]').hidden).toBe(true);
    });
});
