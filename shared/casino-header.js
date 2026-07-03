// Shared casino identity strip: lobby link, display name, bankroll (or
// server chip stack for poker), and this-session net P/L. Mounts under
// /blackjack/, /craps/, and /poker/ so switching games feels continuous.
//
// Usage:
//   <script src="/shared/casino-profile.js?v=2"></script>
//   <script src="/shared/casino-header.js?v=1"></script>
//   <div id="casino-header-mount"></div>
//   <script>
//     window.CasinoHeaderInstance = CasinoHeader.mount({
//       game: 'blackjack',      // 'blackjack' | 'craps' | 'poker'
//       label: 'Blackjack',
//       mount: '#casino-header-mount',
//       chips: false            // true for poker: caller drives the number
//                                  via instance.setChips(n) instead of the
//                                  shared bankroll
//     });
//   </script>
//
// Poker calls `instance.setChips(myPlayer.chips)` whenever its own chip
// count changes; blackjack/craps don't need to call anything, they read
// straight from CasinoProfile and re-render on CasinoProfile.onChange.
(function () {
    if (window.CasinoHeader) return;

    function resolveMount(target) {
        if (!target) return null;
        return typeof target === 'string' ? document.querySelector(target) : target;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatSigned(amount) {
        const n = Math.round(Number(amount) || 0);
        const sign = n > 0 ? '+' : n < 0 ? '−' : '';
        return `${sign}$${Math.abs(n).toLocaleString()}`;
    }

    const CasinoHeader = {
        mount(options) {
            const profile = window.CasinoProfile || null;
            const root = resolveMount(options && options.mount);
            if (!root) return { setChips() {}, destroy() {} };

            const game = options.game;
            const label = options.label || game;
            const chipsMode = Boolean(options.chips);

            root.className = 'casino-header';
            root.innerHTML = `
                <a class="casino-header__lobby" href="/casino/">
                    <span aria-hidden="true">&larr;</span> Casino
                </a>
                <span class="casino-header__game">${escapeHtml(label)}</span>
                <button type="button" class="casino-header__name" data-role="name"></button>
                <div class="casino-header__stat" data-role="pnl">
                    <span class="casino-header__stat-label">Session</span>
                    <strong data-role="pnl-value">$0</strong>
                </div>
                <div class="casino-header__stat casino-header__stat--bankroll" data-role="bankroll-wrap">
                    <span class="casino-header__stat-label" data-role="bankroll-label">${chipsMode ? 'Table chips' : 'Bankroll'}</span>
                    <strong data-role="bankroll-value">$0</strong>
                </div>
                <button type="button" class="casino-header__rebuy" data-role="rebuy" hidden>Rebuy $${profile ? profile.DEFAULTS.bankroll.toLocaleString() : '1,000'}</button>
            `;

            const nameEl = root.querySelector('[data-role="name"]');
            const pnlValueEl = root.querySelector('[data-role="pnl-value"]');
            const bankrollValueEl = root.querySelector('[data-role="bankroll-value"]');
            const rebuyBtn = root.querySelector('[data-role="rebuy"]');

            // "Session" P/L is measured from the moment this header mounted,
            // not lifetime — snapshot the lifetime net profit now and diff
            // against it on every change.
            const sessionBaseline = profile ? profile.getGameStats(game).netProfit : 0;
            let lastBankroll = profile ? profile.getBankroll() : null;
            let externalChips = null; // set via setChips() for poker

            function renderName() {
                if (!profile) {
                    nameEl.hidden = true;
                    return;
                }
                const name = profile.getDisplayName();
                nameEl.textContent = name || 'Set your name';
                nameEl.classList.toggle('casino-header__name--empty', !name);
            }

            function renderPnl() {
                if (!profile) {
                    pnlValueEl.textContent = '$0';
                    return;
                }
                const delta = profile.getGameStats(game).netProfit - sessionBaseline;
                pnlValueEl.textContent = formatSigned(delta);
                pnlValueEl.classList.toggle('casino-header__value--up', delta > 0);
                pnlValueEl.classList.toggle('casino-header__value--down', delta < 0);
            }

            function renderBankroll() {
                const value = chipsMode ? (externalChips ?? 0) : (profile ? profile.getBankroll() : 0);
                bankrollValueEl.textContent = `$${Math.round(value).toLocaleString()}`;

                if (!chipsMode && profile) {
                    if (lastBankroll !== null && value !== lastBankroll) {
                        const flashClass = value > lastBankroll ? 'casino-header__value--flash-win' : 'casino-header__value--flash-loss';
                        bankrollValueEl.classList.remove('casino-header__value--flash-win', 'casino-header__value--flash-loss');
                        // Force reflow so re-triggering the same class restarts the animation.
                        void bankrollValueEl.offsetWidth;
                        bankrollValueEl.classList.add(flashClass);
                    }
                    lastBankroll = value;
                    rebuyBtn.hidden = value > 0 || !(game === 'blackjack' || game === 'craps');
                } else {
                    rebuyBtn.hidden = true;
                }
            }

            function renderAll() {
                renderName();
                renderPnl();
                renderBankroll();
            }

            nameEl.addEventListener('click', () => {
                if (!profile) return;
                const next = window.prompt('Display name', profile.getDisplayName());
                if (next === null) return;
                profile.setDisplayName(next);
            });

            rebuyBtn.addEventListener('click', () => {
                if (!profile) return;
                profile.resetBankroll();
                profile.recordSession(game, { handsPlayed: 0, netProfit: 0 });
                window.pgAnalytics?.track?.('casino_rebuy', { game });
            });

            let unsubscribe = () => {};
            if (profile) {
                unsubscribe = profile.onChange(renderAll);
            }

            // Exposed as a CSS custom property so pages whose layout can't
            // simply flow after this element (poker's screens are
            // position:fixed panels) can reserve exactly this much space.
            // Re-measured on resize since the strip wraps to two rows on
            // narrow viewports.
            function publishHeight() {
                document.documentElement.style.setProperty('--casino-header-height', `${root.offsetHeight}px`);
            }
            window.addEventListener('resize', publishHeight);

            renderAll();
            publishHeight();

            return {
                setChips(amount) {
                    externalChips = Number(amount) || 0;
                    renderBankroll();
                },
                destroy() {
                    unsubscribe();
                    window.removeEventListener('resize', publishHeight);
                    document.documentElement.style.removeProperty('--casino-header-height');
                    root.innerHTML = '';
                }
            };
        }
    };

    window.CasinoHeader = CasinoHeader;
})();
