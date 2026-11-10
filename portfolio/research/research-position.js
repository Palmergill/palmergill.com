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
        const price = parseFloat((document.getElementById('headerStockPrice')?.textContent || '').replace(/[^0-9.]/g, ''));
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
        if (!home || !tickers.length) return;
        const section = document.createElement('div');
        section.className = 'trending-stocks';
        const label = document.createElement('span');
        label.className = 'trending-label';
        label.textContent = 'Your holdings';
        const grid = document.createElement('div');
        grid.className = 'trending-grid';
        grid.append(...tickers.map((ticker) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'trending-stock';
            button.addEventListener('click', () => window.location.assign(`?ticker=${encodeURIComponent(ticker)}`));
            const symbol = document.createElement('span');
            symbol.className = 'trending-ticker';
            symbol.textContent = ticker;
            button.append(symbol);
            if (!privacy()) {
                const shares = document.createElement('span');
                shares.className = 'trending-name';
                shares.textContent = `${count.format(positions[ticker].shares)} shares`;
                button.append(shares);
            }
            return button;
        }));
        section.append(label, grid);
        home.prepend(section);
    }

    new MutationObserver(render).observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    window.AppSession
        .then((username) => (username ? fetch(`${API_BASE}/api/stocks/portfolio/positions`, { credentials: 'include' }) : null))
        .then((response) => (response && response.ok ? response.json() : null))
        .then((data) => { positions = data ? data.positions : null; render(); renderHoldings(); })
        .catch(() => {});
})();
