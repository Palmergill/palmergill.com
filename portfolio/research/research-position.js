// A strip above a researched stock when it's one you own: your shares, what
// they're worth now and your gain, linking to the holding in the tracker.
(function () {
    const API_BASE = window.API_ORIGIN || '';
    const main = document.getElementById('main');
    const header = document.getElementById('headerStockContent');
    if (!main || !header) return;

    const strip = document.createElement('a');
    strip.className = 'rp';
    strip.id = 'researchPosition';
    strip.hidden = true;
    main.prepend(strip);

    const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
    let positions = null;

    function privacy() {
        try { return localStorage.getItem('pf.privacy') === 'true'; } catch { return false; }
    }
    function fact(label, value, cls = '') {
        return `<div><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
    }
    function signedPct(ratio) {
        const pct = ratio * 100;
        return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
    }

    function render() {
        const ticker = (document.getElementById('headerStockTicker')?.textContent || '').trim().toUpperCase();
        const held = positions && !header.classList.contains('hidden') ? positions[ticker] : null;
        // The tracker's own close when it has one, so the value matches Holdings.
        const price = held?.price ?? parseFloat((document.getElementById('headerStockPrice')?.textContent || '').replace(/[^0-9.]/g, ''));
        strip.hidden = !held || !Number.isFinite(price);
        if (strip.hidden) return;
        strip.href = `/portfolio/#holding/${encodeURIComponent(ticker)}`;
        const gainRatio = held.avgCost ? price / held.avgCost - 1 : null;
        const tone = gainRatio == null ? '' : gainRatio >= 0 ? 'is-gain' : 'is-loss';
        const hide = privacy();
        const facts = [];
        if (!hide) {
            facts.push(fact('Shares', count.format(held.shares)), fact('Value', whole.format(held.shares * price)));
        }
        if (held.avgCost) facts.push(fact('Average cost', cents.format(held.avgCost)));
        if (gainRatio != null) {
            const dollars = held.shares * (price - held.avgCost);
            facts.push(fact('Gain', hide ? signedPct(gainRatio) : `${dollars < 0 ? '−' : '+'}${whole.format(Math.abs(dollars))} (${signedPct(gainRatio)})`, tone));
        }
        strip.innerHTML = `<span class="rp__title">Your position</span>${facts.join('')}<span class="rp__go">Open holding →</span>`;
    }

    // The research home's first row: what you already own.
    function renderHoldings() {
        const home = document.getElementById('empty');
        const tickers = Object.keys(positions || {}).sort();
        document.getElementById('researchHoldings')?.remove();
        if (!home || !tickers.length) return;
        const section = document.createElement('div');
        section.className = 'trending-stocks';
        section.id = 'researchHoldings';
        const label = document.createElement('span');
        label.className = 'trending-label';
        label.textContent = 'Your holdings';
        const grid = document.createElement('div');
        grid.className = 'trending-grid';
        grid.append(...tickers.map((ticker) => {
            const p = positions[ticker];
            const button = window.Watchlist.tile({
                ticker,
                name: privacy() ? '' : `${count.format(p.shares)} shares`,
                price: p.price,
                changePercent: p.dayChangePct == null ? null : p.dayChangePct * 100,
                spark: p.spark,
            });
            button.addEventListener('click', () => window.location.assign(`?ticker=${encodeURIComponent(ticker)}`));
            return button;
        }));
        section.append(label, grid);
        home.prepend(section);
    }

    // The tracker's privacy switch, shared through this browser's storage.
    const EYE = '<svg class="pf-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg class="pf-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    const toggle = document.getElementById('privacyToggle');
    function syncToggle() {
        const hidden = privacy();
        const label = hidden ? 'Show amounts' : 'Hide amounts';
        toggle.setAttribute('aria-pressed', String(hidden));
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
        toggle.innerHTML = hidden ? EYE_OFF : EYE;
    }
    if (toggle) {
        syncToggle();
        toggle.addEventListener('click', () => {
            try { localStorage.setItem('pf.privacy', String(!privacy())); } catch { /* storage blocked */ }
            syncToggle();
            render();
            renderHoldings();
        });
    }

    new MutationObserver(render).observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    window.AppSession
        .then((username) => (username ? fetch(`${API_BASE}/api/stocks/portfolio/positions`, { credentials: 'include' }) : null))
        .then((response) => (response && response.ok ? response.json() : null))
        .then((data) => {
            positions = data ? data.positions : null;
            const actions = document.getElementById('headActions');
            if (actions && data) actions.hidden = false;
            render();
            renderHoldings();
        })
        .catch(() => {});
})();
