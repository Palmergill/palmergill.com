// My Portfolio: a member's own holdings and trades, broken down.
// Every byte comes from /api/stocks/portfolio, which answers anonymous
// callers with a JSON 403; the page turns that into its sign-in panel.
(function () {
    const API_BASE = window.API_ORIGIN || '';
    const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
    const OTHER = 'var(--series-other)';
    // Prices still loading on the server: it fetches a few per request, and
    // pauses when the provider's per-minute allowance runs out. Its
    // `retryAfter` says when to ask again.
    const MAX_PENDING_RETRIES = 30;

    // A year of trades, dated relative to today, so the sample has a value
    // line that starts small and builds up rather than one flat snapshot.
    // [days ago, action, ticker, shares, price]
    const SAMPLE_TRADES = [
        [360, 'Buy', 'AAPL', 20, 228],
        [352, 'Buy', 'MSFT', 8, 415],
        [330, 'Buy', 'NVDA', 40, 135],
        [300, 'Buy', 'JPM', 15, 240],
        [270, 'Buy', 'AAPL', 15, 240],
        [240, 'Buy', 'GOOGL', 25, 170],
        [205, 'Sell', 'NVDA', 15, 120],
        [180, 'Buy', 'AMZN', 20, 195],
        [150, 'Buy', 'XOM', 30, 108],
        [120, 'Buy', 'MSFT', 6, 455],
        [90, 'Sell', 'JPM', 5, 265],
        [60, 'Buy', 'NVDA', 20, 170],
        [30, 'Buy', 'GOOGL', 10, 245],
    ];

    function sampleCsv() {
        const rows = SAMPLE_TRADES.map(([daysAgo, action, ticker, shares, price]) => {
            const day = new Date();
            day.setDate(day.getDate() - daysAgo);
            // Markets are shut at weekends; move back to the Friday.
            while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1);
            const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
            return `${date},${action},${ticker},${shares},${price}`;
        });
        return ['Date,Action,Symbol,Quantity,Price', ...rows].join('\n');
    }

    const $ = (id) => document.getElementById(id);
    const els = {
        headActions: $('headActions'),
        refreshButton: $('refreshButton'),
        uploadToggle: $('uploadToggle'),
        errorBanner: $('errorBanner'),
        noticeBanner: $('noticeBanner'),
        loadingView: $('loadingView'),
        signedOutView: $('signedOutView'),
        uploadPanel: $('uploadPanel'),
        uploadTitle: $('uploadTitle'),
        uploadForm: $('uploadForm'),
        uploadButton: $('uploadButton'),
        sampleButton: $('sampleButton'),
        dropZone: $('dropZone'),
        fileInput: $('fileInput'),
        fileName: $('fileName'),
        pasteInput: $('pasteInput'),
        asOfField: $('asOfField'),
        asOfInput: $('asOfInput'),
        replaceField: $('replaceField'),
        replaceInput: $('replaceInput'),
        dashboard: $('dashboard'),
        heroValue: $('heroValue'),
        heroStats: $('heroStats'),
        insightGrid: $('insightGrid'),
        sectorCard: $('sectorCard'),
        allocationBar: $('allocationBar'),
        sectorBars: $('sectorBars'),
        insights: $('insights'),
        holdingsSub: $('holdingsSub'),
        holdingsBody: document.querySelector('#holdingsTable tbody'),
        transactionsSub: $('transactionsSub'),
        transactionsBody: document.querySelector('#transactionsTable tbody'),
        addToggle: $('addToggle'),
        addForm: $('addForm'),
        clearHoldingsButton: $('clearHoldingsButton'),
        clearAllButton: $('clearAllButton'),
    };

    let fileText = null;
    let pendingRetries = 0;
    let pendingTimer = null;

    class ForbiddenError extends Error {}

    // ── formatting ─────────────────────────────────────────────────────────

    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const moneyWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const shareFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

    function fmtMoney(value, whole = false) {
        if (value == null) return '—';
        return (whole ? moneyWhole : money).format(value);
    }
    function fmtSigned(value, whole = false) {
        if (value == null) return '—';
        const text = fmtMoney(Math.abs(value), whole);
        return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
    }
    function fmtPct(value, signed = false) {
        if (value == null) return '—';
        const pct = value * 100;
        const digits = Math.abs(pct) < 1 ? 2 : Math.abs(pct) < 10 ? 1 : 0;
        const text = `${Math.abs(pct).toFixed(digits)}%`;
        if (!signed) return text;
        return pct > 0 ? `+${text}` : pct < 0 ? `−${text}` : text;
    }
    function tone(value) {
        if (value == null || Math.abs(value) < 0.005) return '';
        return value > 0 ? 'is-gain' : 'is-loss';
    }
    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ── API ────────────────────────────────────────────────────────────────

    async function api(path = '', options = {}) {
        const response = await fetch(`${API_BASE}/api/stocks/portfolio${path}`, {
            credentials: 'same-origin',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        let data = null;
        try { data = await response.json(); } catch { /* empty body */ }
        if (response.status === 403) throw new ForbiddenError(data?.detail || 'Sign in to see your portfolio.');
        if (!response.ok) {
            const detail = Array.isArray(data?.detail)
                ? data.detail.map((d) => d.msg).join('; ')
                : data?.detail;
            throw new Error(detail || `Request failed (${response.status}).`);
        }
        return data;
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = !message;
    }
    function showNotice(message) {
        els.noticeBanner.textContent = message;
        els.noticeBanner.hidden = !message;
    }

    async function run(work) {
        showError('');
        try {
            return await work();
        } catch (error) {
            if (error instanceof ForbiddenError) {
                showSignedOut();
                return null;
            }
            showError(error.message);
            return null;
        }
    }

    // ── views ──────────────────────────────────────────────────────────────

    function showSignedOut() {
        els.loadingView.hidden = true;
        els.dashboard.hidden = true;
        els.uploadPanel.hidden = true;
        els.headActions.hidden = true;
        els.signedOutView.hidden = false;
    }

    function setUploadOpen(open) {
        els.uploadPanel.hidden = !open;
        els.uploadToggle.setAttribute('aria-expanded', String(open));
    }

    let lastData = null;

    function render(data) {
        lastData = data;
        els.loadingView.hidden = true;
        els.signedOutView.hidden = true;
        const empty = data.positions.length === 0 && data.transactions.length === 0;
        els.dashboard.hidden = empty;
        els.headActions.hidden = empty;
        els.uploadTitle.textContent = empty ? 'Add your portfolio' : 'Upload more';
        // The sample adds trades to whatever is there, so offer it only to an empty portfolio.
        els.sampleButton.hidden = !empty;
        if (empty) setUploadOpen(true);
        if (empty) return;

        renderHero(data);
        renderAllocation(data);
        renderSectors(data);
        renderInsights(data);
        renderHoldings(data);
        renderTransactions(data);
        maybeLoadHistory(data);
        els.clearHoldingsButton.hidden = !data.holdings.count;
        schedulePendingRetry(data);
    }

    function renderHero(data) {
        const t = data.totals;
        els.heroValue.textContent = fmtMoney(t.marketValue, true);
        const stats = [];
        if (t.gain != null) {
            stats.push(`<span class="${tone(t.gain)}">${fmtSigned(t.gain, true)} (${fmtPct(t.gainPct, true)})</span> unrealized`);
        }
        if (t.realizedGain != null) {
            stats.push(`<span class="${tone(t.realizedGain)}">${fmtSigned(t.realizedGain, true)}</span> realized`);
        }
        stats.push(t.pricedPositions < t.positions
            ? `${t.pricedPositions} of ${t.positions} positions priced`
            : `${t.positions} position${t.positions === 1 ? '' : 's'}`);
        // Each stat stays on one line; the row wraps between them.
        els.heroStats.innerHTML = stats.map((text) => `<span class="pf-stat">${text}</span>`).join(' <span class="pf-dot" aria-hidden="true">·</span> ');
    }

    function allocationSlices(positions) {
        const priced = positions.filter((p) => p.marketValue != null && p.marketValue > 0);
        const slices = priced.slice(0, SERIES.length).map((p, i) => ({
            label: p.ticker, value: p.marketValue, weight: p.weight, color: SERIES[i],
        }));
        const rest = priced.slice(SERIES.length);
        if (rest.length) {
            slices.push({
                label: `Other (${rest.length})`,
                value: rest.reduce((sum, p) => sum + p.marketValue, 0),
                weight: rest.reduce((sum, p) => sum + (p.weight || 0), 0),
                color: OTHER,
            });
        }
        return slices;
    }

    let tip = null;
    function showTip(event, text) {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'pf-tip';
            document.body.appendChild(tip);
        }
        tip.textContent = text;
        tip.hidden = false;
        const x = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
        tip.style.left = `${x}px`;
        tip.style.top = `${event.clientY - 36}px`;
    }
    function hideTip() { if (tip) tip.hidden = true; }

    function renderAllocation(data) {
        const slices = allocationSlices(data.positions);
        els.allocationBar.hidden = !slices.length;
        els.allocationBar.setAttribute('aria-label', slices.map((s) => `${s.label} ${fmtPct(s.weight)}`).join(', '));
        els.allocationBar.innerHTML = slices.map((s, i) => (
            `<div class="pf-stack__seg" data-i="${i}" style="flex:${s.weight} 1 0; background:${s.color}"></div>`
        )).join('');
        els.allocationBar.querySelectorAll('.pf-stack__seg').forEach((seg) => {
            const s = slices[Number(seg.dataset.i)];
            const text = `${s.label} · ${fmtMoney(s.value, true)} · ${fmtPct(s.weight)}`;
            seg.addEventListener('mousemove', (event) => showTip(event, text));
            seg.addEventListener('mouseleave', hideTip);
        });
    }

    function knownSectors(data) {
        return data.sectors.filter((s) => s.sector !== 'Other');
    }

    function renderSectors(data) {
        const known = knownSectors(data).length > 0;
        els.sectorCard.hidden = !known;
        els.insightGrid.classList.toggle('pf-grid--single', !known);
        if (!known) return;
        const max = Math.max(...data.sectors.map((s) => s.weight || 0)) || 1;
        els.sectorBars.innerHTML = data.sectors.map((s) => `
            <li>
                <div class="pf-bars__label"><span>${escapeHtml(s.sector)}</span><span>${fmtPct(s.weight)} · ${fmtMoney(s.marketValue, true)}</span></div>
                <div class="pf-bars__track"><div class="pf-bars__fill" style="width:${((s.weight || 0) / max) * 100}%"></div></div>
            </li>`).join('');
    }

    function renderInsights(data) {
        const items = [];
        const priced = data.positions.filter((p) => p.weight != null);
        if (priced.length) {
            const top = priced[0];
            const topFive = priced.slice(0, 5).reduce((sum, p) => sum + p.weight, 0);
            items.push(`<strong>${escapeHtml(top.ticker)}</strong> is your largest position at <strong>${fmtPct(top.weight)}</strong> of the portfolio.`);
            if (priced.length > 5) items.push(`Your top five holdings make up <strong>${fmtPct(topFive)}</strong>.`);
        }
        const sectors = knownSectors(data);
        if (sectors.length > 1) {
            items.push(`<strong>${escapeHtml(sectors[0].sector)}</strong> is your heaviest sector, <strong>${fmtPct(sectors[0].weight)}</strong> of the total.`);
        } else if (sectors.length === 1 && sectors[0].weight > 0.99) {
            items.push(`Everything priced is in one sector: <strong>${escapeHtml(sectors[0].sector)}</strong>.`);
        }
        const withGain = data.positions.filter((p) => p.gainPct != null);
        if (withGain.length > 1) {
            const best = withGain.reduce((a, b) => (b.gainPct > a.gainPct ? b : a));
            const worst = withGain.reduce((a, b) => (b.gainPct < a.gainPct ? b : a));
            items.push(`Best performer: <strong>${escapeHtml(best.ticker)}</strong> <span class="${tone(best.gain)}">${fmtPct(best.gainPct, true)}</span>. Weakest: <strong>${escapeHtml(worst.ticker)}</strong> <span class="${tone(worst.gain)}">${fmtPct(worst.gainPct, true)}</span>.`);
        }
        const noBasis = data.positions.filter((p) => p.costBasis == null).length;
        if (noBasis) items.push(`${noBasis} position${noBasis === 1 ? ' has' : 's have'} no cost basis, so ${noBasis === 1 ? 'its' : 'their'} gain isn't counted.`);
        if (data.oversold.length) items.push(`Sells of <strong>${data.oversold.map(escapeHtml).join(', ')}</strong> exceed the shares on record; the extra was ignored.`);
        els.insights.innerHTML = items.length ? items.map((text) => `<li>${text}</li>`).join('') : '<li class="pf-muted">Nothing to note yet.</li>';
    }

    function priceCell(p) {
        if (p.price == null) {
            const label = p.priceStatus === 'pending' ? 'Loading…' : 'Unavailable';
            return `<span class="pf-muted">${label}</span>`;
        }
        const stale = p.priceStatus === 'stale' ? '<span class="pf-sub">older quote</span>' : '';
        return `${fmtMoney(p.price)}${stale}`;
    }

    function renderHoldings(data) {
        const asOf = data.holdings.asOf;
        els.holdingsSub.textContent = asOf
            ? `Holdings as of ${asOf}${data.transactions.some((t) => t.counted) ? ', plus later trades' : ''}.`
            : 'Built from your trades, at average cost.';
        // Each row's swatch is its segment in the allocation bar above.
        let priced = 0;
        els.holdingsBody.innerHTML = data.positions.map((p) => {
            const color = p.marketValue > 0 ? (SERIES[priced++] || OTHER) : 'transparent';
            return `
            <tr>
                <td>
                    <span class="pf-ticker-cell">
                        <span class="pf-swatch" style="background:${color}"></span>
                        <span>
                            <a class="pf-ticker" href="/stock-research/?ticker=${encodeURIComponent(p.ticker)}">${escapeHtml(p.ticker)}</a>
                            ${p.name && p.name !== p.ticker ? `<span class="pf-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>` : ''}
                        </span>
                    </span>
                </td>
                <td class="num pf-strong">${p.weight == null ? '—' : fmtPct(p.weight)}</td>
                <td class="num pf-strong">${fmtMoney(p.marketValue, true)}</td>
                <td class="num pf-hide-sm">${shareFormat.format(p.shares)}</td>
                <td class="num pf-hide-sm">${priceCell(p)}</td>
                <td class="num pf-hide-sm">${fmtMoney(p.costBasis, true)}${p.avgCost != null ? `<span class="pf-sub">${fmtMoney(p.avgCost)}/sh</span>` : ''}</td>
                <td class="num ${tone(p.gain)}">${fmtSigned(p.gain, true)}${p.gainPct != null ? `<span class="pf-sub ${tone(p.gain)}">${fmtPct(p.gainPct, true)}</span>` : ''}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" class="pf-muted">No open positions.</td></tr>';
    }

    const TRADES_SHOWN = 6;
    const tradeDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    let showAllTrades = false;

    function renderTransactions(data) {
        const count = data.transactions.length;
        els.transactionsSub.textContent = count
            ? `${count} trade${count === 1 ? '' : 's'}${data.transactionsIgnored ? ` · ${data.transactionsIgnored} already in your holdings` : ''}`
            : 'No trades yet. Upload a history or add one by hand.';
        document.getElementById('transactionsTable').hidden = !count;
        const shown = showAllTrades ? data.transactions : data.transactions.slice(0, TRADES_SHOWN);
        const toggle = $('tradesToggle');
        toggle.hidden = count <= TRADES_SHOWN;
        toggle.textContent = showAllTrades ? 'Show fewer' : `Show all ${count} trades`;
        els.transactionsBody.innerHTML = shown.map((t) => `
            <tr class="${t.counted ? '' : 'pf-tx-ignored'}">
                <td>${tradeDate.format(new Date(`${t.tradeDate}T00:00:00Z`))}${t.counted ? '' : '<span class="pf-tag" title="On or before your holdings date, so it is already in them">in holdings</span>'}</td>
                <td><strong>${escapeHtml(t.ticker)}</strong></td>
                <td><span class="pf-side pf-side--${t.side}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                <td class="num">${shareFormat.format(t.shares)}</td>
                <td class="num">${fmtMoney(t.price)}</td>
                <td class="num"><button type="button" class="pf-remove" data-id="${t.id}" aria-label="Remove ${t.side} of ${escapeHtml(t.ticker)} on ${t.tradeDate}">×</button></td>
            </tr>`).join('');
    }

    // ── value over time ────────────────────────────────────────────────────

    const RANGES = [
        { key: '1M', days: 31 },
        { key: '3M', days: 92 },
        { key: '6M', days: 183 },
        { key: 'YTD', days: null },
        { key: '1Y', days: 366 },
        { key: 'All', days: Infinity },
    ];
    const MAX_HISTORY_RETRIES = 30;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

    const history = { data: null, range: '1Y', signature: null, retries: 0, timer: null };

    // Reload the history only when what it's built from changed, not when the
    // breakdown is re-fetched for prices.
    function historySignature(data) {
        return JSON.stringify([data.holdings.asOf, data.holdings.count, data.transactions.map((t) => t.id)]);
    }

    function maybeLoadHistory(data) {
        const signature = historySignature(data);
        if (signature === history.signature) return;
        history.signature = signature;
        history.retries = 0;
        loadHistory();
    }

    async function loadHistory() {
        clearTimeout(history.timer);
        let data;
        try {
            data = await api('/history');
        } catch (error) {
            if (error instanceof ForbiddenError) return;
            $('historySub').textContent = 'Price history is unavailable right now.';
            drawChart([]);
            return;
        }
        if (!data.complete) {
            const n = data.pending.length;
            $('historySub').textContent = data.retryAfter > 5
                ? `Loading price history for ${n} more ticker${n === 1 ? '' : 's'}. The data provider limits requests per minute, so this can take a minute or two the first time.`
                : `Loading price history for ${n} more ticker${n === 1 ? '' : 's'}…`;
            if (history.retries < MAX_HISTORY_RETRIES) {
                history.retries += 1;
                history.timer = setTimeout(loadHistory, (data.retryAfter || 3) * 1000);
            }
            return;
        }
        history.data = data;
        renderHistory();
    }

    function pointsInRange() {
        const points = history.data?.points || [];
        if (!points.length) return points;
        const range = RANGES.find((r) => r.key === history.range);
        const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);
        let from;
        if (range.days === null) from = new Date(Date.UTC(last.getUTCFullYear(), 0, 1));
        else if (range.days === Infinity) return points;
        else from = new Date(last.getTime() - range.days * 86400000);
        const cutoff = from.toISOString().slice(0, 10);
        return points.filter((p) => p.date >= cutoff);
    }

    function renderRanges(points) {
        const span = points.length
            ? (new Date(points[points.length - 1].date) - new Date(points[0].date)) / 86400000
            : 0;
        // Offer a range only if the data reaches back past the one before it.
        const offered = RANGES.filter((r, i) => {
            if (r.days === null || r.days === Infinity) return true;
            const previous = RANGES.slice(0, i).reverse().find((q) => q.days && q.days !== Infinity);
            return !previous || span > previous.days;
        });
        if (!offered.some((r) => r.key === history.range)) history.range = 'All';
        $('historyRanges').innerHTML = offered.map((r) => (
            `<button type="button" data-range="${r.key}" aria-pressed="${r.key === history.range}">${r.key}</button>`
        )).join('');
    }

    function renderHistory() {
        const all = history.data.points;
        renderRanges(all);
        const points = pointsInRange();
        const sub = $('historySub');
        const note = $('historyNote');
        if (points.length < 2) {
            sub.textContent = all.length ? 'Not enough days in this range yet.' : 'No price history for these tickers.';
            note.hidden = true;
            drawChart([]);
            return;
        }
        const first = points[0].value;
        const last = points[points.length - 1].value;
        const change = last - first;
        // With trades inside the range, a percent change would mostly be new
        // money (a first $2k buy growing to $45k reads as +2,000%), so show
        // the dollar change alone.
        const tradedInRange = lastData?.transactions.some((t) => t.tradeDate > points[0].date);
        const pct = tradedInRange || !first ? '' : ` (${fmtPct(change / first, true)})`;
        sub.innerHTML = `<span class="pf-history-change ${tone(change)}">${fmtSigned(change, true)}${pct}</span> since ${longDate.format(new Date(`${points[0].date}T00:00:00Z`))}`;

        const notes = [];
        const asOf = history.data.asOf;
        if (asOf && points[0].date < asOf) {
            notes.push(`Before ${longDate.format(new Date(`${asOf}T00:00:00Z`))}, this assumes you held the holdings you uploaded, less any trades you've added since.`);
        }
        if (tradedInRange) {
            notes.push('Buys and sells in this range move the line too, so it shows money added as well as growth.');
        }
        if (history.data.missing.length) {
            notes.push(`No price history for ${history.data.missing.join(', ')}, so ${history.data.missing.length === 1 ? 'it is' : 'they are'} left out.`);
        }
        if (history.data.sampleData) notes.push('Generated sample prices, not real history.');
        note.textContent = notes.join(' ');
        note.hidden = !notes.length;
        drawChart(points);
    }

    function svg(tag, attrs = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
        return node;
    }

    function niceTicks(min, max, count) {
        const span = max - min || Math.abs(max) || 1;
        const raw = span / count;
        const magnitude = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
        const ticks = [];
        for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v);
        return ticks;
    }

    function compactMoney(value) {
        const abs = Math.abs(value);
        if (abs >= 1e6) return `$${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
        if (abs >= 1e3) return `$${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
        return `$${Math.round(value)}`;
    }

    function drawChart(points) {
        const host = $('historyChart');
        host.innerHTML = '';
        if (points.length < 2) {
            host.innerHTML = '<div class="pf-chart__empty">No chart yet.</div>';
            return;
        }
        const width = host.clientWidth;
        const height = host.clientHeight;
        const pad = { top: 10, right: 8, bottom: 24, left: 48 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;

        const values = points.map((p) => p.value);
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        const margin = (hi - lo) * 0.08 || hi * 0.05 || 1;
        lo = Math.max(0, lo - margin);
        hi += margin;
        const ticks = niceTicks(lo, hi, 4);
        lo = Math.min(lo, ticks[0]);
        hi = Math.max(hi, ticks[ticks.length - 1]);

        const x = (i) => pad.left + (i / (points.length - 1)) * innerW;
        const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;

        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Portfolio value from ${points[0].date} to ${points[points.length - 1].date}` });
        ticks.forEach((t) => {
            root.appendChild(svg('line', { class: 'pf-chart__grid', x1: pad.left, x2: width - pad.right, y1: y(t), y2: y(t) }));
            const label = svg('text', { class: 'pf-chart__axis', x: pad.left - 8, y: y(t) + 4, 'text-anchor': 'end' });
            label.textContent = compactMoney(t);
            root.appendChild(label);
        });

        // About one date label per 110px, never crowding the ends.
        const span = (new Date(points[points.length - 1].date) - new Date(points[0].date)) / 86400000;
        const fmt = span > 200 ? monthYear : shortDate;
        const labelCount = Math.max(2, Math.floor(innerW / 110));
        for (let k = 0; k < labelCount; k += 1) {
            const i = Math.round((k / (labelCount - 1)) * (points.length - 1));
            const label = svg('text', {
                class: 'pf-chart__axis', x: x(i), y: height - 6,
                'text-anchor': k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle',
            });
            label.textContent = fmt.format(new Date(`${points[i].date}T00:00:00Z`));
            root.appendChild(label);
        }

        const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
        root.appendChild(svg('path', { class: 'pf-chart__area', d: `${line}L${x(points.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z` }));
        root.appendChild(svg('path', { class: 'pf-chart__line', d: line }));

        const cross = svg('line', { class: 'pf-chart__cross', y1: pad.top, y2: pad.top + innerH, visibility: 'hidden' });
        const dot = svg('circle', { class: 'pf-chart__dot', r: 4.5, visibility: 'hidden' });
        root.appendChild(cross);
        root.appendChild(dot);
        // The hit area is the whole plot, not the 2px line.
        const hit = svg('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent' });
        root.appendChild(hit);

        function hover(event) {
            const box = root.getBoundingClientRect();
            const px = ((event.clientX - box.left) / box.width) * width;
            const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.left) / innerW) * (points.length - 1))));
            const p = points[i];
            cross.setAttribute('x1', x(i));
            cross.setAttribute('x2', x(i));
            dot.setAttribute('cx', x(i));
            dot.setAttribute('cy', y(p.value));
            cross.setAttribute('visibility', 'visible');
            dot.setAttribute('visibility', 'visible');
            const vsStart = p.value - points[0].value;
            showTip(event, `${longDate.format(new Date(`${p.date}T00:00:00Z`))} · ${fmtMoney(p.value, true)} · ${fmtSigned(vsStart, true)}`);
        }
        hit.addEventListener('mousemove', hover);
        hit.addEventListener('touchmove', (event) => { hover(event.touches[0]); event.preventDefault(); }, { passive: false });
        const leave = () => {
            cross.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
            hideTip();
        };
        hit.addEventListener('mouseleave', leave);
        hit.addEventListener('touchend', leave);
        host.appendChild(root);
    }

    $('historyRanges').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-range]');
        if (!button || !history.data) return;
        history.range = button.dataset.range;
        renderHistory();
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (history.data && !els.dashboard.hidden) renderHistory(); }, 120);
    });

    function schedulePendingRetry(data) {
        clearTimeout(pendingTimer);
        if (!data.totals.pendingPrices) {
            pendingRetries = 0;
            return;
        }
        if (pendingRetries >= MAX_PENDING_RETRIES) return;
        pendingRetries += 1;
        pendingTimer = setTimeout(() => load(), (data.retryAfter || 3) * 1000);
    }

    async function load() {
        const data = await run(() => api());
        if (data) render(data);
    }

    // ── upload ─────────────────────────────────────────────────────────────

    function selectedKind() {
        return els.uploadForm.querySelector('input[name="kind"]:checked').value;
    }
    function syncKindOptions() {
        const kind = selectedKind();
        els.asOfField.hidden = kind === 'transactions';
        els.replaceField.hidden = kind === 'holdings';
    }

    async function readFile(file) {
        if (!file) return;
        if (file.size > 1_000_000) {
            showError('That file is too large. Keep it under 1 MB.');
            return;
        }
        fileText = await file.text();
        els.fileName.textContent = file.name;
    }

    async function upload(csv) {
        const body = { csv, kind: selectedKind(), replace: els.replaceInput.checked };
        if (els.asOfInput.value) body.as_of = els.asOfInput.value;
        els.uploadButton.disabled = true;
        const result = await run(() => api('/import', { method: 'POST', body }));
        els.uploadButton.disabled = false;
        if (!result) return;

        const { kind, count } = result.imported;
        const what = kind === 'holdings' ? `holding${count === 1 ? '' : 's'}` : `trade${count === 1 ? '' : 's'}`;
        const skipped = result.skipped.length
            ? ` Skipped ${result.skipped.length} row${result.skipped.length === 1 ? '' : 's'}: ${summarizeSkipped(result.skipped)}.`
            : '';
        showNotice(`Imported ${count} ${what}.${skipped}`);
        fileText = null;
        els.fileInput.value = '';
        els.pasteInput.value = '';
        els.fileName.textContent = 'A positions or transactions export from your broker works as is.';
        pendingRetries = 0;
        render(result.portfolio);
        if (count) setUploadOpen(false);
    }

    function summarizeSkipped(skipped) {
        const reasons = new Map();
        skipped.forEach((s) => reasons.set(s.reason, (reasons.get(s.reason) || 0) + 1));
        return [...reasons].slice(0, 3).map(([reason, n]) => `${reason}${n > 1 ? ` (${n})` : ''}`).join('; ');
    }

    els.uploadForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const csv = fileText || els.pasteInput.value.trim();
        if (!csv) {
            showError('Choose a CSV file or paste its text first.');
            return;
        }
        upload(csv);
    });
    els.sampleButton.addEventListener('click', () => {
        els.uploadForm.querySelector('input[value="transactions"]').checked = true;
        syncKindOptions();
        upload(sampleCsv());
    });
    els.uploadForm.querySelectorAll('input[name="kind"]').forEach((input) => input.addEventListener('change', syncKindOptions));
    els.fileInput.addEventListener('change', () => readFile(els.fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((type) => els.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        els.dropZone.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((type) => els.dropZone.addEventListener(type, () => els.dropZone.classList.remove('is-over')));
    els.dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        readFile(event.dataTransfer.files[0]);
    });

    // ── edits ──────────────────────────────────────────────────────────────

    els.uploadToggle.addEventListener('click', () => setUploadOpen(els.uploadPanel.hidden));
    els.refreshButton.addEventListener('click', () => { pendingRetries = 0; load(); });
    $('tradesToggle').addEventListener('click', () => {
        showAllTrades = !showAllTrades;
        if (lastData) renderTransactions(lastData);
    });
    els.addToggle.addEventListener('click', () => {
        const open = els.addForm.hidden;
        els.addForm.hidden = !open;
        els.addToggle.setAttribute('aria-expanded', String(open));
        if (open) $('addTicker').focus();
    });
    els.addForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = await run(() => api('/transactions', {
            method: 'POST',
            body: {
                ticker: $('addTicker').value.trim(),
                side: $('addSide').value,
                shares: Number($('addShares').value),
                price: Number($('addPrice').value),
                trade_date: $('addDate').value,
            },
        }));
        if (!data) return;
        els.addForm.reset();
        $('addDate').value = today();
        render(data);
    });
    els.transactionsBody.addEventListener('click', async (event) => {
        const button = event.target.closest('.pf-remove');
        if (!button) return;
        const data = await run(() => api(`/transactions/${button.dataset.id}`, { method: 'DELETE' }));
        if (data) render(data);
    });
    els.clearHoldingsButton.addEventListener('click', async () => {
        if (!window.confirm('Remove your uploaded holdings? Your trades stay.')) return;
        const data = await run(() => api('/holdings', { method: 'DELETE' }));
        if (data) render(data);
    });
    els.clearAllButton.addEventListener('click', async () => {
        if (!window.confirm('Delete your whole portfolio, holdings and trades? This can\'t be undone.')) return;
        const data = await run(() => api('', { method: 'DELETE' }));
        if (data) { showNotice('Your portfolio was deleted.'); render(data); }
    });

    $('addDate').value = today();
    els.asOfInput.value = today();
    syncKindOptions();
    load();
})();
