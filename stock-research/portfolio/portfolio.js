// My Portfolio: a member's own holdings and trades, broken down.
// Every byte comes from /api/stocks/portfolio, which answers anonymous
// callers with a JSON 403; the page turns that into its sign-in panel.
//
// Five tabs (#overview, #holdings, #activity, #accounts, #gains) share one
// breakdown from the server. The trade list is the exception: a history can
// run to thousands of trades, so the Activity tab asks for one filtered page
// at a time.
(function () {
    const API_BASE = window.API_ORIGIN || '';
    const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
    const OTHER = 'var(--series-other)';
    // Prices still loading on the server: it fetches a few per request, and
    // pauses when the provider's per-minute allowance runs out. Its
    // `retryAfter` says when to ask again.
    const MAX_PENDING_RETRIES = 30;
    const TOP_HOLDINGS = 8;
    const TRADES_PER_PAGE = 50;
    const REALIZED_SHOWN = 12;
    const TABS = ['overview', 'holdings', 'activity', 'accounts', 'gains'];

    // A year of trades, dated relative to today, so the sample has a value
    // line that starts small and builds up rather than one flat snapshot.
    // Tagged "Sample" so a real upload replaces them.
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
            return `${isoDay(day)},${action},${ticker},${shares},${price},Sample`;
        });
        return ['Date,Action,Symbol,Quantity,Price,Source', ...rows].join('\n');
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
        replaceLabel: $('replaceLabel'),
        dashboard: $('dashboard'),
        tabs: $('tabs'),
        heroValue: $('heroValue'),
        insightGrid: $('insightGrid'),
        sectorCard: $('sectorCard'),
        allocationBar: $('allocationBar'),
        sectorBars: $('sectorBars'),
        insights: $('insights'),
        topHoldingsSub: $('topHoldingsSub'),
        topHoldingsBody: document.querySelector('#topHoldingsTable tbody'),
        allHoldingsLink: $('allHoldingsLink'),
        holdingsSub: $('holdingsSub'),
        holdingsBody: document.querySelector('#holdingsTable tbody'),
        closedCard: $('closedCard'),
        closedSub: $('closedSub'),
        closedBody: document.querySelector('#closedTable tbody'),
        transactionsSub: $('transactionsSub'),
        transactionsBody: document.querySelector('#transactionsTable tbody'),
        filters: $('filters'),
        pagerText: $('pagerText'),
        pagePrev: $('pagePrev'),
        pageNext: $('pageNext'),
        addToggle: $('addToggle'),
        addForm: $('addForm'),
        clearHoldingsButton: $('clearHoldingsButton'),
        clearAllButton: $('clearAllButton'),
    };

    let fileText = null;
    let pendingRetries = 0;
    let pendingTimer = null;
    let lastData = null;

    class ForbiddenError extends Error {}

    // ── formatting ─────────────────────────────────────────────────────────

    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const moneyWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const shareFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
    const countFormat = new Intl.NumberFormat('en-US');
    const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const monthYearLong = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

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
    function fmtDay(iso) {
        return iso ? longDate.format(new Date(`${iso}T00:00:00Z`)) : '—';
    }
    function fmtMonth(iso) {
        return iso ? monthYearLong.format(new Date(`${iso}T00:00:00Z`)) : '—';
    }
    function plural(n, word) {
        return `${countFormat.format(n)} ${word}${n === 1 ? '' : 's'}`;
    }
    function tone(value) {
        if (value == null || Math.abs(value) < 0.005) return '';
        return value > 0 ? 'is-gain' : 'is-loss';
    }
    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function isoDay(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function today() {
        return isoDay(new Date());
    }
    const ASSET_TAGS = { crypto: 'Crypto', other: 'No ticker' };
    function holdingHref(ticker) {
        return `#holding/${encodeURIComponent(ticker)}`;
    }
    function securityLink(row) {
        const tag = ASSET_TAGS[row.asset] ? `<span class="pf-tag">${ASSET_TAGS[row.asset]}</span>` : '';
        return `<a class="pf-ticker" href="${holdingHref(row.ticker)}">${escapeHtml(row.ticker)}</a>${tag}`;
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

    // ── tabs ───────────────────────────────────────────────────────────────

    function currentTab() {
        const hash = window.location.hash.replace('#', '');
        if (hash.startsWith('holding/')) return 'holding';
        return TABS.includes(hash) ? hash : 'overview';
    }
    function holdingTicker() {
        try {
            return decodeURIComponent(window.location.hash.slice('#holding/'.length));
        } catch {
            return '';
        }
    }
    // The list a holding was opened from, for its back link.
    let listTab = 'holdings';

    function showTab() {
        const tab = currentTab();
        if (tab !== 'holding') listTab = tab;
        els.tabs.querySelectorAll('a[data-tab]').forEach((link) => {
            if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        document.querySelectorAll('.pf-panel').forEach((panel) => {
            panel.hidden = panel.dataset.panel !== tab;
        });
        // The chart measures its box, so draw it once its tab is showing.
        if (tab === 'overview' && history.data) renderHistory();
        if (tab === 'activity' && lastData) loadTrades();
        if (tab === 'holding') {
            const back = $('holdingBack');
            back.href = `#${listTab}`;
            back.textContent = `← ${listTab[0].toUpperCase()}${listTab.slice(1)}`;
            if (holding.ticker !== holdingTicker()) window.scrollTo(0, 0);
            loadHolding(holdingTicker());
        }
    }
    // Tapping anywhere on a security's row opens it.
    document.addEventListener('click', (event) => {
        const row = event.target.closest('tr[data-ticker]');
        if (!row || event.target.closest('a, button, input, select')) return;
        window.location.hash = holdingHref(row.dataset.ticker);
    });
    window.addEventListener('hashchange', showTab);

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

    function render(data) {
        lastData = data;
        els.loadingView.hidden = true;
        els.signedOutView.hidden = true;
        const empty = data.positions.length === 0 && data.transactionCount === 0;
        els.dashboard.hidden = empty;
        els.headActions.hidden = empty;
        els.uploadTitle.textContent = empty ? 'Add your portfolio' : 'Upload more';
        // The sample adds trades to whatever is there, so offer it only to an empty portfolio.
        els.sampleButton.hidden = !empty;
        els.replaceLabel.textContent = data.transactionCount
            ? `Replace my ${plural(data.transactionCount, 'saved trade')} with this file`
            : 'Replace my saved trades with this file';
        if (empty) setUploadOpen(true);
        if (empty) return;

        renderHero(data);
        renderAllocation(data);
        renderTopHoldings(data);
        renderSectors(data);
        renderInsights(data);
        renderHoldings(data);
        renderClosed(data);
        renderSplits(data);
        renderFilters(data);
        renderAccounts(data);
        renderGains(data);
        maybeLoadHistory(data);
        els.clearHoldingsButton.hidden = !data.holdings.count;
        showTab();
        schedulePendingRetry(data);
    }

    function renderHero(data) {
        els.heroValue.textContent = fmtMoney(data.totals.marketValue, true);
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
        tip.style.left = `${Math.max(8, x)}px`;
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
        const t = data.totals;
        const priced = data.positions.filter((p) => p.weight != null);
        if (data.firstTrade) {
            items.push(`<strong>${plural(data.transactionCount, 'trade')}</strong> since ${fmtMonth(data.firstTrade)}, across <strong>${plural(data.accounts.length, 'account')}</strong>.`);
        }
        if (priced.length) {
            const top = priced[0];
            items.push(`<strong>${escapeHtml(top.ticker)}</strong> is your largest position at <strong>${fmtPct(top.weight)}</strong> of the portfolio.`);
            if (priced.length > 5) {
                const topFive = priced.slice(0, 5).reduce((sum, p) => sum + p.weight, 0);
                items.push(`Your top five holdings make up <strong>${fmtPct(topFive)}</strong>.`);
            }
        }
        const sectors = knownSectors(data);
        if (sectors.length > 1) {
            items.push(`<strong>${escapeHtml(sectors[0].sector)}</strong> is your heaviest sector, <strong>${fmtPct(sectors[0].weight)}</strong> of the total.`);
        }
        const withGain = data.positions.filter((p) => p.gainPct != null);
        if (withGain.length > 1) {
            const best = withGain.reduce((a, b) => (b.gainPct > a.gainPct ? b : a));
            const worst = withGain.reduce((a, b) => (b.gainPct < a.gainPct ? b : a));
            items.push(`Best performer: <strong>${escapeHtml(best.ticker)}</strong> <span class="${tone(best.gain)}">${fmtPct(best.gainPct, true)}</span>. Weakest: <strong>${escapeHtml(worst.ticker)}</strong> <span class="${tone(worst.gain)}">${fmtPct(worst.gainPct, true)}</span>.`);
        }
        if (data.aliases.length) {
            const named = data.aliases.map((a) => `“${escapeHtml(a.name)}” as <strong>${escapeHtml(a.ticker)}</strong>`).join(', ');
            items.push(`Counted ${named}: the same trades appear under both in different sources.`);
        }
        if (data.duplicates.count) {
            const pairs = data.duplicates.pairs.map((p) => `${countFormat.format(p.count)} from ${escapeHtml(p.duplicateSource)} repeating ${escapeHtml(p.keptSource)}`).join(', ');
            items.push(`<strong>${plural(data.duplicates.count, 'trade')}</strong> appear twice across your sources (${pairs}), so each is counted once. <a href="#activity">They're tagged in Activity.</a>`);
        }
        if (data.splits.tradesAdjusted) {
            const tickers = [...new Set(data.splits.applied.map((a) => a.ticker))];
            items.push(`Adjusted ${plural(data.splits.tradesAdjusted, 'trade')} for ${plural(data.splits.applied.length, 'stock split')} (${tickers.slice(0, 4).map(escapeHtml).join(', ')}${tickers.length > 4 ? '…' : ''}). <a href="#holdings">See splits</a>`);
        }
        if (t.estimatedPositions) {
            items.push(`${plural(t.estimatedPositions, 'position')} ${t.estimatedPositions === 1 ? 'has' : 'have'} no market price, so ${t.estimatedPositions === 1 ? "it's" : "they're"} valued at your last trade.`);
        }
        const noBasis = data.positions.filter((p) => p.costBasis == null).length;
        if (noBasis) items.push(`${plural(noBasis, 'position')} ${noBasis === 1 ? 'has' : 'have'} no cost basis, so ${noBasis === 1 ? 'its' : 'their'} gain isn't counted.`);
        if (data.oversold.length) {
            items.push(`Sells of <strong>${data.oversold.map(escapeHtml).join(', ')}</strong> exceed the shares on record before them; the extra was ignored. A missing buy, or one filed under a different date, usually explains it.`);
        }
        els.insights.innerHTML = items.length ? items.map((text) => `<li>${text}</li>`).join('') : '<li class="pf-muted">Nothing to note yet.</li>';
    }

    function priceCell(p) {
        if (p.price == null) {
            const label = p.priceStatus === 'pending' ? 'Loading…' : 'Unavailable';
            return `<span class="pf-muted">${label}</span>`;
        }
        const note = p.priceStatus === 'stale' ? `<span class="pf-sub">close ${fmtDay(p.priceAsOf)}</span>`
            : p.priceStatus === 'trade' ? '<span class="pf-sub">last trade</span>' : '';
        return `${fmtMoney(p.price)}${note}`;
    }

    function swatches(positions) {
        // Each row's swatch is its segment in the allocation bar.
        let priced = 0;
        return positions.map((p) => (p.marketValue > 0 ? (SERIES[priced++] || OTHER) : 'transparent'));
    }

    function securityCell(p, color) {
        return `<span class="pf-ticker-cell">
            <span class="pf-swatch" style="background:${color}"></span>
            <span>
                ${securityLink(p)}
                ${p.name && p.name !== p.ticker ? `<span class="pf-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>` : ''}
            </span>
        </span>`;
    }

    function gainCell(p, extra = '') {
        return `<td class="num ${extra} ${tone(p.gain)}">${fmtSigned(p.gain, true)}${p.gainPct != null ? `<span class="pf-sub ${tone(p.gain)}">${fmtPct(p.gainPct, true)}</span>` : ''}</td>`;
    }

    // The latest day's move, against the close before it.
    function dayCell(p) {
        if (p.dayChange == null) return '<td class="num pf-muted">—</td>';
        return `<td class="num ${tone(p.dayChange)}">${fmtSigned(p.dayChange, true)}<span class="pf-sub ${tone(p.dayChange)}">${fmtPct(p.dayChangePct, true)}</span></td>`;
    }

    function renderTopHoldings(data) {
        const colors = swatches(data.positions);
        const top = data.positions.slice(0, TOP_HOLDINGS);
        els.topHoldingsSub.textContent = data.positions.length > TOP_HOLDINGS
            ? `The largest ${TOP_HOLDINGS} of ${data.positions.length} open positions.`
            : plural(data.positions.length, 'open position');
        els.allHoldingsLink.textContent = data.totals.closedPositions
            ? `All holdings and ${data.totals.closedPositions} closed`
            : 'All holdings';
        els.topHoldingsBody.innerHTML = top.map((p, i) => `
            <tr data-ticker="${escapeHtml(p.ticker)}">
                <td>${securityCell(p, colors[i])}</td>
                <td class="num pf-strong">${p.weight == null ? '—' : fmtPct(p.weight)}</td>
                <td class="num pf-strong">${fmtMoney(p.marketValue, true)}</td>
                ${dayCell(p)}
                ${gainCell(p, 'pf-hide-sm')}
            </tr>`).join('') || '<tr><td colspan="5" class="pf-muted">No open positions.</td></tr>';
    }

    function renderHoldings(data) {
        const asOf = data.holdings.asOf;
        els.holdingsSub.textContent = asOf
            ? `Holdings as of ${fmtDay(asOf)}${data.transactionCount ? ', plus later trades' : ''}. Cost is average cost across every account.`
            : `Built from ${plural(data.transactionCount, 'trade')}, at average cost across every account.`;
        const colors = swatches(data.positions);
        els.holdingsBody.innerHTML = data.positions.map((p, i) => `
            <tr data-ticker="${escapeHtml(p.ticker)}">
                <td>${securityCell(p, colors[i])}</td>
                <td class="num pf-strong pf-hide-sm">${p.weight == null ? '—' : fmtPct(p.weight)}</td>
                <td class="num pf-strong">${fmtMoney(p.marketValue, true)}</td>
                ${dayCell(p)}
                <td class="num pf-hide-sm">${shareFormat.format(p.shares)}</td>
                <td class="num pf-hide-sm">${priceCell(p)}</td>
                <td class="num pf-hide-sm">${fmtMoney(p.costBasis, true)}${p.avgCost != null ? `<span class="pf-sub">${fmtMoney(p.avgCost)}/sh</span>` : ''}</td>
                ${gainCell(p)}
                <td class="num pf-hide-md ${tone(p.realizedGain)}">${fmtSigned(p.realizedGain, true)}</td>
                <td class="num pf-hide-md">${fmtMonth(p.firstTrade)}<span class="pf-sub">${plural(p.trades, 'trade')}</span></td>
            </tr>`).join('') || '<tr><td colspan="10" class="pf-muted">No open positions.</td></tr>';
    }

    function renderClosed(data) {
        const closed = data.closedPositions;
        els.closedCard.hidden = !closed.length;
        const realized = closed.reduce((sum, c) => sum + (c.realizedGain || 0), 0);
        els.closedSub.innerHTML = `${plural(closed.length, 'position')} you've sold out of, newest first. <span class="${tone(realized)}">${fmtSigned(realized, true)}</span> realized between them.`;
        els.closedBody.innerHTML = closed.map((c) => `
            <tr data-ticker="${escapeHtml(c.ticker)}">
                <td>${securityLink(c)}</td>
                <td class="num pf-strong ${tone(c.realizedGain)}">${fmtSigned(c.realizedGain, true)}</td>
                <td class="num pf-hide-sm">${fmtMoney(c.bought, true)}</td>
                <td class="num pf-hide-sm">${fmtMoney(c.sold, true)}</td>
                <td class="num pf-hide-sm">${countFormat.format(c.trades)}</td>
                <td class="num">${fmtMonth(c.first)}<span class="pf-sub">to ${fmtMonth(c.last)}</span></td>
            </tr>`).join('');
    }

    function splitLabel(ratio) {
        const whole = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(3)));
        return ratio >= 1 ? `${whole(ratio)}-for-1` : `1-for-${whole(1 / ratio)}`;
    }

    function renderSplits(data) {
        const { applied, tradesAdjusted, alreadyAdjusted } = data.splits;
        $('splitsCard').hidden = !applied.length && !alreadyAdjusted;
        const parts = [];
        if (tradesAdjusted) parts.push(`${plural(tradesAdjusted, 'trade')} from before a split ${tradesAdjusted === 1 ? 'is' : 'are'} counted in today's shares; the money paid doesn't change.`);
        if (alreadyAdjusted) parts.push(`${plural(alreadyAdjusted, 'trade')} already matched the split-adjusted price, so ${alreadyAdjusted === 1 ? 'it was' : 'they were'} left as recorded.`);
        $('splitsSub').textContent = parts.join(' ');
        $('splitsTable').innerHTML = applied.length ? `
            <thead><tr><th scope="col">Security</th><th scope="col">Split</th><th scope="col" class="num">Date</th><th scope="col" class="num">Trades adjusted</th></tr></thead>
            <tbody>${applied.map((a) => `
                <tr>
                    <td>${securityLink({ ticker: a.ticker, asset: 'stock' })}</td>
                    <td>${splitLabel(a.ratio)}</td>
                    <td class="num">${fmtDay(a.date)}</td>
                    <td class="num">${countFormat.format(a.trades)}</td>
                </tr>`).join('')}
            </tbody>` : '';
    }

    // ── accounts ───────────────────────────────────────────────────────────

    function activityTable(table, rows, kind) {
        const showReported = rows.some((r) => r.realizedReported != null);
        table.innerHTML = `
            <thead><tr>
                <th scope="col">${kind}</th>
                <th scope="col" class="num">Trades</th>
                <th scope="col" class="num">Bought</th>
                <th scope="col" class="num pf-hide-sm">Sold</th>
                <th scope="col" class="num">Net in</th>
                <th scope="col" class="num pf-hide-md">Securities</th>
                ${showReported ? '<th scope="col" class="num pf-hide-md">Reported realized</th>' : ''}
                <th scope="col" class="num pf-hide-sm">Active</th>
            </tr></thead>
            <tbody>${rows.map((r) => `
                <tr>
                    <td><button type="button" class="pf-linkish" data-filter="${kind === 'Account' ? 'account' : 'source'}" data-value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button></td>
                    <td class="num">${countFormat.format(r.trades)}<span class="pf-sub">${countFormat.format(r.buys)} buys · ${countFormat.format(r.sells)} sells</span></td>
                    <td class="num">${fmtMoney(r.bought, true)}</td>
                    <td class="num pf-hide-sm">${fmtMoney(r.sold, true)}</td>
                    <td class="num pf-strong">${fmtSigned(r.net, true)}</td>
                    <td class="num pf-hide-md">${countFormat.format(r.securities)}</td>
                    ${showReported ? `<td class="num pf-hide-md ${tone(r.realizedReported)}">${fmtSigned(r.realizedReported, true)}</td>` : ''}
                    <td class="num pf-hide-sm">${fmtMonth(r.first)}<span class="pf-sub">to ${fmtMonth(r.last)}</span></td>
                </tr>`).join('')}
            </tbody>`;
    }

    function renderAccounts(data) {
        activityTable($('accountsTable'), data.accounts, 'Account');
        activityTable($('sourcesTable'), data.sources, 'Source');
        $('accountOptions').innerHTML = data.facets.accounts.map((a) => `<option value="${escapeHtml(a)}">`).join('');
    }

    // An account or source name jumps to its trades.
    ['accountsTable', 'sourcesTable'].forEach((id) => $(id).addEventListener('click', (event) => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        resetFilters();
        $(button.dataset.filter === 'account' ? 'filterAccount' : 'filterSource').value = button.dataset.value;
        window.location.hash = 'activity';
    }));

    // ── gains ──────────────────────────────────────────────────────────────

    function gainTile(label, value, sub, valueClass = '') {
        return `<div class="pf-tile">
            <div class="pf-tile__label">${label}</div>
            <div class="pf-tile__value ${valueClass}">${value}</div>
            <div class="pf-tile__sub">${sub}</div>
        </div>`;
    }

    let showAllRealized = false;

    function renderGains(data) {
        const t = data.totals;
        const total = (t.gain || 0) + (t.realizedGain || 0);
        $('gainTiles').innerHTML = [
            gainTile('Unrealized', fmtSigned(t.gain, true), t.gainPct == null ? 'On open positions' : `${fmtPct(t.gainPct, true)} on ${fmtMoney(t.costBasis, true)} cost`, tone(t.gain)),
            gainTile('Realized', fmtSigned(t.realizedGain, true), 'From every sell, at average cost', tone(t.realizedGain)),
            gainTile('Total gain', fmtSigned(total, true), 'Unrealized plus realized', tone(total)),
            gainTile('Fees paid', fmtMoney(t.fees, true), `${fmtMoney(t.invested, true)} bought · ${fmtMoney(t.withdrawn, true)} sold`),
        ].join('');

        // Realized gain by year: one bar each, up for gains and down for losses
        // from a shared zero line.
        // The zero line sits where the data puts it: at the foot when every
        // year is a gain, part way up when some are losses.
        const years = [...data.years].reverse();
        const up = Math.max(0, ...years.map((y) => y.realized));
        const down = Math.max(0, ...years.map((y) => -y.realized));
        const range = up + down || 1;
        const zero = (up / range) * 100; // % from the top
        $('yearBars').style.setProperty('--zero', `${zero}%`);
        $('yearBars').setAttribute('aria-label', years.map((y) => `${y.year}: ${fmtSigned(y.realized, true)} realized`).join(', '));
        $('yearBars').innerHTML = years.map((y) => {
            const size = (Math.abs(y.realized) / range) * 100;
            const cls = y.realized >= 0 ? 'pf-yearbar__bar--gain' : 'pf-yearbar__bar--loss';
            const pos = y.realized >= 0 ? `bottom:${100 - zero}%;height:${size}%` : `top:${zero}%;height:${size}%`;
            return `<div class="pf-yearbar" title="${y.year}: ${fmtSigned(y.realized, true)} realized">
                <div class="pf-yearbar__plot"><span class="pf-yearbar__bar ${cls}" style="${pos}"></span></div>
                <span class="pf-yearbar__label">${String(y.year).slice(2)}</span>
            </div>`;
        }).join('');

        $('yearsTable').innerHTML = `
            <thead><tr>
                <th scope="col">Year</th>
                <th scope="col" class="num">Realized</th>
                <th scope="col" class="num">Trades</th>
                <th scope="col" class="num pf-hide-sm">Bought</th>
                <th scope="col" class="num pf-hide-sm">Sold</th>
                <th scope="col" class="num">Net in</th>
                <th scope="col" class="num pf-hide-md">Fees</th>
            </tr></thead>
            <tbody>${data.years.map((y) => `
                <tr>
                    <td><button type="button" class="pf-linkish" data-year="${y.year}">${y.year}</button></td>
                    <td class="num pf-strong ${tone(y.realized)}">${fmtSigned(y.realized, true)}</td>
                    <td class="num">${countFormat.format(y.trades)}</td>
                    <td class="num pf-hide-sm">${fmtMoney(y.bought, true)}</td>
                    <td class="num pf-hide-sm">${fmtMoney(y.sold, true)}</td>
                    <td class="num">${fmtSigned(y.net, true)}</td>
                    <td class="num pf-hide-md">${fmtMoney(y.fees, true)}</td>
                </tr>`).join('')}
            </tbody>`;

        const reported = data.reportedRealized;
        const realized = data.realizedByTicker;
        $('realizedSub').innerHTML = reported.count
            ? `Your file reported <strong class="${tone(reported.reported)}">${fmtSigned(reported.reported, true)}</strong> realized on ${plural(reported.count, 'sell')}; at average cost across all your accounts, the same sells come to <strong class="${tone(reported.computed)}">${fmtSigned(reported.computed, true)}</strong>. The two differ when the source matched lots differently (first in, first out) or saw only one account.`
            : 'Gain on every security you have sold, at average cost.';
        const shown = showAllRealized ? realized : realized.slice(0, REALIZED_SHOWN);
        $('realizedTable').innerHTML = `
            <thead><tr><th scope="col">Security</th><th scope="col" class="num">Realized</th><th scope="col" class="num">Sold</th></tr></thead>
            <tbody>${shown.map((r) => `
                <tr>
                    <td><strong>${escapeHtml(r.ticker)}</strong></td>
                    <td class="num pf-strong ${tone(r.realizedGain)}">${fmtSigned(r.realizedGain, true)}</td>
                    <td class="num">${fmtMoney(r.sold, true)}</td>
                </tr>`).join('') || '<tr><td colspan="3" class="pf-muted">No sells yet.</td></tr>'}
            </tbody>`;
        const toggle = $('realizedToggle');
        toggle.hidden = realized.length <= REALIZED_SHOWN;
        toggle.textContent = showAllRealized ? 'Show fewer' : `Show all ${realized.length}`;
    }

    $('realizedToggle').addEventListener('click', () => {
        showAllRealized = !showAllRealized;
        if (lastData) renderGains(lastData);
    });
    $('yearsTable').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-year]');
        if (!button) return;
        resetFilters();
        $('filterYear').value = button.dataset.year;
        window.location.hash = 'activity';
    });

    // ── activity ───────────────────────────────────────────────────────────

    const trades = { offset: 0, total: 0, version: null, timer: null };

    function fillSelect(select, values, allLabel) {
        const current = select.value;
        select.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        if (values.map(String).includes(current)) select.value = current;
    }

    function renderFilters(data) {
        fillSelect($('filterYear'), data.facets.years, 'All years');
        fillSelect($('filterAccount'), data.facets.accounts, 'All accounts');
        fillSelect($('filterSource'), data.facets.sources, 'All sources');
        $('filterAsset').hidden = data.facets.assets.length < 2;
        $('filterSource').hidden = data.facets.sources.length < 2;
        $('filterAccount').hidden = data.facets.accounts.length < 2;
        // New or removed trades: the open page is out of date.
        if (trades.version !== data.transactionVersion) {
            trades.version = data.transactionVersion;
            if (currentTab() === 'activity') loadTrades();
        }
    }

    function resetFilters() {
        els.filters.reset();
        trades.offset = 0;
    }

    function filterParams() {
        const params = new URLSearchParams({ offset: String(trades.offset), limit: String(TRADES_PER_PAGE) });
        const fields = { q: 'filterQuery', side: 'filterSide', year: 'filterYear', account: 'filterAccount', source: 'filterSource', asset: 'filterAsset' };
        Object.entries(fields).forEach(([key, id]) => {
            const value = $(id).value.trim();
            if (value) params.set(key, value);
        });
        return params;
    }

    async function loadTrades() {
        const data = await run(() => api(`/transactions?${filterParams()}`));
        if (!data) return;
        trades.total = data.total;
        const filtered = filterParams().toString().replace(/(^|&)(offset|limit)=[^&]*/g, '') !== '';
        const dupes = lastData?.duplicates.count || 0;
        els.transactionsSub.textContent = lastData?.transactionCount
            ? `${filtered ? `${plural(data.total, 'row')} match · ` : ''}${plural(lastData.transactionCount, 'trade')} counted${dupes ? ` · ${countFormat.format(dupes)} duplicate${dupes === 1 ? '' : 's'} across sources not counted` : ''}${lastData.transactionsIgnored ? ` · ${countFormat.format(lastData.transactionsIgnored)} already in your holdings` : ''}`
            : 'No trades yet. Upload a history or add one by hand.';
        els.transactionsBody.innerHTML = data.rows.map((t) => {
            const realized = t.side === 'sell' && (t.realized != null || t.realizedReported != null)
                ? `<span class="${tone(t.realized)}">${fmtSigned(t.realized, true)}</span>${t.realizedReported != null ? `<span class="pf-sub" title="As your file reported it">file: ${fmtSigned(t.realizedReported, true)}</span>` : ''}`
                : '';
            return `
            <tr class="${t.counted ? '' : 'pf-tx-ignored'}">
                <td>${fmtDay(t.tradeDate)}${t.duplicateOf
                    ? `<span class="pf-tag" title="The same trade as the ${escapeHtml(t.duplicateOf.source || 'other')} row on ${fmtDay(t.duplicateOf.date)}, so it's counted once">duplicate</span>`
                    : t.counted ? '' : '<span class="pf-tag" title="On or before your holdings date, so it is already in them">in holdings</span>'}</td>
                <td>${t.aliasOf ? `${securityLink({ ticker: t.aliasOf, asset: 'stock' })}<span class="pf-tag" title="Filed as “${escapeHtml(t.ticker)}” in this source">${escapeHtml(t.ticker)}</span>` : securityLink(t)}${t.notes ? `<span class="pf-name pf-note-cell" title="${escapeHtml(t.notes)}">${escapeHtml(t.notes)}</span>` : ''}</td>
                <td><span class="pf-side pf-side--${t.side}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                ${t.splitFactor !== 1
                    ? `<td class="num" title="Adjusted for stock splits since the trade">${shareFormat.format(t.adjustedShares)}<span class="pf-sub">${shareFormat.format(t.shares)} as traded</span></td>
                <td class="num pf-hide-sm">${fmtMoney(t.adjustedPrice)}<span class="pf-sub">${fmtMoney(t.price)} as traded</span></td>`
                    : `<td class="num">${shareFormat.format(t.shares)}</td>
                <td class="num pf-hide-sm">${fmtMoney(t.price)}</td>`}
                <td class="num">${fmtMoney(t.amount)}${t.fees ? `<span class="pf-sub">${fmtMoney(t.fees)} fees</span>` : ''}</td>
                <td class="num pf-hide-md">${realized}</td>
                <td class="pf-hide-md pf-wrap">${escapeHtml(t.account || '—')}</td>
                <td class="pf-hide-lg pf-wrap">${escapeHtml(t.source || '—')}</td>
                <td class="num"><button type="button" class="pf-remove" data-id="${t.id}" aria-label="Remove ${t.side} of ${escapeHtml(t.ticker)} on ${t.tradeDate}">×</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="10" class="pf-muted">No trades match.</td></tr>';

        const from = data.total ? trades.offset + 1 : 0;
        const to = Math.min(trades.offset + TRADES_PER_PAGE, data.total);
        els.pagerText.textContent = data.total ? `${countFormat.format(from)}–${countFormat.format(to)} of ${countFormat.format(data.total)}` : '';
        els.pagePrev.disabled = trades.offset === 0;
        els.pageNext.disabled = to >= data.total;
        $('pager').hidden = data.total <= TRADES_PER_PAGE;
    }

    els.filters.addEventListener('input', (event) => {
        trades.offset = 0;
        clearTimeout(trades.timer);
        // Typing waits for a pause; the menus apply at once.
        trades.timer = setTimeout(loadTrades, event.target.id === 'filterQuery' ? 250 : 0);
    });
    els.filters.addEventListener('submit', (event) => event.preventDefault());
    els.pagePrev.addEventListener('click', () => {
        trades.offset = Math.max(0, trades.offset - TRADES_PER_PAGE);
        loadTrades();
    });
    els.pageNext.addEventListener('click', () => {
        trades.offset += TRADES_PER_PAGE;
        loadTrades();
    });

    // ── value over time ────────────────────────────────────────────────────

    const RANGES = [
        { key: '1W', days: 7 },
        { key: '1M', days: 31 },
        { key: '3M', days: 92 },
        { key: '6M', days: 183 },
        { key: 'YTD', days: null },
        { key: '1Y', days: 366 },
        { key: '5Y', days: 1827 },
        { key: 'All', days: Infinity },
    ];
    const MAX_HISTORY_RETRIES = 60;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const yearOnly = new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'UTC' });

    const history = { data: null, range: '1Y', signature: null, retries: 0, timer: null };

    // Whether the cost lines (invested, average cost) are drawn; remembered
    // per browser. Hidden, the y axis fits the price or value alone.
    let showCost = true;
    try { showCost = localStorage.getItem('pf.showCost') !== 'false'; } catch { /* storage blocked */ }
    function syncCostToggles() {
        document.querySelectorAll('[data-cost-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(showCost)));
    }
    syncCostToggles();
    document.addEventListener('click', (event) => {
        if (!event.target.closest('[data-cost-toggle]')) return;
        showCost = !showCost;
        try { localStorage.setItem('pf.showCost', String(showCost)); } catch { /* storage blocked */ }
        syncCostToggles();
        if (currentTab() === 'overview' && history.data) renderHistory();
        if (currentTab() === 'holding' && holding.data) renderHolding();
    });

    // Reload the history only when what it's built from changed, not when the
    // breakdown is re-fetched for prices.
    function historySignature(data) {
        return JSON.stringify([data.holdings.asOf, data.holdings.count, data.transactionVersion]);
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
        history.data = data;
        // Draw what's in while the rest loads: missing prices show as estimates.
        if (currentTab() === 'overview') renderHistory();
        if (!data.complete && history.retries < MAX_HISTORY_RETRIES) {
            history.retries += 1;
            history.timer = setTimeout(loadHistory, (data.retryAfter || 3) * 1000);
        }
    }

    function pointsInRange(points = history.data?.points || [], key = history.range) {
        if (!points.length) return points;
        const range = RANGES.find((r) => r.key === key);
        const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);
        let from;
        if (range.days === null) from = new Date(Date.UTC(last.getUTCFullYear(), 0, 1));
        else if (range.days === Infinity) return points;
        else from = new Date(last.getTime() - range.days * 86400000);
        const cutoff = from.toISOString().slice(0, 10);
        return points.filter((p) => p.date >= cutoff);
    }

    // Draws the range buttons the data can fill and returns the one to show.
    function renderRanges(points, container = $('historyRanges'), selected = history.range) {
        const span = points.length
            ? (new Date(points[points.length - 1].date) - new Date(points[0].date)) / 86400000
            : 0;
        // Offer a range only if the data reaches back past the one before it.
        const offered = RANGES.filter((r, i) => {
            if (r.days === null || r.days === Infinity) return true;
            const previous = RANGES.slice(0, i).reverse().find((q) => q.days && q.days !== Infinity);
            return !previous || span > previous.days;
        });
        const key = offered.some((r) => r.key === selected) ? selected : 'All';
        container.innerHTML = offered.map((r) => (
            `<button type="button" data-range="${r.key}" aria-pressed="${r.key === key}">${r.key}</button>`
        )).join('');
        return key;
    }

    // The gain over a range, less money put in or taken out, and its percent
    // as a time-weighted return: each day's gain on what was invested that
    // day, chained. A first $2k buy growing to $45k by adding money then
    // reads as its real gain, not +2,000%.
    function rangeReturn(points) {
        let gain = 0;
        let growth = 1;
        let counted = false;
        for (let i = 1; i < points.length; i += 1) {
            const flow = points[i].flow || 0;
            const day = points[i].value - points[i - 1].value - flow;
            gain += day;
            const base = points[i - 1].value + Math.max(flow, 0);
            if (base > 0) {
                growth *= 1 + day / base;
                counted = true;
            }
        }
        return { gain, pct: counted ? growth - 1 : null };
    }

    function renderHistory() {
        const all = history.data.points;
        history.range = renderRanges(all);
        const points = pointsInRange();
        const sub = $('historySub');
        const note = $('historyNote');
        const pending = history.data.pending.length;
        if (points.length < 2) {
            sub.textContent = pending ? 'Loading price history…' : all.length ? 'Not enough days in this range yet.' : 'No price history for these holdings.';
            note.hidden = true;
            $('historyLegend').hidden = true;
            drawChart([]);
            return;
        }
        $('historyLegend').hidden = false;
        const tradedInRange = lastData?.lastTrade && lastData.lastTrade > points[0].date;
        const { gain, pct } = rangeReturn(points);
        sub.innerHTML = `<span class="pf-history-change ${tone(gain)}">${fmtSigned(gain, true)}${pct == null ? '' : ` (${fmtPct(pct, true)})`}</span>`;

        const notes = [];
        const asOf = history.data.asOf;
        if (asOf && points[0].date < asOf) {
            notes.push(`Before ${fmtDay(asOf)}, this assumes you held the holdings you uploaded, less any trades you've added since.`);
        }
        if (tradedInRange) {
            notes.push('Buys and sells move the value line too, so the gain above leaves out money you put in or took out, and its percent is a time-weighted return.');
        }
        const estimated = points.some((p) => p.estimated);
        if (estimated) {
            notes.push('Dashed stretches use your own trade prices where no market close was available (a position with no ticker, or history not loaded yet).');
        }
        const backfilling = (history.data.backfilling || []).length;
        if (backfilling) {
            notes.push(`Fetching older prices for ${plural(backfilling, 'symbol')}; the dashed stretches fill in with real closes as they arrive${history.data.retryAfter > 60 ? ' (the history source limits requests per hour, so this can take a while the first time)' : ''}.`);
        } else if (pending) {
            notes.push(`Still loading prices for ${plural(pending, 'symbol')}${history.data.retryAfter > 5 ? '; the price provider limits requests per minute, so a long history fills in over a few minutes the first time' : ''}.`);
        }
        if (history.data.sampleData) notes.push('Generated sample prices, not real history.');
        note.textContent = notes.join(' ');
        note.hidden = !notes.length;
        $('estimatedKey').hidden = !estimated;
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

    // Split a series into runs where `test` holds, each run sharing its end
    // points with its neighbours so the dashed and solid stretches join up.
    function runs(points, test) {
        const out = [];
        let current = null;
        points.forEach((p, i) => {
            const on = test(p, i);
            if (on && !current) {
                current = i > 0 ? [i - 1, i] : [i];
                out.push(current);
            } else if (on) {
                current.push(i);
            } else if (current) {
                current.push(i);
                current = null;
            }
        });
        return out;
    }

    // About one date label per 110px, never crowding the ends.
    function dateLabels(root, points, x, innerW, height) {
        const span = (new Date(points[points.length - 1].date) - new Date(points[0].date)) / 86400000;
        const fmt = span > 1500 ? yearOnly : span > 200 ? monthYear : shortDate;
        const labelCount = Math.max(2, Math.min(points.length, Math.floor(innerW / 110)));
        for (let k = 0; k < labelCount; k += 1) {
            const i = Math.round((k / (labelCount - 1)) * (points.length - 1));
            const label = svg('text', {
                class: 'pf-chart__axis', x: x(i), y: height - 6,
                'text-anchor': k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle',
            });
            label.textContent = fmt.format(new Date(`${points[i].date}T00:00:00Z`));
            root.appendChild(label);
        }
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
        if (!width) return; // hidden tab: drawn when it's shown
        const pad = { top: 10, right: 8, bottom: 24, left: 48 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;

        const values = points.flatMap((p) => (showCost && p.invested != null ? [p.value, p.invested] : [p.value]));
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
        const path = (indices, key) => indices.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(points[i][key]).toFixed(1)}`).join('');

        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Portfolio value and amount invested from ${points[0].date} to ${points[points.length - 1].date}` });
        ticks.forEach((t) => {
            root.appendChild(svg('line', { class: 'pf-chart__grid', x1: pad.left, x2: width - pad.right, y1: y(t), y2: y(t) }));
            const label = svg('text', { class: 'pf-chart__axis', x: pad.left - 8, y: y(t) + 4, 'text-anchor': 'end' });
            label.textContent = compactMoney(t);
            root.appendChild(label);
        });

        dateLabels(root, points, x, innerW, height);

        const all = points.map((_, i) => i);
        const valueLine = path(all, 'value');
        root.appendChild(svg('path', { class: 'pf-chart__area', d: `${valueLine}L${x(points.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z` }));
        runs(points, (p) => showCost && p.invested != null).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__invested', d: path(indices, 'invested') }));
        });
        runs(points, (p) => !p.estimated).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__line', d: path(indices, 'value') }));
        });
        runs(points, (p) => p.estimated).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__line pf-chart__line--estimated', d: path(indices, 'value') }));
        });

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
            const parts = [fmtDay(p.date), `${fmtMoney(p.value, true)}${p.estimated ? ' (est.)' : ''}`];
            if (p.invested != null) parts.push(`invested ${fmtMoney(p.invested, true)}`, fmtSigned(p.value - p.invested, true));
            showTip(event, parts.join(' · '));
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

    // ── one holding ────────────────────────────────────────────────────────

    const holding = { ticker: null, data: null, range: '1Y', timer: null, retries: 0 };

    async function loadHolding(ticker, retry = false) {
        clearTimeout(holding.timer);
        if (!ticker) return;
        if (!retry) {
            if (holding.ticker === ticker && holding.data) {
                renderHolding();
                return;
            }
            holding.ticker = ticker;
            holding.data = null;
            holding.retries = 0;
            $('holdingName').textContent = ticker;
            $('holdingPrice').textContent = '—';
            $('holdingStats').textContent = '';
            $('holdingSub').textContent = 'Loading…';
            $('holdingChart').innerHTML = '';
            ['holdingTiles', 'holdingFacts', 'holdingAbout', 'holdingTrades', 'holdingRanges'].forEach((id) => { $(id).innerHTML = ''; });
        }
        let data;
        try {
            data = await api(`/holding?ticker=${encodeURIComponent(ticker)}`);
        } catch (error) {
            if (error instanceof ForbiddenError) {
                showSignedOut();
                return;
            }
            if (holding.ticker === ticker) $('holdingSub').textContent = error.message;
            return;
        }
        if (holding.ticker !== ticker) return; // opened another meanwhile
        holding.data = data;
        if (currentTab() === 'holding') renderHolding();
        if (data.pending && holding.retries < MAX_HISTORY_RETRIES) {
            holding.retries += 1;
            holding.timer = setTimeout(() => loadHolding(ticker, true), (data.retryAfter || 3) * 1000);
        }
    }

    function factRow(label, value) {
        return value == null || value === '' || value === '—' ? '' : `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    }
    function bigMoney(value) {
        if (value == null) return null;
        const abs = Math.abs(value);
        if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
        if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
        if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
        return fmtMoney(value, true);
    }

    function renderHolding() {
        const d = holding.data;
        const pos = d.position;
        const tag = ASSET_TAGS[d.asset] ? ` · ${ASSET_TAGS[d.asset]}` : '';
        $('holdingName').textContent = `${d.ticker}${d.name && d.name !== d.ticker ? ` · ${d.name}` : ''}${tag}`;
        $('holdingPrice').textContent = fmtMoney(d.price);
        const stats = [];
        if (d.dayChange != null) {
            const when = d.priceAsOf === today() ? 'today' : `on ${shortDate.format(new Date(`${d.priceAsOf}T00:00:00Z`))}`;
            stats.push(`<span class="${tone(d.dayChange)}">${fmtSigned(d.dayChange, true)} (${fmtPct(d.dayChangePct, true)})</span> ${when} on your shares`);
        }
        if (d.priceAsOf) stats.push(`${d.priceStatus === 'trade' ? 'last trade' : 'close'} ${fmtDay(d.priceAsOf)}`);
        if (!d.open) stats.push('position closed');
        $('holdingStats').innerHTML = stats.map((text) => `<span class="pf-stat">${text}</span>`).join(' <span class="pf-dot" aria-hidden="true">·</span> ');

        // Price chart.
        holding.range = renderRanges(d.closes, $('holdingRanges'), holding.range);
        const points = pointsInRange(d.closes, holding.range);
        const sub = $('holdingSub');
        if (points.length < 2) {
            sub.textContent = d.pending ? 'Loading price history…' : d.asset === 'other' ? 'No market price for this one; it’s valued at your last trade.' : 'No price history yet.';
            $('holdingLegend').hidden = true;
            $('holdingChart').innerHTML = '';
        } else {
            const first = points[0].close;
            const change = points[points.length - 1].close - first;
            sub.innerHTML = `<span class="pf-history-change ${tone(change)}">${fmtSigned(change)} (${fmtPct(change / first, true)})</span> a share since ${fmtDay(points[0].date)}`;
            const avg = d.open ? pos.avgCost : null;
            const trades = d.trades.filter((t) => t.date >= points[0].date);
            $('holdingLegend').hidden = false;
            $('avgCostKey').hidden = avg == null;
            $('tradeKeys').hidden = !trades.length;
            drawPriceChart(points, avg, trades);
        }
        const notes = [];
        if (d.pending) notes.push('Older prices are still loading; the chart fills in as they arrive.');
        if (d.trades.some((t) => t.price && points.length && t.date >= points[0].date)) notes.push('Dots mark your trades at the price you paid or got.');
        if (d.sampleData) notes.push('Generated sample prices, not real history.');
        $('holdingNote').textContent = notes.join(' ');
        $('holdingNote').hidden = !notes.length;

        // The position.
        $('holdingTiles').innerHTML = (d.open ? [
            gainTile('Value', fmtMoney(pos.marketValue, true), `${shareFormat.format(pos.shares)} shares`),
            gainTile('Unrealized', fmtSigned(pos.gain, true), pos.gainPct == null ? 'No cost basis' : `${fmtPct(pos.gainPct, true)} on ${fmtMoney(pos.costBasis, true)}`, tone(pos.gain)),
            gainTile('Average cost', fmtMoney(pos.avgCost), 'A share, across every account'),
            gainTile('Realized', fmtSigned(pos.realizedGain, true), 'From your sells', tone(pos.realizedGain)),
        ] : [
            gainTile('Realized', fmtSigned(pos.realizedGain, true), 'At average cost', tone(pos.realizedGain)),
            gainTile('Bought', fmtMoney(pos.bought, true), plural(pos.trades, 'trade')),
            gainTile('Sold', fmtMoney(pos.sold, true), `Last ${fmtDay(pos.lastTrade)}`),
            gainTile('Held', fmtMonth(pos.firstTrade), `to ${fmtMonth(pos.lastTrade)}`),
        ]).join('');

        // Key data: the price's own, then the company's if the research page has it.
        const perf = d.performance;
        const c = d.company || {};
        const pctFact = (v) => (v == null ? null : `<span class="${tone(v)}">${fmtPct(v, true)}</span>`);
        $('holdingFacts').innerHTML = [
            factRow('1 month', pctFact(perf['1M'])),
            factRow('Year to date', pctFact(perf.YTD)),
            factRow('1 year', pctFact(perf['1Y'])),
            factRow('52-week range', perf.low52w != null ? `${fmtMoney(perf.low52w)} – ${fmtMoney(perf.high52w)}` : null),
            factRow('Market cap', bigMoney(c.market_cap)),
            factRow('P/E', c.pe_ratio != null ? c.pe_ratio.toFixed(1) : null),
            factRow('Beta', c.beta != null ? c.beta.toFixed(2) : null),
            // Stored in percent, as the research page shows it.
            factRow('Profit margin', c.profit_margin != null ? fmtPct(c.profit_margin / 100) : null),
            factRow('Revenue growth', c.revenue_growth != null ? pctFact(c.revenue_growth / 100) : null),
            factRow('Next earnings', c.next_earnings_date ? fmtDay(c.next_earnings_date) : null),
            factRow('First bought', fmtDay(pos.firstTrade)),
            factRow('Trades', countFormat.format(pos.trades)),
        ].join('');
        $('holdingFactsSub').textContent = d.priceAsOf ? `Price moves from daily closes through ${fmtDay(d.priceAsOf)}.` : '';

        const research = $('holdingResearch');
        research.hidden = d.asset !== 'stock';
        research.href = `/stock-research/?ticker=${encodeURIComponent(d.ticker)}`;
        const meta = [...new Set([c.sector, c.industry, c.headquarters, c.employees ? `${countFormat.format(c.employees)} employees` : null].filter(Boolean))];
        $('holdingAbout').innerHTML = d.asset !== 'stock'
            ? `<p>${d.asset === 'crypto' ? `${escapeHtml(d.name || d.ticker)} is a cryptocurrency, priced in US dollars.` : 'A security without a ticker (an option, say), so there’s no market data for it.'}</p>`
            : d.company
                ? `${meta.length ? `<p class="pf-about__meta">${meta.map(escapeHtml).join(' · ')}</p>` : ''}
                   <p>${escapeHtml(c.description || 'No description on file.')}</p>
                   ${c.website ? `<p><a class="pf-link" href="${escapeHtml(c.website)}" rel="noopener" target="_blank">${escapeHtml(c.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></p>` : ''}`
                : '<p>Company details load once this stock has been looked up in Stock Research. Open the full research page to fetch them.</p>';

        // Trades, newest first.
        $('holdingTradesSub').textContent = `${plural(d.trades.length, 'trade')}, in today’s shares where a split changed them.`;
        $('holdingTrades').innerHTML = [...d.trades].reverse().map((t) => `
            <tr>
                <td>${fmtDay(t.date)}</td>
                <td><span class="pf-side pf-side--${t.side}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                <td class="num">${shareFormat.format(t.shares)}</td>
                <td class="num">${fmtMoney(t.price)}</td>
                <td class="num pf-hide-sm">${fmtMoney(t.shares * t.price, true)}</td>
                <td class="num ${tone(t.realized)}">${t.side === 'sell' ? fmtSigned(t.realized, true) : ''}</td>
                <td class="pf-hide-md pf-muted">${escapeHtml(t.account || t.source || '')}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="pf-muted">No trades.</td></tr>';
    }

    function drawPriceChart(points, avgCost, trades) {
        const host = $('holdingChart');
        host.innerHTML = '';
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (!width) return;
        const pad = { top: 10, right: 8, bottom: 24, left: 52 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;

        const cost = showCost ? avgCost : null;
        const values = points.map((p) => p.close).concat(cost != null ? [cost] : [], trades.map((t) => t.price).filter((v) => v > 0));
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
        // A trade sits on the first close on or after its date.
        const indexOf = (iso) => {
            const i = points.findIndex((p) => p.date >= iso);
            return i === -1 ? points.length - 1 : i;
        };

        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Daily closing price from ${points[0].date} to ${points[points.length - 1].date}` });
        ticks.forEach((t) => {
            root.appendChild(svg('line', { class: 'pf-chart__grid', x1: pad.left, x2: width - pad.right, y1: y(t), y2: y(t) }));
            const label = svg('text', { class: 'pf-chart__axis', x: pad.left - 8, y: y(t) + 4, 'text-anchor': 'end' });
            label.textContent = hi - lo < 20 ? `$${t.toFixed(2)}` : compactMoney(t);
            root.appendChild(label);
        });
        dateLabels(root, points, x, innerW, height);
        const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join('');
        root.appendChild(svg('path', { class: 'pf-chart__area', d: `${line}L${x(points.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z` }));
        if (cost != null) {
            root.appendChild(svg('line', { class: 'pf-chart__avg', x1: pad.left, x2: width - pad.right, y1: y(cost), y2: y(cost) }));
        }
        root.appendChild(svg('path', { class: 'pf-chart__line', d: line }));
        const byDay = new Map();
        trades.forEach((t) => {
            const i = indexOf(t.date);
            if (!byDay.has(i)) byDay.set(i, []);
            byDay.get(i).push(t);
            if (t.price > 0) root.appendChild(svg('circle', { class: `pf-chart__trade--${t.side}`, cx: x(i), cy: y(t.price), r: trades.length > 80 ? 3 : 4.5 }));
        });

        const cross = svg('line', { class: 'pf-chart__cross', y1: pad.top, y2: pad.top + innerH, visibility: 'hidden' });
        const dot = svg('circle', { class: 'pf-chart__dot', r: 4.5, visibility: 'hidden' });
        root.appendChild(cross);
        root.appendChild(dot);
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
            dot.setAttribute('cy', y(p.close));
            cross.setAttribute('visibility', 'visible');
            dot.setAttribute('visibility', 'visible');
            const parts = [fmtDay(p.date), fmtMoney(p.close)];
            (byDay.get(i) || []).forEach((t) => parts.push(`${t.side === 'buy' ? 'bought' : 'sold'} ${shareFormat.format(t.shares)} at ${fmtMoney(t.price)}`));
            showTip(event, parts.join(' · '));
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

    $('holdingRanges').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-range]');
        if (!button || !holding.data) return;
        holding.range = button.dataset.range;
        renderHolding();
    });

    $('historyRanges').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-range]');
        if (!button || !history.data) return;
        history.range = button.dataset.range;
        renderHistory();
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (history.data && !els.dashboard.hidden && currentTab() === 'overview') renderHistory();
            if (holding.data && currentTab() === 'holding') renderHolding();
        }, 120);
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
        if (file.size > 5_000_000) {
            showError('That file is too large. Keep it under 5 MB.');
            return;
        }
        fileText = await file.text();
        els.fileName.textContent = file.name;
    }

    async function upload(csv) {
        const body = { csv, kind: selectedKind(), replace: els.replaceInput.checked };
        if (els.asOfInput.value) body.as_of = els.asOfInput.value;
        els.uploadButton.disabled = true;
        els.uploadButton.textContent = 'Uploading…';
        const result = await run(() => api('/import', { method: 'POST', body }));
        els.uploadButton.disabled = false;
        els.uploadButton.textContent = 'Upload';
        if (!result) return;

        const { kind, count, duplicates, removedSample } = result.imported;
        const what = kind === 'holdings' ? plural(count, 'holding') : plural(count, 'trade');
        const parts = [`Imported ${what}.`];
        if (duplicates) parts.push(`${plural(duplicates, 'row')} ${duplicates === 1 ? 'was' : 'were'} already saved.`);
        if (removedSample) parts.push(`Removed the ${countFormat.format(removedSample)} sample trades.`);
        if (result.skipped.length) {
            parts.push(`Skipped ${plural(result.skipped.length, 'row')}: ${summarizeSkipped(result.skipped)}.`);
        }
        showNotice(parts.join(' '));
        fileText = null;
        els.fileInput.value = '';
        els.pasteInput.value = '';
        els.replaceInput.checked = false;
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
                account: $('addAccount').value.trim() || null,
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
