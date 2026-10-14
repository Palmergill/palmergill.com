// Stock watchlist: persisted list of saved tickers with the last seen price.
// Renders into the empty-state panel and toggles the header "Save" button.
(function () {
    if (window.Watchlist) return;

    const STORAGE_KEY = 'stock-watchlist';
    const MAX = 16;

    function read() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }

    function write(list) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX))); }
        catch { /* quota or disabled */ }
    }

    function findIndex(list, ticker) {
        const t = (ticker || '').toUpperCase();
        return list.findIndex((entry) => entry && entry.ticker === t);
    }

    function add(ticker, snapshot = {}) {
        if (!ticker) return;
        const t = ticker.toUpperCase();
        const list = read();
        const idx = findIndex(list, t);
        const entry = {
            ticker: t,
            name: snapshot.name || (idx >= 0 ? list[idx].name : ''),
            price: snapshot.price ?? (idx >= 0 ? list[idx].price : null),
            changePercent: snapshot.changePercent ?? (idx >= 0 ? list[idx].changePercent : null),
            savedAt: Date.now()
        };
        if (idx >= 0) list.splice(idx, 1);
        list.unshift(entry);
        write(list);
        render();
    }

    function remove(ticker) {
        const list = read();
        const idx = findIndex(list, ticker);
        if (idx < 0) return;
        list.splice(idx, 1);
        write(list);
        render();
    }

    function isSaved(ticker) {
        return findIndex(read(), ticker) >= 0;
    }

    function touchSnapshot(ticker, snapshot) {
        if (!ticker) return;
        const list = read();
        const idx = findIndex(list, ticker);
        if (idx < 0) return; // only update if already in watchlist
        list[idx] = { ...list[idx], ...snapshot, ticker: ticker.toUpperCase() };
        write(list);
        render();
    }

    function currentTicker() {
        return (document.getElementById('headerStockTicker')?.textContent || '').trim().toUpperCase() || null;
    }

    function syncToggleButton() {
        const btn = document.getElementById('watchlistBtn');
        if (!btn) return;
        const t = currentTicker();
        if (!t) {
            btn.hidden = true;
            return;
        }
        btn.hidden = false;
        const saved = isSaved(t);
        const label = saved ? `Remove ${t} from watchlist` : `Save ${t} to watchlist`;
        btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
        btn.setAttribute('aria-label', label);
        btn.title = label;
    }

    function fmtPrice(p) {
        if (p == null || !Number.isFinite(p)) return '';
        return '$' + Number(p).toFixed(2);
    }

    function fmtChange(c) {
        if (c == null || !Number.isFinite(c)) return '';
        return `${c >= 0 ? '+' : '\u2212'}${Math.abs(c).toFixed(2)}%`;
    }

    function render() {
        const section = document.getElementById('watchlistSection');
        const grid = document.getElementById('watchlistGrid');
        if (!section || !grid) return;
        const list = read();
        if (list.length === 0) {
            section.hidden = true;
            grid.replaceChildren();
            return;
        }
        section.hidden = false;
        const frag = document.createDocumentFragment();
        list.forEach((entry) => {
            // Clicks are handled by app.js's delegated [data-ticker] listener.
            const row = document.createElement('button');
            row.className = 'watch-row';
            row.type = 'button';
            row.dataset.ticker = entry.ticker;

            const id = document.createElement('span');
            id.className = 'watch-row-id';
            const ticker = document.createElement('span');
            ticker.className = 'watch-row-symbol';
            ticker.textContent = entry.ticker;
            const name = document.createElement('span');
            name.className = 'watch-row-name';
            name.textContent = entry.name || 'Saved ticker';
            id.append(ticker, name);
            row.appendChild(id);

            const price = fmtPrice(entry.price);
            const delta = fmtChange(entry.changePercent);
            if (price || delta) {
                const quote = document.createElement('span');
                quote.className = 'watch-row-quote';
                if (price) quote.append(document.createTextNode(price));
                if (delta) {
                    const pill = document.createElement('span');
                    pill.className = 'change-pill ' + (entry.changePercent >= 0 ? 'positive' : 'negative');
                    pill.textContent = delta;
                    quote.appendChild(pill);
                }
                row.appendChild(quote);
            }

            frag.appendChild(row);
        });
        grid.replaceChildren(frag);
    }

    function wire() {
        const toggle = document.getElementById('watchlistBtn');
        if (toggle) {
            toggle.hidden = true; // only show once a ticker is loaded
            toggle.addEventListener('click', () => {
                const t = currentTicker();
                if (!t) return;
                if (isSaved(t)) remove(t);
                else add(t, {
                    name: document.getElementById('headerStockName')?.textContent || '',
                    price: parseFloat((document.getElementById('headerStockPrice')?.textContent || '').replace(/[^0-9.\-]/g, '')) || null,
                    changePercent: parseFloat((document.getElementById('headerStockChange')?.textContent || '').replace('\u2212', '-').replace(/[^0-9.\-]/g, '')) || null
                });
                syncToggleButton();
            });
        }
        const clear = document.getElementById('clearWatchlistBtn');
        if (clear) {
            clear.addEventListener('click', () => {
                if (!window.confirm('Clear your watchlist?')) return;
                write([]);
                render();
                syncToggleButton();
            });
        }
        render();
        syncToggleButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.Watchlist = {
        add, remove, isSaved, touchSnapshot, syncToggleButton, render
    };
})();
