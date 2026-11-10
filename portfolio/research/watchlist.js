// Stock watchlist: the signed-in account's list (the tracker's Watchlist),
// or this browser's for anyone signed out; anything saved here before signing
// in moves to the account. Renders into the empty-state panel and toggles the
// header "Save" button.
(function () {
    if (window.Watchlist) return;

    const STORAGE_KEY = 'stock-watchlist';
    const MAX = 16;

    const SERVER_PATH = `${window.API_ORIGIN || ''}/api/stocks/portfolio/watchlist`;
    let server = null; // the account's list, once it has answered

    function fromServer(data) {
        server = (data.items || []).map((item) => ({
            ticker: item.ticker, name: item.name || '', price: item.price,
            changePercent: item.dayChangePct == null ? null : item.dayChangePct * 100,
            spark: item.spark || [],
        }));
        render();
        syncToggleButton();
    }
    async function call(method, path, body) {
        const response = await fetch(`${SERVER_PATH}${path}`, {
            method, credentials: 'include',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return response.ok ? response.json() : null;
    }
    async function connect() {
        if (!await window.AppSession) return;
        let data = null;
        try { data = await call('GET', ''); } catch { /* stays on this browser */ }
        if (!data) return;
        const held = new Set(data.items.map((item) => item.ticker));
        for (const entry of readLocal()) {
            if (held.has(entry.ticker)) continue;
            try { data = await call('POST', '', { ticker: entry.ticker }) || data; } catch { return; }
        }
        write([]);
        fromServer(data);
    }

    function read() {
        return server || readLocal();
    }

    function readLocal() {
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
        if (server) {
            if (idx >= 0) return; // saving again would clear its price alerts
            server.unshift({ ticker: t, name: snapshot.name || '', price: snapshot.price ?? null, changePercent: snapshot.changePercent ?? null });
            render();
            call('POST', '', { ticker: t }).then((data) => { if (data) fromServer(data); }).catch(() => {});
            return;
        }
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
        if (server) {
            render();
            call('DELETE', `/${encodeURIComponent(ticker.toUpperCase())}`).then((data) => { if (data) fromServer(data); }).catch(() => {});
            return;
        }
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
        if (!server) write(list);
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

    // A research-home tile: ticker and price, name and day change, and the
    // last month's closes when there are some. Shared with "Your holdings".
    function tile({ ticker, name, price, changePercent, spark }) {
        const btn = document.createElement('button');
        btn.className = 'trending-stock rt';
        btn.type = 'button';
        btn.dataset.ticker = ticker;
        const row = (cls, left, right, rightCls = '') => {
            const line = document.createElement('span');
            line.className = cls;
            const a = document.createElement('span');
            a.textContent = left;
            const b = document.createElement('span');
            b.textContent = right;
            if (rightCls) b.className = rightCls;
            line.append(a, b);
            return line;
        };
        const tone = changePercent == null ? '' : changePercent >= 0 ? 'is-positive' : 'is-negative';
        btn.append(
            row('rt__top', ticker, price != null ? fmtPrice(price) : ''),
            row('rt__sub', name || '', fmtChange(changePercent), tone),
        );
        const closes = (spark || []).filter((v) => Number.isFinite(v));
        if (closes.length > 1) {
            const lo = Math.min(...closes);
            const span = Math.max(...closes) - lo || 1;
            const points = closes.map((v, i) => `${((i / (closes.length - 1)) * 100).toFixed(1)},${(22 - ((v - lo) / span) * 20).toFixed(1)}`).join(' ');
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 100 24');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('class', `rt__spark ${closes[closes.length - 1] >= closes[0] ? 'is-up' : 'is-down'}`);
            const line = document.createElementNS(ns, 'polyline');
            line.setAttribute('points', points);
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.append(line);
            btn.append(svg);
        }
        return btn;
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
            const btn = tile(entry);

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
                if (server) {
                    server.splice(0).forEach((entry) => call('DELETE', `/${encodeURIComponent(entry.ticker)}`).catch(() => {}));
                }
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
        connect();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.Watchlist = {
        add, remove, isSaved, touchSnapshot, syncToggleButton, render, tile
    };
})();
