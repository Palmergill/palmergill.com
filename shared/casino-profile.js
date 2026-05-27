// Shared casino profile: display name, bankroll, and per-game session stats
// persisted to localStorage so each visit feels continuous across
// /blackjack/, /craps/, and /poker/.
//
// Bankroll is shared between blackjack and craps. Poker uses server-managed
// chip stacks for multiplayer, so it reads display name and contributes to
// aggregate stats but does not draw from the shared bankroll.
//
// Usage:
//   <script src="/shared/casino-profile.js"></script>
//   const profile = window.CasinoProfile;
//   profile.getBankroll();          // -> number, defaults to 1000
//   profile.setBankroll(1450);
//   profile.getDisplayName();       // -> string, defaults to ''
//   profile.setDisplayName('Sam');
//   profile.recordSession('blackjack', { handsPlayed: 12, netProfit: 240 });
//   profile.getAggregateStats();    // -> { totalHands, netProfit, byGame }
(function () {
    if (window.CasinoProfile) return;

    const STORAGE_KEYS = {
        name: 'casino-profile-name',
        bankroll: 'casino-bankroll',
        stats: 'casino-session-stats'
    };

    const DEFAULTS = {
        bankroll: 1000,
        maxNameLength: 24
    };

    const KNOWN_GAMES = ['blackjack', 'craps', 'poker'];

    function safeRead(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function safeWrite(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // localStorage disabled / quota — silently ignore
        }
    }

    function clampBankroll(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.floor(n);
    }

    function readStats() {
        const raw = safeRead(STORAGE_KEYS.stats);
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writeStats(stats) {
        safeWrite(STORAGE_KEYS.stats, JSON.stringify(stats));
    }

    function emptyGameStats() {
        return {
            handsPlayed: 0,
            netProfit: 0,
            biggestWin: 0,
            sessionsRecorded: 0,
            lastPlayed: null
        };
    }

    const CasinoProfile = {
        getDisplayName() {
            return safeRead(STORAGE_KEYS.name) || '';
        },

        setDisplayName(name) {
            const trimmed = (typeof name === 'string' ? name : '').trim();
            const clipped = trimmed.slice(0, DEFAULTS.maxNameLength);
            safeWrite(STORAGE_KEYS.name, clipped);
            return clipped;
        },

        getBankroll() {
            const raw = safeRead(STORAGE_KEYS.bankroll);
            if (raw === null) return DEFAULTS.bankroll;
            const n = Number(raw);
            return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS.bankroll;
        },

        setBankroll(value) {
            const clamped = clampBankroll(value);
            safeWrite(STORAGE_KEYS.bankroll, String(clamped));
            return clamped;
        },

        resetBankroll() {
            return this.setBankroll(DEFAULTS.bankroll);
        },

        recordSession(game, summary = {}) {
            if (!KNOWN_GAMES.includes(game)) return;
            const stats = readStats();
            const current = stats[game] || emptyGameStats();
            const handsPlayed = Math.max(0, Math.trunc(Number(summary.handsPlayed) || 0));
            const netProfit = Number(summary.netProfit) || 0;
            const biggestWin = Math.max(0, Number(summary.biggestWin) || 0);

            current.handsPlayed += handsPlayed;
            current.netProfit += netProfit;
            if (biggestWin > current.biggestWin) current.biggestWin = biggestWin;
            current.sessionsRecorded += 1;
            current.lastPlayed = new Date().toISOString();

            stats[game] = current;
            writeStats(stats);
        },

        getGameStats(game) {
            const stats = readStats();
            return stats[game] ? { ...stats[game] } : emptyGameStats();
        },

        getAggregateStats() {
            const stats = readStats();
            const byGame = {};
            let totalHands = 0;
            let netProfit = 0;
            let biggestWin = 0;
            let biggestWinGame = null;
            KNOWN_GAMES.forEach((game) => {
                const entry = stats[game] || emptyGameStats();
                byGame[game] = { ...entry };
                totalHands += entry.handsPlayed;
                netProfit += entry.netProfit;
                if (entry.biggestWin > biggestWin) {
                    biggestWin = entry.biggestWin;
                    biggestWinGame = game;
                }
            });
            return { totalHands, netProfit, biggestWin, biggestWinGame, byGame };
        },

        resetStats() {
            writeStats({});
        },

        resetAll() {
            this.resetBankroll();
            this.resetStats();
            safeWrite(STORAGE_KEYS.name, '');
        },

        KNOWN_GAMES: KNOWN_GAMES.slice(),
        DEFAULTS: { ...DEFAULTS }
    };

    window.CasinoProfile = CasinoProfile;
})();
