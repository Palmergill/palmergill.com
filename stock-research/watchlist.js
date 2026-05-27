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
        } catch (e) { return []; }
    }

    function write(list) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX))); }
        catch (e) { /* quota or disabled */ }
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
        btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
        btn.textContent = saved ? '★ Saved' : '★ Save';
    }

    function fmtPrice(p) {
        if (p == null || !Number.isFinite(p)) return '';
        return '$' + Number(p).toFixed(2);
    }

    function fmtChange(c) {
        if (c == null || !Number.isFinite(c)) return '';
        const sign = c >= 0 ? '+' : '';
        return `${sign}${c.toFixed(2)}%`;
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
            const btn = document.createElement('button');
            btn.className = 'trending-stock';
            btn.type = 'button';
            btn.dataset.ticker = entry.ticker;

            const ticker = document.createElement('span');
            ticker.className = 'trending-ticker';
            ticker.textContent = entry.ticker;

            const name = document.createElement('span');
            name.className = 'trending-name';
            name.textContent = entry.name || (entry.price != null ? fmtPrice(entry.price) : 'Saved ticker');

            btn.appendChild(ticker);
            btn.appendChild(name);

            const delta = fmtChange(entry.changePercent);
            if (delta) {
                const d = document.createElement('span');
                d.className = 'watchlist-item-delta ' + (entry.changePercent >= 0 ? 'is-positive' : 'is-negative');
                d.textContent = (entry.price != null ? fmtPrice(entry.price) + ' · ' : '') + delta;
                btn.appendChild(d);
            }

            btn.addEventListener('click', () => {
                const ti = document.getElementById('tickerInput');
                if (ti) ti.value = entry.ticker;
                if (typeof window.loadStock === 'function') {
                    window.loadStock(entry.ticker);
                } else {
                    // app.js exposes loadStock inside an IIFE; fall back to dispatching a synthetic
                    // search form submit so the existing handler picks it up.
                    if (ti) {
                        ti.value = entry.ticker;
                        document.getElementById('searchForm')?.requestSubmit();
                    }
                }
            });

            frag.appendChild(btn);
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
                    changePercent: parseFloat((document.getElementById('headerStockChange')?.textContent || '').replace(/[^0-9.\-]/g, '')) || null
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
        // Watchlist tiles use the same `.trending-stock[data-ticker]` shape as the
        // existing Trending grid, so the main app's delegated click handler
        // already routes them through `loadStock`.
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
