// Stock compare view: hold up to 4 tickers, fetch their summary, and render a
// side-by-side metric table. Reuses the existing /api/stocks/<ticker> endpoint.
(function () {
    if (window.StockCompare) return;

    const STORAGE_KEY = 'stock-compare-tickers';
    const MAX = 4;
    // Module-private cache of fetched ticker data. Cleared between renders so the
    // table reflects current input.
    const cache = new Map();

    function readTickers() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
        } catch (e) { return []; }
    }

    function writeTickers(list) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX))); }
        catch (e) {}
    }

    function fmtMoney(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        return '$' + Number(v).toFixed(2);
    }

    function fmtPct(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        const sign = v >= 0 ? '+' : '';
        return `${sign}${Number(v).toFixed(2)}%`;
    }

    function fmtMcap(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        const abs = Math.abs(v);
        if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
        if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
        return '$' + Math.round(v).toLocaleString();
    }

    function fmtNum(v, digits = 2) {
        if (v == null || !Number.isFinite(v)) return '—';
        return Number(v).toFixed(digits);
    }

    async function fetchTicker(ticker) {
        const t = ticker.toUpperCase();
        if (cache.has(t)) return cache.get(t);
        const base = (window.API_ORIGIN || '') + '/api/stocks';
        try {
            const res = await fetch(`${base}/${encodeURIComponent(t)}?refresh=false`, {
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const summary = data.summary || {};
            const history = data.price_history || data.priceHistory || [];
            let changePct = null;
            if (Array.isArray(history) && history.length >= 2) {
                const prices = history.map((d) => d.close ?? d.price).filter((v) => v != null);
                if (prices.length >= 2) {
                    const curr = prices[prices.length - 1];
                    const prev = prices[prices.length - 2];
                    if (prev) changePct = ((curr - prev) / prev) * 100;
                }
            }
            const row = {
                ticker: t,
                name: data.name || summary.name || t,
                price: summary.current_price ?? null,
                changePercent: changePct,
                marketCap: summary.market_cap ?? null,
                peRatio: summary.pe_ratio ?? null,
                eps: summary.eps ?? null,
                dividendYield: summary.dividend_yield ?? null
            };
            cache.set(t, row);
            return row;
        } catch (e) {
            const row = { ticker: t, error: e.message || 'fetch failed' };
            cache.set(t, row);
            return row;
        }
    }

    function renderChips() {
        const chipsEl = document.getElementById('compareChips');
        if (!chipsEl) return;
        const list = readTickers();
        const frag = document.createDocumentFragment();
        list.forEach((t) => {
            const chip = document.createElement('span');
            chip.className = 'compare-chip';
            chip.textContent = t;
            const x = document.createElement('button');
            x.type = 'button';
            x.title = `Remove ${t}`;
            x.textContent = '×';
            x.addEventListener('click', () => {
                writeTickers(list.filter((entry) => entry !== t));
                cache.delete(t);
                renderChips();
                renderTable();
            });
            chip.appendChild(x);
            frag.appendChild(chip);
        });
        chipsEl.replaceChildren(frag);
    }

    async function renderTable() {
        const tableEl = document.getElementById('compareTable');
        if (!tableEl) return;
        const list = readTickers();
        if (list.length === 0) {
            tableEl.hidden = true;
            tableEl.replaceChildren();
            return;
        }
        tableEl.hidden = false;
        tableEl.replaceChildren();
        const loading = document.createElement('div');
        loading.className = 'compare-empty';
        loading.textContent = 'Loading…';
        tableEl.appendChild(loading);

        const rows = await Promise.all(list.map(fetchTicker));

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const blank = document.createElement('th');
        blank.scope = 'col';
        blank.textContent = 'Metric';
        headRow.appendChild(blank);
        rows.forEach((row) => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = row.ticker;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const metrics = [
            ['Price', (r) => fmtMoney(r.price)],
            ['Day %', (r) => fmtPct(r.changePercent), (r) => r.changePercent],
            ['Market cap', (r) => fmtMcap(r.marketCap)],
            ['P/E ratio', (r) => fmtNum(r.peRatio)],
            ['EPS', (r) => fmtMoney(r.eps)],
            ['Dividend yield', (r) => r.dividendYield != null ? fmtPct(r.dividendYield) : '—']
        ];
        metrics.forEach(([label, format, signGetter]) => {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.scope = 'row';
            th.textContent = label;
            tr.appendChild(th);
            rows.forEach((row) => {
                const td = document.createElement('td');
                if (row.error) {
                    td.textContent = '—';
                } else {
                    td.textContent = format(row);
                    if (signGetter) {
                        const v = signGetter(row);
                        if (Number.isFinite(v)) td.classList.add(v >= 0 ? 'is-positive' : 'is-negative');
                    }
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        tableEl.replaceChildren(table);
    }

    function addTicker(input) {
        const t = (input || '').trim().toUpperCase();
        if (!/^[A-Z.\-]{1,8}$/.test(t)) return false;
        const list = readTickers();
        if (list.includes(t)) return false;
        if (list.length >= MAX) return false;
        list.push(t);
        writeTickers(list);
        renderChips();
        renderTable();
        return true;
    }

    function wire() {
        const form = document.getElementById('compareForm');
        const input = document.getElementById('compareInput');
        if (!form || !input) return;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (addTicker(input.value)) {
                input.value = '';
                input.focus();
            }
        });
        renderChips();
        renderTable();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.StockCompare = { addTicker, renderChips, renderTable };
})();
