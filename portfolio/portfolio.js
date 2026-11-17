// My Portfolio: a member's own holdings and trades, broken down.
// Every byte comes from /api/stocks/portfolio, which answers anonymous
// callers with a JSON 403; the page turns that into its sign-in panel.
//
// The tabs share one breakdown from the server; the Watchlist tab has its own
// endpoint, and Performance also reads the value history. The trade list is the exception: a history can
// run to thousands of trades, so the Activity tab asks for one filtered page
// at a time.
(function () {
    const API_BASE = window.API_ORIGIN || '';
    // Rows in the allocation list by holding; the rest fold into "Other".
    const ALLOCATION_ROWS = 8;
    // Prices still loading on the server: it fetches a few per request, and
    // pauses when the provider's per-minute allowance runs out. Its
    // `retryAfter` says when to ask again.
    const MAX_PENDING_RETRIES = 30;
    const TOP_HOLDINGS = 10;
    const TRADES_PER_PAGE = 50;
    const REALIZED_SHOWN = 12;
    const PAGE_TITLES = {
        overview: 'Overview', holdings: 'Holdings', gains: 'Analysis', income: 'Analysis',
        taxes: 'Analysis', watchlist: 'Watchlist', activity: 'Activity', accounts: 'Activity',
    };
    // Which section's nav item a tab lights up, and the sub-tabs it shares.
    const SECTION_OF = { income: 'gains', taxes: 'gains', accounts: 'activity', watchlist: 'research' };
    const SUBTABS = {
        gains: [['gains', 'Performance'], ['income', 'Income'], ['taxes', 'Taxes']],
        activity: [['activity', 'Trades'], ['accounts', 'Accounts']],
    };
    const TABS = ['overview', 'holdings', 'gains', 'income', 'taxes', 'watchlist', 'activity', 'accounts'];
    // A position past this share of the portfolio is flagged.
    const CONCENTRATED = 0.25;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    // [days ago, ticker, amount]
    const SAMPLE_DIVIDENDS = [
        [280, 'AAPL', 5.0], [190, 'AAPL', 8.75], [100, 'AAPL', 8.75], [10, 'AAPL', 8.75],
        [250, 'JPM', 18.75], [160, 'JPM', 18.75], [70, 'JPM', 15.0],
        [260, 'MSFT', 6.64], [170, 'MSFT', 6.64], [80, 'MSFT', 11.62],
        [110, 'XOM', 29.7], [20, 'XOM', 29.7],
    ];

    function sampleCsv() {
        const dayAgo = (daysAgo) => {
            const day = new Date();
            day.setDate(day.getDate() - daysAgo);
            // Markets are shut at weekends; move back to the Friday.
            while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1);
            return isoDay(day);
        };
        const rows = SAMPLE_TRADES.map(([daysAgo, action, ticker, shares, price]) => `${dayAgo(daysAgo)},${action},${ticker},${shares},${price},,Sample`);
        const dividends = SAMPLE_DIVIDENDS.map(([daysAgo, ticker, amount]) => `${dayAgo(daysAgo)},Qualified Dividend,${ticker},,,${amount},Sample`);
        return ['Date,Action,Symbol,Quantity,Price,Amount,Source', ...rows, ...dividends].join('\n');
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
        sectorCard: $('sectorCard'),
        sectorBars: $('sectorBars'),
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

    // Privacy mode masks what says how much you hold (values, gains, share
    // counts) and leaves percents and market prices; remembered per browser.
    let privacy = false;
    try { privacy = localStorage.getItem('pf.privacy') === 'true'; } catch { /* storage blocked */ }
    const MASK = '•••';

    function fmtPrice(value, whole = false) {
        if (value == null) return '—';
        return (whole ? moneyWhole : money).format(value);
    }
    function fmtMoney(value, whole = false) {
        if (value != null && privacy) return MASK;
        return fmtPrice(value, whole);
    }
    function fmtShares(value) {
        return privacy ? MASK : shareFormat.format(value);
    }
    function fmtSigned(value, whole = false) {
        if (value == null) return '—';
        if (privacy) return MASK;
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
    const ASSET_TAGS = { other: 'No ticker' };
    const SIDE_LABELS = { buy: 'Buy', sell: 'Sell', dividend: 'Dividend' };
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
    let noticeTimer = null;
    function showNotice(message) {
        clearTimeout(noticeTimer);
        els.noticeBanner.classList.remove('is-fading');
        els.noticeBanner.textContent = message;
        els.noticeBanner.hidden = !message;
        if (!message) return;
        noticeTimer = setTimeout(() => {
            els.noticeBanner.classList.add('is-fading');
            noticeTimer = setTimeout(() => { els.noticeBanner.hidden = true; }, 400);
        }, 6000);
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
        const shown = SECTION_OF[tab === 'holding' ? listTab : tab] || (tab === 'holding' ? listTab : tab);
        renderSubtabs(tab);
        $('pageTitle').textContent = tab === 'holding' ? holdingTicker() : PAGE_TITLES[tab];
        document.title = `${$('pageTitle').textContent} — Portfolio`;
        els.tabs.querySelectorAll('a[data-tab]').forEach((link) => {
            if (link.dataset.tab === shown) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        document.querySelectorAll('.pf-panel').forEach((panel) => {
            panel.hidden = panel.dataset.panel !== tab;
        });
        // The chart measures its box, so draw it once its tab is showing.
        if (tab === 'overview' && history.data) renderHistory();
        if (tab === 'gains' && lastData) renderGainCharts();
        if (tab === 'watchlist') loadWatchlist();
        if (tab === 'activity' && lastData) loadTrades();
        if (tab === 'holding') {
            const back = $('holdingBack');
            back.href = `#${listTab}`;
            back.textContent = `← ${listTab[0].toUpperCase()}${listTab.slice(1)}`;
            if (holding.ticker !== holdingTicker()) window.scrollTo(0, 0);
            loadHolding(holdingTicker());
        }
    }
    function renderSubtabs(tab) {
        const bar = $('subtabs');
        const tabs = SUBTABS[SECTION_OF[tab] || tab];
        bar.hidden = !tabs;
        if (!tabs) return;
        bar.innerHTML = tabs
            .map(([key, label]) => `<a href="#${key}"${key === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('');
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
        renderMetrics(data);
        renderToday(data);
        renderUpcoming(data);
        renderTopHoldings(data);
        renderSectors(data);
        renderHoldings(data);
        renderClosed(data);
        renderSplits(data);
        renderFilters(data);
        renderAccounts(data);
        renderGains(data);
        renderIncome(data);
        renderTaxes(data);
        maybeLoadHistory(data);
        els.clearHoldingsButton.hidden = !data.holdings.count;
        showTab();
        schedulePendingRetry(data);
    }

    // Private, the hero shows the range's return instead (set with the chart).
    // Roll a figure from what it last showed to its new value. `settle` puts
    // the final text in at once: before a scrub, or where nothing animates.
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    function settle(el) {
        cancelAnimationFrame(el.rolling);
        clearTimeout(el.rollEnd);
        if (el.rollText != null) el.textContent = el.rollText;
    }
    function rollTo(el, value, format) {
        const from = el.rolled ?? 0;
        el.rolled = value;
        el.rollText = format(value);
        cancelAnimationFrame(el.rolling);
        clearTimeout(el.rollEnd);
        if (calm.matches || document.hidden || from === value) { el.textContent = el.rollText; return; }
        const began = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - began) / 700);
            el.textContent = format(from + (value - from) * (1 - (1 - t) ** 3));
            if (t < 1) el.rolling = requestAnimationFrame(step);
        };
        el.rolling = requestAnimationFrame(step);
        // A tab that isn't painting gets no frames: land on the figure anyway.
        el.rollEnd = setTimeout(() => settle(el), 900);
    }
    function showFigure(el, text) {
        settle(el);
        el.rolled = null;
        el.rollText = text;
        el.textContent = text;
    }

    // While a chart is being scrubbed its headline shows the day under the
    // cursor; leaving puts back what was there.
    function scrubber(valueEl, subEl) {
        let saved = null;
        return {
            show(value, valueClass, subHtml) {
                if (!saved) {
                    settle(valueEl);
                    saved = { text: valueEl.textContent, cls: valueEl.className, sub: subEl.innerHTML };
                }
                valueEl.textContent = value;
                if (valueClass != null) valueEl.className = valueClass;
                subEl.innerHTML = subHtml;
            },
            clear() {
                if (!saved) return;
                valueEl.textContent = saved.text;
                valueEl.className = saved.cls;
                subEl.innerHTML = saved.sub;
                saved = null;
            },
        };
    }

    // A chart draws its line in when what it shows changes, not on a resize.
    function markFresh(host, root, key) {
        root.classList.toggle('is-fresh', host.dataset.drawn !== key);
        host.dataset.drawn = key;
    }

    function renderHero(data) {
        $('heroLabel').textContent = privacy ? 'Return' : 'Total value';
        els.heroValue.className = 'pf-hero__value';
        if (privacy) showFigure(els.heroValue, '—');
        else rollTo(els.heroValue, data.totals.marketValue, (v) => fmtMoney(v, true));
    }

    function metric(label, value, valueClass = '') {
        return `<div><dt>${label}</dt><dd class="${valueClass}">${value}</dd></div>`;
    }

    // Everything the portfolio has made: what's held, what's been sold, and
    // the dividends paid along the way.
    function totalReturn(data) {
        return (data.totals.gain || 0) + (data.totals.realizedGain || 0) + (data.dividends.total || 0);
    }

    // The statement's lead figures, under the total.
    function renderMetrics(data) {
        const t = data.totals;
        const items = [];
        const withPct = (amount, pct) => (privacy ? fmtPct(pct, true) : `${fmtSigned(amount, true)}<span class="pf-sub">${fmtPct(pct, true)}</span>`);
        if (t.gain != null) items.push(metric('Unrealized', withPct(t.gain, t.gainPct), tone(t.gain)));
        if (!privacy && (t.gain != null || t.realizedGain != null || data.dividends.count)) {
            const total = totalReturn(data);
            items.push(metric('Total return', fmtSigned(total, true), tone(total)));
        }
        if (!privacy && t.costBasis) items.push(metric('Cost basis', fmtMoney(t.costBasis, true)));
        const d = data.dividends;
        if (d.count) {
            items.push(metric('Income, 12 mo', privacy ? `${fmtPct(d.yield)} yield` : `${fmtMoney(d.trailing12m, true)}<span class="pf-sub">${fmtPct(d.yield)}</span>`));
        }
        $('heroMetrics').innerHTML = items.join('');
    }

    // The day's change and what moved it most.
    // The movers rank by percent or by dollars; with amounts hidden, by percent.
    let moverMode = 'percent';
    try { if (localStorage.getItem('pf.movers') === 'value') moverMode = 'value'; } catch { /* storage blocked */ }
    function renderToday(data) {
        const t = data.totals;
        const key = moverMode === 'value' && !privacy ? 'dayChange' : 'dayChangePct';
        const movers = data.positions.filter((p) => p[key] != null)
            .sort((a, b) => Math.abs(b[key]) - Math.abs(a[key])).slice(0, 5);
        $('moverModes').hidden = privacy;
        $('moverModes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === moverMode)));
        $('todayCard').hidden = t.dayChange == null;
        if (t.dayChange == null) return;
        const asOf = data.positions.map((p) => p.priceAsOf).filter(Boolean).sort().pop();
        $('todaySub').textContent = asOf ? `Close of ${fmtDay(asOf)}` : '';
        $('todayChange').innerHTML = privacy
            ? `<p class="pf-today ${tone(t.dayChange)}">${fmtPct(t.dayChangePct, true)}</p>`
            : `<p class="pf-today ${tone(t.dayChange)}">${fmtSigned(t.dayChange, true)}</p><p class="pf-sub ${tone(t.dayChange)}">${fmtPct(t.dayChangePct, true)}</p>`;
        $('todayCard').classList.toggle('is-up', t.dayChange > 0);
        $('todayCard').classList.toggle('is-down', t.dayChange < 0);
        const widest = Math.max(...movers.map((p) => Math.abs(p[key])), 0) || 1;
        $('moversBody').innerHTML = movers.map((p) => `
            <tr data-ticker="${escapeHtml(p.ticker)}">
                <td><span class="pf-sec">${badge(p.ticker)}${securityLink(p)}</span></td>
                <td class="pf-mover"><span class="pf-mover__bar ${tone(p.dayChange)}" style="width:${(Math.abs(p[key]) / widest * 100).toFixed(0)}%"></span></td>
                ${dayPill(p)}
            </tr>`).join('');
    }

    $('moverModes').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-mode]');
        if (!button || !lastData) return;
        moverMode = button.dataset.mode;
        try { localStorage.setItem('pf.movers', moverMode); } catch { /* storage blocked */ }
        renderToday(lastData);
    });

    // Earnings and ex-dividend dates for what you hold: asked for again only
    // when the set of holdings changes.
    const upcoming = { key: null, events: [] };
    const eventDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const UPCOMING_ROWS = 6;
    function renderUpcoming(data) {
        const key = data.positions.map((p) => p.ticker).sort().join(',');
        if (key !== upcoming.key) {
            upcoming.key = key;
            upcoming.events = [];
            api('/upcoming').then((r) => {
                if (upcoming.key !== key) return;
                upcoming.events = r.events || [];
                drawUpcoming();
                drawIncomeUpcoming();
            }).catch(() => {});
        }
        drawUpcoming();
    }
    function drawUpcoming() {
        // A dividend already gone ex waits on the Income tab for its pay day.
        const events = upcoming.events.filter((e) => e.kind !== 'dividend' || e.date >= today()).slice(0, UPCOMING_ROWS);
        $('upcoming').hidden = !events.length;
        const what = (e) => {
            if (e.kind === 'earnings') return `Earnings${e.hour === 'bmo' ? ' · before open' : e.hour === 'amc' ? ' · after close' : ''}`;
            if (e.amount == null) return 'Ex-dividend';
            return `Ex-dividend · ${privacy || e.total == null ? `${fmtPrice(e.amount)}/sh` : fmtMoney(e.total)}`;
        };
        $('upcomingList').innerHTML = events.map((e) => `
            <li>
                <span class="pf-upcoming__date">${eventDay.format(new Date(`${e.date}T00:00:00Z`))}</span>
                <a class="pf-ticker" href="${holdingHref(e.ticker)}">${escapeHtml(e.ticker)}</a>
                <span class="pf-upcoming__what">${escapeHtml(what(e))}</span>
            </li>`).join('');
    }

    function allocationSlices(positions) {
        const priced = positions.filter((p) => p.marketValue != null && p.marketValue > 0);
        const slices = priced.slice(0, ALLOCATION_ROWS).map((p) => ({
            label: p.ticker, value: p.marketValue, weight: p.weight,
        }));
        const rest = priced.slice(ALLOCATION_ROWS);
        if (rest.length) {
            slices.push({
                label: `Other (${rest.length})`,
                value: rest.reduce((sum, p) => sum + p.marketValue, 0),
                weight: rest.reduce((sum, p) => sum + (p.weight || 0), 0),
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

    function knownSectors(data) {
        return data.sectors.filter((s) => s.sector !== 'Unclassified');
    }

    // Allocation as ruled rows, by sector or by holding.
    let allocationMode = 'sector';
    function allocationGroups(data) {
        if (allocationMode === 'holding') return allocationSlices(data.positions);
        return data.sectors.filter((s) => s.marketValue > 0)
            .map((s) => ({ label: s.sector, value: s.marketValue, weight: s.weight }));
    }

    // The ring's centre names the slice under the cursor, or the largest.
    let donutGroups = [];
    function focusSlice(index) {
        const g = donutGroups[index ?? 0];
        if (!g || !$('donutFigure')) return;
        $('donutFigure').textContent = fmtPct(g.weight);
        $('donutLabel').textContent = g.label.length > 16 ? `${g.label.slice(0, 15)}…` : g.label;
        els.sectorCard.classList.toggle('is-focused', index != null);
        els.sectorCard.querySelectorAll('[data-slice]').forEach((node) => node.classList.toggle('is-on', index != null && Number(node.dataset.slice) === index));
    }
    els.sectorCard.addEventListener('mouseover', (event) => {
        const node = event.target.closest('[data-slice]');
        focusSlice(node ? Number(node.dataset.slice) : null);
    });
    els.sectorCard.addEventListener('mouseleave', () => focusSlice(null));

    function renderSectors(data) {
        if (!knownSectors(data).length) allocationMode = 'holding';
        $('allocationModes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === allocationMode)));
        const groups = allocationGroups(data);
        els.sectorCard.hidden = !groups.length;
        // A ring of the groups, largest first from twelve o'clock, and its key.
        const R = 52;
        const around = 2 * Math.PI * R;
        const total = groups.reduce((sum, g) => sum + (g.weight || 0), 0) || 1;
        let turned = 0;
        const arcs = groups.map((g, i) => {
            const share = (g.weight || 0) / total;
            // A hair of gap between slices, when there's more than one.
            const length = Math.max(share * around - (groups.length > 1 ? 2 : 0), 0.5);
            const arc = `<circle class="pf-donut__arc pf-slice--${Math.min(i, 8)}" data-slice="${i}" cx="70" cy="70" r="${R}" style="--len:${length.toFixed(2)};--rest:${(around - length).toFixed(2)};--around:${around.toFixed(2)};--i:${i}" stroke-dasharray="${length.toFixed(2)} ${(around - length).toFixed(2)}" stroke-dashoffset="${(-turned * around).toFixed(2)}"><title>${escapeHtml(g.label)} ${fmtPct(g.weight)}</title></circle>`;
            turned += share;
            return arc;
        }).join('');
        const lead = groups[0];
        $('sectorDonut').innerHTML = lead ? `
            <svg viewBox="0 0 140 140" role="img" aria-label="Allocation by ${allocationMode}">
                <g transform="rotate(-90 70 70)">${arcs}</g>
                <text class="pf-donut__figure" id="donutFigure" x="70" y="70" text-anchor="middle"></text>
                <text class="pf-donut__label" id="donutLabel" x="70" y="87" text-anchor="middle"></text>
            </svg>` : '';
        donutGroups = groups;
        focusSlice(null);
        els.sectorBars.innerHTML = groups.map((g, i) => `
            <li data-slice="${i}">
                <span class="pf-alloc__name"><i class="pf-alloc__dot pf-slice--${Math.min(i, 8)}"></i>${escapeHtml(g.label)}</span>
                <span class="pf-alloc__value">${fmtPct(g.weight)}${privacy ? '' : `<em>${fmtMoney(g.value, true)}</em>`}</span>
            </li>`).join('');
    }
    $('allocationModes').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-mode]');
        if (!button || !lastData) return;
        allocationMode = button.dataset.mode;
        renderSectors(lastData);
    });

    function priceCell(p) {
        if (p.price == null) {
            const label = p.priceStatus === 'pending' ? 'Loading…' : 'Unavailable';
            return `<span class="pf-muted">${label}</span>`;
        }
        const note = p.priceStatus === 'stale' ? `<span class="pf-sub">close ${fmtDay(p.priceAsOf)}</span>`
            : p.priceStatus === 'trade' ? '<span class="pf-sub">last trade</span>' : '';
        return `${fmtPrice(p.price)}${note}`;
    }

    // A round monogram for a security, its tint fixed by the ticker.
    function badge(ticker) {
        let hash = 0;
        for (const ch of ticker) hash = (hash * 131 + ch.charCodeAt(0)) % 997;
        return `<span class="pf-badge pf-badge--${hash % 8}" aria-hidden="true">${escapeHtml(ticker.slice(0, 2).toUpperCase())}</span>`;
    }

    function securityCell(p) {
        return `<span class="pf-sec">${badge(p.ticker)}<span class="pf-sec__text">${securityLink(p)}${p.name && p.name !== p.ticker ? `<span class="pf-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>` : ''}</span></span>`;
    }

    function gainCell(p, extra = '') {
        if (privacy) return `<td class="num ${extra} ${tone(p.gain)}">${fmtPct(p.gainPct, true)}</td>`;
        return `<td class="num ${extra} ${tone(p.gain)}">${fmtSigned(p.gain, true)}${p.gainPct != null ? `<span class="pf-sub ${tone(p.gain)}">${fmtPct(p.gainPct, true)}</span>` : ''}</td>`;
    }

    // The last month of closes as a small line, green if it ended higher.
    function sparkCell(p, extra = '') {
        const closes = p.spark || [];
        if (closes.length < 2) return `<td class="num ${extra}"></td>`;
        const lo = Math.min(...closes);
        const span = Math.max(...closes) - lo || 1;
        const d = closes.map((c, i) => `${i ? 'L' : 'M'}${((i / (closes.length - 1)) * 72).toFixed(1)},${(22 - ((c - lo) / span) * 20).toFixed(1)}`).join('');
        const up = closes[closes.length - 1] >= closes[0];
        return `<td class="num ${extra}"><svg class="pf-spark ${up ? 'is-up' : 'is-down'}" viewBox="0 0 72 24" aria-hidden="true"><path class="pf-spark__fill" d="${d}L72,24L0,24Z"/><path class="pf-spark__line" pathLength="1" d="${d}"/></svg></td>`;
    }

    // The latest day's move, against the close before it.
    function dayCell(p) {
        if (p.dayChange == null) return '<td class="num pf-muted">—</td>';
        if (privacy) return `<td class="num ${tone(p.dayChange)}">${fmtPct(p.dayChangePct, true)}</td>`;
        return `<td class="num ${tone(p.dayChange)}">${fmtSigned(p.dayChange, true)}<span class="pf-sub ${tone(p.dayChange)}">${fmtPct(p.dayChangePct, true)}</span></td>`;
    }
    // The same, as a green or red pill: the day's dollars, percent under it.
    function dayPill(p) {
        if (p.dayChange == null) return '<td class="num pf-muted">—</td>';
        const t = tone(p.dayChange);
        const pill = `<span class="pf-day ${t ? `pf-day--${t === 'is-gain' ? 'up' : 'down'}` : ''}">`;
        if (privacy) return `<td class="num">${pill}${fmtPct(p.dayChangePct, true)}</span></td>`;
        return `<td class="num">${pill}${fmtSigned(p.dayChange, true)}</span><span class="pf-sub ${t}">${fmtPct(p.dayChangePct, true)}</span></td>`;
    }

    function renderTopHoldings(data) {
        const top = data.positions.slice(0, TOP_HOLDINGS);
        els.topHoldingsSub.textContent = data.positions.length > TOP_HOLDINGS
            ? `Top ${TOP_HOLDINGS} of ${data.positions.length}`
            : plural(data.positions.length, 'open position');
        els.allHoldingsLink.textContent = data.totals.closedPositions
            ? `All holdings and ${data.totals.closedPositions} closed`
            : 'All holdings';
        els.topHoldingsBody.innerHTML = top.map((p) => `
            <tr data-ticker="${escapeHtml(p.ticker)}">
                <td>${securityCell(p)}</td>
                ${weightCell(p)}
                <td class="num pf-strong">${fmtMoney(p.marketValue, true)}</td>
                ${dayCell(p)}
                ${gainCell(p, 'pf-hide-sm')}
                ${sparkCell(p, 'pf-hide-md')}
            </tr>`).join('') || '<tr><td colspan="6" class="pf-muted">No open positions.</td></tr>';
    }

    // The holdings table's sort: none (by value, as served) until a header is
    // clicked; text sorts A to Z first, numbers largest first.
    const sort = { key: null, dir: -1 };
    function sortedPositions(list) {
        if (!sort.key) return list;
        return [...list].sort((a, b) => {
            const av = a[sort.key];
            const bv = b[sort.key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sort.dir;
        });
    }
    document.querySelector('#holdingsTable thead').addEventListener('click', (event) => {
        const th = event.target.closest('th[data-sort]');
        if (!th || !lastData) return;
        const key = th.dataset.sort;
        const text = key === 'ticker' || key === 'firstTrade';
        if (sort.key === key) sort.dir = -sort.dir;
        else { sort.key = key; sort.dir = text ? 1 : -1; }
        renderHoldings(lastData);
    });
    function weightCell(p, extra = '') {
        const flag = p.weight > CONCENTRATED ? '<span class="pf-flag" title="Over 25% of the portfolio"></span>' : '';
        return `<td class="num pf-strong ${extra}">${flag}${p.weight == null ? '—' : fmtPct(p.weight)}</td>`;
    }

    function renderHoldings(data) {
        const asOf = data.holdings.asOf;
        els.holdingsSub.textContent = `${plural(data.positions.length, 'position')}${asOf ? ` · As of ${fmtDay(asOf)}` : ''}`;
        document.querySelectorAll('#holdingsTable th[data-sort]').forEach((th) => {
            if (th.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
            else th.removeAttribute('aria-sort');
        });
        els.holdingsBody.innerHTML = sortedPositions(data.positions).map((p) => `
            <tr data-ticker="${escapeHtml(p.ticker)}">
                <td>${securityCell(p)}</td>
                ${weightCell(p, 'pf-hide-sm')}
                <td class="num pf-strong">${fmtMoney(p.marketValue, true)}</td>
                ${dayCell(p)}
                ${sparkCell(p, 'pf-hide-md')}
                <td class="num pf-hide-sm">${fmtShares(p.shares)}</td>
                <td class="num pf-hide-sm">${priceCell(p)}</td>
                <td class="num pf-hide-sm">${fmtMoney(p.costBasis, true)}${p.avgCost != null ? `<span class="pf-sub">${fmtPrice(p.avgCost)}/sh</span>` : ''}</td>
                ${gainCell(p)}
                <td class="num pf-hide-md ${tone(p.realizedGain)}">${fmtSigned(p.realizedGain, true)}</td>
                <td class="num pf-hide-md">${fmtMonth(p.firstTrade)}<span class="pf-sub">${plural(p.trades, 'trade')}</span></td>
            </tr>`).join('') || '<tr><td colspan="11" class="pf-muted">No open positions.</td></tr>';

        const t = data.totals;
        const realized = data.positions.reduce((sum, p) => sum + (p.realizedGain || 0), 0);
        $('holdingsTotals').innerHTML = data.positions.length > 1 ? `
            <tr>
                <td>Total</td>
                <td class="num pf-hide-sm">100%</td>
                <td class="num">${fmtMoney(t.marketValue, true)}</td>
                ${dayCell(t)}
                <td class="pf-hide-md"></td>
                <td class="pf-hide-sm"></td>
                <td class="pf-hide-sm"></td>
                <td class="num pf-hide-sm">${fmtMoney(t.costBasis, true)}</td>
                ${gainCell(t)}
                <td class="num pf-hide-md ${tone(realized)}">${data.positions.some((p) => p.realizedGain != null) ? fmtSigned(realized, true) : ''}</td>
                <td class="pf-hide-md"></td>
            </tr>` : '';
    }

    function renderClosed(data) {
        const closed = data.closedPositions;
        els.closedCard.hidden = !closed.length;
        const realized = closed.reduce((sum, c) => sum + (c.realizedGain || 0), 0);
        els.closedSub.innerHTML = `${plural(closed.length, 'position')} · <span class="${tone(realized)}">${fmtSigned(realized, true)}</span> realized`;
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
        if (tradesAdjusted) parts.push(`${plural(tradesAdjusted, 'trade')} adjusted`);
        if (alreadyAdjusted) parts.push(`${plural(alreadyAdjusted, 'trade')} already adjusted`);
        $('splitsSub').textContent = parts.join(' · ');
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
        // One source says nothing the account table doesn't already.
        $('sourcesCard').hidden = data.sources.length < 2;
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

    function gainTile(label, value, sub, valueClass = '', tileClass = '') {
        return `<div class="pf-tile ${tileClass}">
            <div class="pf-tile__label">${label}</div>
            <div class="pf-tile__value ${valueClass}">${value}</div>
            <div class="pf-tile__sub">${sub}</div>
        </div>`;
    }

    let showAllRealized = false;

    // Everything made, step by step: each source of gain stacked on the last.
    function renderBridge(data) {
        const t = data.totals;
        const steps = [];
        if (t.gain != null) steps.push(['Unrealized', t.gain]);
        steps.push(['Realized', t.realizedGain || 0]);
        if (data.dividends.count) steps.push(['Income', data.dividends.total || 0]);
        const total = totalReturn(data);
        let run = 0;
        const spans = steps.map(([label, v]) => {
            const from = run;
            run += v;
            return { label, v, from, to: run };
        });
        const ends = [0, total, ...spans.flatMap((s) => [s.from, s.to])];
        const lo = Math.min(...ends);
        const span = Math.max(...ends) - lo || 1;
        const bar = (a, b, cls) => `<span class="pf-bridge__bar ${cls}" style="left:${((Math.min(a, b) - lo) / span * 100).toFixed(2)}%;width:${Math.max(0.6, Math.abs(b - a) / span * 100).toFixed(2)}%"></span>`;
        $('bridge').innerHTML = spans.map((s) => `
            <div class="pf-bridge__row">
                <span class="pf-bridge__label">${s.label}</span>
                <span class="pf-bridge__track">${bar(s.from, s.to, s.v >= 0 ? 'is-gain' : 'is-loss')}</span>
                <span class="pf-bridge__value ${tone(s.v)}">${fmtSigned(s.v, true)}</span>
            </div>`).join('') + `
            <div class="pf-bridge__row pf-bridge__row--total">
                <span class="pf-bridge__label">Total</span>
                <span class="pf-bridge__track">${bar(0, total, 'is-total')}</span>
                <span class="pf-bridge__value ${tone(total)}">${fmtSigned(total, true)}</span>
            </div>`;
    }

    // Realized gain by year, a column each; a column opens that year's trades.
    function renderYears(data) {
        const years = [...data.years].reverse();
        const top = Math.max(...years.map((y) => Math.abs(y.realized || 0)), 1);
        $('yearCols').innerHTML = years.length ? years.map((y) => `
            <button type="button" class="pf-year" data-year="${y.year}">
                <span class="pf-year__col">
                    <span class="pf-year__value ${tone(y.realized)}">${privacy ? '' : y.realized ? compactMoney(y.realized).replace('$-', '−$') : '$0'}</span>
                    <span class="pf-year__bar ${y.realized < 0 ? 'is-loss' : 'is-gain'}" style="height:${Math.max(1, Math.abs(y.realized || 0) / top * 82).toFixed(1)}%"></span>
                </span>
                <span class="pf-year__year">${y.year}</span>
                <span class="pf-year__trades">${plural(y.trades, 'trade')}</span>
            </button>`).join('') : '<p class="pf-muted">No trades yet.</p>';
        $('yearCols').querySelectorAll('.pf-year').forEach((col) => {
            const y = data.years.find((r) => String(r.year) === col.dataset.year);
            const parts = [String(y.year)];
            if (!privacy) {
                parts.push(`${fmtMoney(y.bought, true)} bought`, `${fmtMoney(y.sold, true)} sold`);
                if (y.dividends) parts.push(`${fmtMoney(y.dividends, true)} income`);
                if (y.fees) parts.push(`${fmtMoney(y.fees, true)} fees`);
            }
            col.addEventListener('mousemove', (event) => showTip(event, parts.join(' · ')));
            col.addEventListener('mouseleave', hideTip);
        });
    }

    function renderGains(data) {
        renderBridge(data);
        renderYears(data);
        if (currentTab() === 'gains') renderGainCharts();

        const reported = data.reportedRealized;
        const realized = data.realizedByTicker;
        $('realizedSub').innerHTML = reported.count
            ? `File: <strong class="${tone(reported.reported)}">${fmtSigned(reported.reported, true)}</strong> on ${plural(reported.count, 'sell')} · average cost: <strong class="${tone(reported.computed)}">${fmtSigned(reported.computed, true)}</strong>`
            : realized.length ? `${countFormat.format(realized.length)} ${realized.length === 1 ? 'security' : 'securities'}` : '';
        const shown = showAllRealized ? realized : realized.slice(0, REALIZED_SHOWN);
        const rate = (r) => {
            const cost = (r.sold || 0) - (r.realizedGain || 0);
            return cost > 0 ? r.realizedGain / cost : null;
        };
        $('realizedTable').innerHTML = `
            <thead><tr><th scope="col">Security</th><th scope="col" class="num">Realized</th><th scope="col" class="num">Return</th><th scope="col" class="num pf-hide-sm">Sold</th></tr></thead>
            <tbody>${shown.map((r) => `
                <tr data-ticker="${escapeHtml(r.ticker)}">
                    <td>${securityLink({ ticker: r.ticker, asset: 'stock' })}</td>
                    <td class="num pf-strong ${tone(r.realizedGain)}">${fmtSigned(r.realizedGain, true)}</td>
                    <td class="num ${tone(rate(r))}">${fmtPct(rate(r), true)}</td>
                    <td class="num pf-hide-sm">${fmtMoney(r.sold, true)}</td>
                </tr>`).join('') || '<tr><td colspan="4" class="pf-muted">No sells yet.</td></tr>'}
            </tbody>`;
        const toggle = $('realizedToggle');
        toggle.hidden = realized.length <= REALIZED_SHOWN;
        toggle.textContent = showAllRealized ? 'Show fewer' : `Show all ${realized.length}`;
    }

    $('realizedToggle').addEventListener('click', () => {
        showAllRealized = !showAllRealized;
        if (lastData) renderGains(lastData);
    });
    $('yearCols').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-year]');
        if (!button) return;
        hideTip();
        resetFilters();
        $('filterYear').value = button.dataset.year;
        window.location.hash = 'activity';
    });

    // ── activity ───────────────────────────────────────────────────────────

    // `seq` numbers each request so a slow, older answer never replaces a newer one.
    const trades = { offset: 0, total: 0, version: null, timer: null, seq: 0 };

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
        const seq = ++trades.seq;
        const data = await run(() => api(`/transactions?${filterParams()}`));
        if (!data || seq !== trades.seq) return;
        trades.total = data.total;
        const filtered = filterParams().toString().replace(/(^|&)(offset|limit)=[^&]*/g, '') !== '';
        const dupes = lastData?.duplicates.count || 0;
        els.transactionsSub.textContent = lastData?.transactionCount
            ? `${filtered ? `${plural(data.total, 'row')} match · ` : ''}${plural(lastData.transactionCount, 'trade')} counted${dupes ? ` · ${countFormat.format(dupes)} duplicate${dupes === 1 ? '' : 's'} across sources not counted` : ''}${lastData.transactionsIgnored ? ` · ${countFormat.format(lastData.transactionsIgnored)} already in your holdings` : ''}`
            : 'No trades yet.';
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
                <td><span class="pf-side pf-side--${t.side}">${SIDE_LABELS[t.side] || t.side}</span></td>
                ${t.side === 'dividend' ? `<td class="num pf-hide-sm pf-muted">—</td>
                <td class="num pf-hide-sm pf-muted">—</td>` : t.splitFactor !== 1
                    ? `<td class="num pf-hide-sm" title="Adjusted for stock splits since the trade">${fmtShares(t.adjustedShares)}<span class="pf-sub">${fmtShares(t.shares)} as traded</span></td>
                <td class="num pf-hide-sm">${fmtPrice(t.adjustedPrice)}<span class="pf-sub">${fmtPrice(t.price)} as traded</span></td>`
                    : `<td class="num pf-hide-sm">${fmtShares(t.shares)}</td>
                <td class="num pf-hide-sm">${fmtPrice(t.price)}</td>`}
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

    // The Performance tab's charts measure their boxes: drawn when shown.
    function renderGainCharts() {
        if (!lastData) return;
        renderPerformance();
    }

    // Each day's return on what was invested that day (see rangeReturn).
    function dailyReturns(points) {
        const out = [];
        const opening = openingGain(points);
        if (opening) out.push({ date: points[0].date, r: opening.gain / opening.base });
        for (let i = 1; i < points.length; i += 1) {
            const flow = points[i].flow || 0;
            const base = points[i - 1].value + Math.max(flow, 0);
            if (base > 0) out.push({ date: points[i].date, r: (points[i].value - points[i - 1].value - flow) / base });
        }
        return out;
    }

    // The time-weighted return from a range's start to each of its days.
    function growthSeries(points) {
        let growth = 1;
        const opening = openingGain(points);
        if (opening) growth = 1 + opening.gain / opening.base;
        return points.map((p, i) => {
            if (i) {
                const flow = p.flow || 0;
                const base = points[i - 1].value + Math.max(flow, 0);
                if (base > 0) growth *= 1 + (p.value - points[i - 1].value - flow) / base;
            }
            return growth - 1;
        });
    }

    // Each holding's dollars of gain over a period, as a bar either side of
    // zero; in privacy mode, as points of the period's return.
    let contribRange = 'ALL';
    function fmtPoints(points) {
        const text = Math.abs(points).toFixed(1);
        return `${Number(text) === 0 ? '' : points > 0 ? '+' : '−'}${text} pts`;
    }
    function renderContribution() {
        const card = $('contribCard');
        const period = history.data?.attribution?.[contribRange];
        const rows = period?.rows || [];
        card.hidden = !history.data?.attribution?.ALL?.rows?.length;
        if (card.hidden) return;
        document.querySelectorAll('[data-contrib]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.contrib === contribRange)));
        const scale = Math.max(...rows.map((r) => Math.abs(r.gain)), 1);
        const value = (gain) => (privacy
            ? (period.capital ? fmtPoints(gain / period.capital * 100) : '—')
            : fmtSigned(gain, true));
        $('contribList').innerHTML = rows.length ? rows.map((r) => `
            <li>
                <a class="pf-ticker" href="${holdingHref(r.ticker)}">${escapeHtml(r.ticker)}</a>
                <span class="pf-contrib__bar"><i class="${r.gain >= 0 ? 'is-gain' : 'is-loss'}" style="width:${(Math.abs(r.gain) / scale * 50).toFixed(1)}%"></i></span>
                <span class="pf-contrib__value ${tone(r.gain)}">${value(r.gain)}</span>
            </li>`).join('') : '<li class="pf-contrib__none">No change</li>';
    }
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-contrib]');
        if (!button) return;
        contribRange = button.dataset.contrib;
        renderContribution();
    });

    // Return, risk and the S&P 500 over the chosen range.
    function rangeStats(points) {
        const returns = dailyReturns(points);
        let growth = 1;
        let peak = 1;
        let drawdown = 0;
        let trough = null;
        returns.forEach(({ date, r }) => {
            growth *= 1 + r;
            peak = Math.max(peak, growth);
            if (growth / peak - 1 < drawdown) { drawdown = growth / peak - 1; trough = date; }
        });
        const years = (new Date(points[points.length - 1].date) - new Date(points[0].date)) / (365.25 * 86400000);
        const mean = returns.reduce((sum, d) => sum + d.r, 0) / returns.length;
        const variance = returns.reduce((sum, d) => sum + (d.r - mean) ** 2, 0) / (returns.length - 1);
        const bench = points.filter((p) => p.benchmark != null);
        // Beta: the portfolio's daily moves against the index's, same days.
        const byDate = new Map(returns.map((d) => [d.date, d.r]));
        const pairs = [];
        for (let i = 1; i < points.length; i += 1) {
            const a = points[i - 1].benchmark;
            const b = points[i].benchmark;
            if (a && b != null && byDate.has(points[i].date)) pairs.push([byDate.get(points[i].date), b / a - 1]);
        }
        let beta = null;
        if (pairs.length >= 20) {
            const mp = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
            const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
            const cov = pairs.reduce((s, p) => s + (p[0] - mp) * (p[1] - mb), 0);
            const vb = pairs.reduce((s, p) => s + (p[1] - mb) ** 2, 0);
            beta = vb ? cov / vb : null;
        }
        // Sharpe: the yearly return over the 3-month T-bill rate, averaged
        // across the range's months, per unit of volatility.
        const first = points[0].date.slice(0, 7);
        const last = points[points.length - 1].date.slice(0, 7);
        const rates = (history.data?.riskFree || []).filter((m) => m.month >= first && m.month <= last);
        const riskFree = rates.length ? rates.reduce((s, m) => s + m.rate, 0) / rates.length : null;
        const volatility = Math.sqrt(variance * 252);
        const sharpe = riskFree == null || !volatility ? null : (mean * 252 - riskFree) / volatility;
        return {
            riskFree,
            sharpe,
            total: growth - 1,
            annual: years >= 1 ? growth ** (1 / years) - 1 : null,
            years,
            drawdown,
            trough,
            volatility,
            bench: bench.length > 1 ? bench[bench.length - 1].benchmark / bench[0].benchmark - 1 : null,
            beta,
        };
    }

    const perf = { range: 'All' };
    function stat(label, value, sub = '', valueClass = '') {
        return `<div class="pf-stat"><p class="pf-stat__label">${label}</p><p class="pf-stat__value ${valueClass}">${value}</p><p class="pf-stat__sub">${sub}</p></div>`;
    }

    function renderPerformance() {
        renderContribution();
        const all = history.data?.points || [];
        const card = $('perfCard');
        if (dailyReturns(all).length < 5) {
            $('perfSub').textContent = history.data ? 'Not enough history yet.' : 'Loading price history…';
            $('perfValue').textContent = '—';
            $('perfChart').innerHTML = '';
            $('perfStrip').innerHTML = '';
            $('perfRanges').innerHTML = '';
            $('perfLegend').hidden = true;
            $('monthlyCard').hidden = true;
            $('drawdownCard').hidden = true;
            return;
        }
        perf.range = renderRanges(all, $('perfRanges'), perf.range);
        const points = pointsInRange(all, perf.range);
        $('perfLabel').textContent = perf.range === 'All' ? 'Return · All time' : perf.range === 'YTD' ? 'Return · Year to date' : `Return · ${perf.range}`;
        if (points.length < 3) {
            $('perfSub').textContent = 'Not enough days in this range yet.';
            $('perfValue').textContent = '—';
            $('perfChart').innerHTML = '';
            $('perfStrip').innerHTML = '';
        } else {
            const s = rangeStats(points);
            const { gain } = rangeReturn(points);
            card.classList.toggle('is-down', s.total < 0);
            $('perfValue').className = 'pf-hero__value';
            $('perfValue').textContent = fmtPct(s.total, true);
            $('perfSub').innerHTML = perfSubHtml(privacy ? null : gain, s.bench);
            $('perfLegend').hidden = s.bench == null;
            drawPerfChart(points);
            const diff = s.bench == null ? null : (s.total - s.bench) * 100;
            $('perfStrip').innerHTML = [
                ...(diff == null ? [] : [stat('vs S&amp;P 500', `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)} pts`, `S&amp;P 500 ${fmtPct(s.bench, true)}`, tone(diff))]),
                stat('Annualized', s.annual == null ? '—' : fmtPct(s.annual, true), s.annual == null ? '' : `${s.years.toFixed(1)} years`, tone(s.annual)),
                stat('Max drawdown', fmtPct(s.drawdown, true), s.trough ? `Low ${fmtDay(s.trough)}` : '', tone(s.drawdown)),
                stat('Volatility', fmtPct(s.volatility), 'Annualized'),
                ...(s.sharpe == null ? [] : [stat('Sharpe', s.sharpe.toFixed(2), `T-bills ${fmtPct(s.riskFree)}`)]),
                stat('Beta', s.beta == null ? '—' : s.beta.toFixed(2), 'vs S&amp;P 500'),
            ].join('');
        }
        renderMonthly(all);
        drawDrawdown(all);
    }

    function perfSubHtml(gain, bench, day = '') {
        const parts = [];
        if (gain != null) parts.push(`<span class="pf-history-change ${tone(gain)}">${fmtSigned(gain, true)}</span>`);
        if (bench != null) parts.push(`<span class="pf-bench">S&amp;P 500 ${fmtPct(bench, true)}</span>`);
        if (day) parts.push(`<span class="pf-bench">${day}</span>`);
        return parts.join(' <span class="pf-dot">·</span> ');
    }

    // The range's return line with the S&P 500's beside it, both from zero.
    function drawPerfChart(points) {
        const host = $('perfChart');
        host.innerHTML = '';
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (!width) return;
        const pad = { top: 10, right: 4, bottom: 22, left: 4 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;
        const mine = growthSeries(points);
        const first = points.find((p) => p.benchmark != null)?.benchmark;
        const bench = points.map((p) => (first && p.benchmark != null ? p.benchmark / first - 1 : null));
        const values = [0, ...mine, ...bench.filter((v) => v != null)];
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        const margin = (hi - lo) * 0.06 || 0.01;
        lo -= margin;
        hi += margin;
        const x = (i) => pad.left + (i / (points.length - 1)) * innerW;
        const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
        const line = (series, indices) => indices.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(series[i]).toFixed(1)}`).join('');
        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Return from ${points[0].date} to ${points[points.length - 1].date}` });
        root.appendChild(svg('line', { class: 'pf-chart__guide', x1: pad.left, x2: width - pad.right, y1: y(0), y2: y(0) }));
        sparseAxes(root, points, { lo, hi, x, y, width, height, pad, label: null });
        runs(points, (_, i) => bench[i] != null).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__bench', d: line(bench, indices.filter((i) => bench[i] != null)) }));
        });
        root.appendChild(svg('path', { class: 'pf-chart__line', pathLength: 1, d: line(mine, points.map((_, i) => i)) }));
        endDot(root, x(points.length - 1), y(mine[mine.length - 1]));
        const cross = svg('line', { class: 'pf-chart__cross', y1: pad.top, y2: pad.top + innerH, visibility: 'hidden' });
        const benchDot = svg('circle', { class: 'pf-chart__bench-dot', r: 3.5, visibility: 'hidden' });
        const dot = svg('circle', { class: 'pf-chart__dot', r: 4.5, visibility: 'hidden' });
        root.appendChild(cross);
        root.appendChild(benchDot);
        root.appendChild(dot);
        const hit = svg('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent' });
        root.appendChild(hit);
        const scrub = scrubber($('perfValue'), $('perfSub'));
        function hover(event) {
            const box = root.getBoundingClientRect();
            const px = ((event.clientX - box.left) / box.width) * width;
            const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.left) / innerW) * (points.length - 1))));
            cross.setAttribute('x1', x(i));
            cross.setAttribute('x2', x(i));
            dot.setAttribute('cx', x(i));
            dot.setAttribute('cy', y(mine[i]));
            cross.setAttribute('visibility', 'visible');
            dot.setAttribute('visibility', 'visible');
            if (bench[i] != null) {
                benchDot.setAttribute('cx', x(i));
                benchDot.setAttribute('cy', y(bench[i]));
                benchDot.setAttribute('visibility', 'visible');
            } else benchDot.setAttribute('visibility', 'hidden');
            const gain = privacy ? null : rangeReturn(points.slice(0, i + 1)).gain;
            scrub.show(fmtPct(mine[i], true), null, perfSubHtml(gain, bench[i], fmtDay(points[i].date)));
        }
        hit.addEventListener('mousemove', hover);
        hit.addEventListener('touchmove', (event) => { hover(event.touches[0]); event.preventDefault(); }, { passive: false });
        const leave = () => {
            [cross, dot, benchDot].forEach((n) => n.setAttribute('visibility', 'hidden'));
            scrub.clear();
        };
        hit.addEventListener('mouseleave', leave);
        hit.addEventListener('touchend', leave);
        markFresh(host, root, `${perf.range}:${points[0].date}:${points[points.length - 1].date}:${points.length}`);
        host.appendChild(root);
    }
    $('perfRanges').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-range]');
        if (!button || !history.data) return;
        perf.range = button.dataset.range;
        renderPerformance();
    });
    redrawOnResize('perfChart', () => { if (currentTab() === 'gains' && history.data) renderPerformance(); });

    // Months as a heat table, newest year first, with each year's total.
    function renderMonthly(points) {
        const months = new Map();
        dailyReturns(points).forEach(({ date, r }) => {
            const key = date.slice(0, 7);
            months.set(key, (months.get(key) ?? 1) * (1 + r));
        });
        const byYear = new Map();
        months.forEach((g, key) => {
            const year = key.slice(0, 4);
            if (!byYear.has(year)) byYear.set(year, new Array(12).fill(null));
            byYear.get(year)[Number(key.slice(5)) - 1] = g - 1;
        });
        const shade = (r) => {
            const strength = Math.min(1, Math.abs(r) / 0.08) * 0.4 + 0.05;
            return `background: rgba(${r >= 0 ? '31, 122, 77' : '166, 61, 47'}, ${strength.toFixed(2)})`;
        };
        $('monthlyCard').hidden = !months.size;
        $('monthlyTable').innerHTML = `
            <thead><tr><th scope="col"></th>${MONTHS.map((m) => `<th scope="col">${m}</th>`).join('')}<th scope="col">Year</th></tr></thead>
            <tbody>${[...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, cells]) => {
                const yearReturn = cells.reduce((g, r) => (r == null ? g : g * (1 + r)), 1) - 1;
                return `<tr><td>${year}</td>${cells.map((r) => (r == null ? '<td class="pf-heat__empty"></td>'
                    : `<td class="pf-heat__cell" style="${shade(r)}">${fmtPct(r, true)}</td>`)).join('')}<td class="pf-heat__total ${tone(yearReturn)}">${fmtPct(yearReturn, true)}</td></tr>`;
            }).join('')}</tbody>`;
    }

    // How far below its last high the portfolio sat each day, all time.
    function drawDrawdown(points) {
        const host = $('drawdownChart');
        const returns = dailyReturns(points);
        $('drawdownCard').hidden = returns.length < 5;
        host.innerHTML = '';
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (returns.length < 5 || !width) return;
        let growth = 1;
        let peak = 1;
        const dd = returns.map(({ date, r }) => {
            growth *= 1 + r;
            peak = Math.max(peak, growth);
            return { date, v: growth / peak - 1 };
        });
        const current = dd[dd.length - 1].v;
        $('drawdownSub').textContent = current > -0.005 ? 'At a high' : `${fmtPct(current, true)} from high`;
        const low = dd.reduce((a, b) => (b.v < a.v ? b : a));
        const pad = { top: 4, right: 4, bottom: 22, left: 4 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;
        const floor = Math.min(low.v, -0.01);
        const x = (i) => pad.left + (i / (dd.length - 1)) * innerW;
        const y = (v) => pad.top + (v / floor) * innerH;
        const line = dd.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join('');
        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Deepest drawdown ${fmtPct(low.v, true)} on ${fmtDay(low.date)}` });
        root.appendChild(svg('path', { class: 'pf-dd__area', d: `${line}L${x(dd.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` }));
        root.appendChild(svg('path', { class: 'pf-dd__line', d: line }));
        root.appendChild(svg('line', { class: 'pf-zero', x1: pad.left, x2: width - pad.right, y1: y(0), y2: y(0) }));
        const li = dd.indexOf(low);
        if (low.v < 0) {
            root.appendChild(svg('circle', { class: 'pf-dd__low', cx: x(li), cy: y(low.v), r: 3.5 }));
            const right = x(li) < width - 70;
            const label = svg('text', { class: 'pf-dd__label', x: x(li) + (right ? 8 : -8), y: y(low.v) + 4, 'text-anchor': right ? 'start' : 'end' });
            label.textContent = fmtPct(low.v, true);
            root.appendChild(label);
        }
        sparseAxes(root, dd, { lo: floor, hi: 0, x, y, width, height, pad, label: null });
        host.appendChild(root);
    }
    redrawOnResize('drawdownChart', () => { if (currentTab() === 'gains' && history.data) drawDrawdown(history.data.points); });

    // ── income ─────────────────────────────────────────────────────────────

    function renderIncome(data) {
        const d = data.dividends;
        $('incomeTrailing').textContent = fmtMoney(d.trailing12m, true);
        $('incomeTrailingSub').textContent = d.yield == null ? '' : `${fmtPct(d.yield)} yield`;
        $('incomeProjected').textContent = fmtMoney(d.projectedTotal, true);
        $('incomeProjectedSub').textContent = privacy || !d.projectedTotal ? '' : `${fmtMoney(d.projectedTotal / 12, true)} / month`;
        const top = d.byTicker[0]?.amount || 1;
        $('incomeByTicker').innerHTML = d.byTicker.map((r) => `
            <div class="pf-payer">
                <a class="pf-ticker" href="${holdingHref(r.ticker)}">${escapeHtml(r.ticker)}</a>
                <span class="pf-payer__track"><span style="width:${(r.amount / top * 100).toFixed(1)}%"></span></span>
                <span class="pf-payer__amount">${fmtMoney(r.amount)}</span>
                <span class="pf-payer__share">${fmtPct(r.amount / (d.total || 1))}</span>
            </div>`).join('') || '<p class="pf-muted">No dividends yet.</p>';
        drawIncomeChart();
        drawIncomeUpcoming();
        $('incomeRecentSub').textContent = d.count ? `${plural(d.count, 'payment')}${privacy ? '' : ` · ${fmtMoney(d.total, true)}`}` : '';
        $('incomeRecent').innerHTML = `
            <thead><tr><th scope="col">Date</th><th scope="col">Security</th><th scope="col" class="num">Amount</th></tr></thead>
            <tbody>${d.recent.map((r) => `
                <tr data-ticker="${escapeHtml(r.ticker)}"><td class="pf-muted">${fmtDay(r.date)}</td><td>${securityLink({ ticker: r.ticker, asset: 'stock' })}</td><td class="num pf-strong">${fmtMoney(r.amount)}</td></tr>`).join('')
                || '<tr><td colspan="3" class="pf-muted">No dividends yet.</td></tr>'}
            </tbody>`;
    }

    // Dividends on what's held that are still to be paid, by pay day, from
    // the same calendar as the Overview's upcoming list.
    function drawIncomeUpcoming() {
        const now = today();
        const events = upcoming.events
            .filter((e) => e.kind === 'dividend' && (e.payDate || e.date) >= now)
            .sort((a, b) => (a.payDate || a.date).localeCompare(b.payDate || b.date));
        $('incomeUpcomingCard').hidden = !events.length;
        $('incomeUpcoming').innerHTML = events.map((e) => {
            const day = new Date(`${e.payDate || e.date}T00:00:00Z`);
            const perShare = e.amount == null ? '' : `${fmtPrice(e.amount)}/sh`;
            const amount = privacy || e.total == null ? perShare : fmtMoney(e.total);
            const what = [`Ex-dividend ${eventDay.format(new Date(`${e.date}T00:00:00Z`))}`];
            if (perShare && amount !== perShare) what.push(perShare);
            return `<li>
                <span class="pf-cal__date"><small>${MONTHS[day.getUTCMonth()]}</small><b>${day.getUTCDate()}</b></span>
                <span class="pf-cal__what"><a class="pf-ticker" href="${holdingHref(e.ticker)}">${escapeHtml(e.ticker)}</a><small>${e.payDate ? '' : 'Pay date not set · '}${what.join(' · ')}</small></span>
                <span class="pf-cal__amount">${amount}</span>
            </li>`;
        }).join('');
    }

    // The last twelve months received and the next twelve projected, a bar
    // a month; this month carries both.
    function drawIncomeChart() {
        const host = $('incomeBars');
        const d = lastData?.dividends;
        const width = host.clientWidth;
        host.innerHTML = '';
        if (!d?.received || !width) return;
        const months = new Map();
        d.received.forEach((m) => months.set(m.month, { month: m.month, got: m.amount, due: 0 }));
        d.projected.forEach((m) => {
            const row = months.get(m.month) || { month: m.month, got: 0, due: 0 };
            row.due = m.amount;
            months.set(m.month, row);
        });
        const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
        const height = host.clientHeight || 220;
        const pad = { top: 8, bottom: 22 };
        const innerH = height - pad.top - pad.bottom;
        const top = Math.max(...rows.map((r) => r.got + r.due), 0.01);
        const slot = width / rows.length;
        const barW = Math.max(4, Math.min(22, slot * 0.6));
        const scaleY = (v) => (v / top) * innerH;
        const base = pad.top + innerH;
        const nowIndex = rows.findIndex((r) => r.month === d.received[d.received.length - 1].month);
        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Dividends by month, received and projected' });
        root.appendChild(svg('line', { class: 'pf-zero', x1: 0, x2: width, y1: base, y2: base }));
        if (nowIndex >= 0) {
            const x = slot * (nowIndex + 1);
            root.appendChild(svg('line', { class: 'pf-chart__guide', x1: x, x2: x, y1: pad.top, y2: base }));
        }
        rows.forEach((r, i) => {
            const cx = slot * i + slot / 2;
            const got = scaleY(r.got);
            const due = scaleY(r.due);
            const group = svg('g', { class: 'pf-incomebar' });
            group.appendChild(svg('rect', { class: 'pf-incomebar__hit', x: slot * i, y: pad.top, width: slot, height: innerH }));
            if (got) group.appendChild(svg('rect', { class: 'pf-bar--received', x: cx - barW / 2, y: base - got, width: barW, height: got }));
            if (due) group.appendChild(svg('rect', { class: 'pf-bar--projected', x: cx - barW / 2, y: base - got - due, width: barW, height: due }));
            const [year, month] = r.month.split('-').map(Number);
            const label = `${MONTHS[month - 1]} ${year}`;
            const parts = [label];
            if (r.got) parts.push(`${fmtMoney(r.got)} received`);
            if (r.due) parts.push(`${fmtMoney(r.due)} projected`);
            group.addEventListener('mousemove', (event) => showTip(event, parts.join(' · ')));
            group.addEventListener('mouseleave', hideTip);
            root.appendChild(group);
            if ((rows.length - 1 - i) % 3 === 0) {
                const text = svg('text', { class: 'pf-chart__axis', x: cx, y: height - 4, 'text-anchor': 'middle' });
                text.textContent = month === 1 || i === 0 ? `${MONTHS[month - 1]} ’${String(year).slice(2)}` : MONTHS[month - 1];
                root.appendChild(text);
            }
        });
        host.appendChild(root);
    }
    new ResizeObserver(() => drawIncomeChart()).observe($('incomeBars'));

    // ── taxes ──────────────────────────────────────────────────────────────

    function termPill(lot) {
        if (lot.term === 'unknown') return '<span class="pf-term">Unknown</span>';
        return `<span class="pf-term pf-term--${lot.term}">${lot.term === 'long' ? 'Long' : 'Short'}</span>`;
    }
    function lotRow(lot, withTicker = true) {
        return `<tr${withTicker ? ` data-ticker="${escapeHtml(lot.ticker)}"` : ''}>
            ${withTicker ? `<td>${securityLink({ ticker: lot.ticker, asset: 'stock' })}</td>` : ''}
            <td>${lot.date ? fmtDay(lot.date) : '—'}</td>
            <td class="num">${fmtShares(lot.shares)}</td>
            <td class="num pf-hide-sm">${fmtPrice(lot.cost)}</td>
            <td class="num pf-hide-sm">${fmtMoney(lot.value, true)}</td>
            ${gainCell(lot)}
            <td>${termPill(lot)}</td>
            <td class="num pf-hide-sm">${lot.longTermOn ? fmtDay(lot.longTermOn) : ''}</td>
        </tr>`;
    }
    function lotHead(withTicker = true) {
        return `<thead><tr>${withTicker ? '<th scope="col">Security</th>' : ''}<th scope="col">Acquired</th><th scope="col" class="num">Shares</th>
            <th scope="col" class="num pf-hide-sm">Cost/sh</th><th scope="col" class="num pf-hide-sm">Value</th><th scope="col" class="num">Gain</th>
            <th scope="col">Term</th><th scope="col" class="num pf-hide-sm">Long-term on</th></tr></thead>`;
    }

    let lotTerm = 'all';
    const DAY_MS = 86400000;
    function renderTaxes(data) {
        const tx = data.taxes;
        const year = new Date().getFullYear();
        const thisYear = data.years.find((y) => y.year === year);
        const lots = tx.lots;
        const losses = lots.filter((l) => l.gain < 0).sort((a, b) => a.gain - b.gain);
        const lossTotal = losses.reduce((sum, l) => sum + l.gain, 0);
        const count = (term) => plural(lots.filter((l) => l.term === term).length, 'lot');
        $('taxStats').innerHTML = [
            stat('Short-term unrealized', fmtSigned(tx.short, true), count('short'), tone(tx.short)),
            stat('Long-term unrealized', fmtSigned(tx.long, true), count('long'), tone(tx.long)),
            stat(`Realized in ${year}`, fmtSigned(thisYear ? thisYear.realized : 0, true), thisYear ? plural(thisYear.trades, 'trade') : '', tone(thisYear?.realized)),
            stat('Unrealized losses', fmtSigned(lossTotal, true), plural(losses.length, 'lot'), tone(lossTotal)),
        ].join('');

        // Gains and losses by holding period, as one bar.
        const sum = (term, sign) => lots.filter((l) => l.term === term && Math.sign(l.gain) === sign).reduce((s, l) => s + Math.abs(l.gain), 0);
        const parts = [['sg', sum('short', 1)], ['lg', sum('long', 1)], ['sl', sum('short', -1)], ['ll', sum('long', -1)]];
        const whole = parts.reduce((s, p) => s + p[1], 0);
        $('taxSplit').hidden = !whole;
        $('taxSplit').nextElementSibling.hidden = !whole;
        $('taxSplit').innerHTML = parts.filter((p) => p[1]).map(([cls, v]) => `<span class="pf-split--${cls}" style="width:${(v / whole * 100).toFixed(2)}%"></span>`).join('');

        // Short-term lots that cross a year held in the next 90 days.
        const now = new Date(`${today()}T00:00:00Z`);
        const soon = lots
            .filter((l) => l.term === 'short' && l.longTermOn)
            .map((l) => ({ ...l, days: Math.round((new Date(`${l.longTermOn}T00:00:00Z`) - now) / DAY_MS) }))
            .filter((l) => l.days >= 0 && l.days <= 90)
            .sort((a, b) => a.days - b.days);
        $('soonCard').hidden = !soon.length;
        $('soonList').innerHTML = soon.map((l) => `
            <li>
                <span class="pf-soon__who"><a class="pf-ticker" href="${holdingHref(l.ticker)}">${escapeHtml(l.ticker)}</a><small class="${tone(l.gain)}">${fmtSigned(l.gain, true)}</small></span>
                <span class="pf-soon__track"><span style="width:${((365 - l.days) / 365 * 100).toFixed(1)}%"></span></span>
                <span class="pf-soon__days">${plural(l.days, 'day')}<small>${fmtDay(l.longTermOn)}</small></span>
            </li>`).join('');

        $('harvestCard').hidden = !losses.length;
        $('harvestSub').textContent = losses.length ? fmtSigned(lossTotal, true) : '';
        $('harvestTable').innerHTML = `
            <thead><tr><th scope="col">Security</th><th scope="col">Term</th><th scope="col" class="num">Loss</th><th scope="col" class="num">Return</th></tr></thead>
            <tbody>${losses.map((l) => `
                <tr data-ticker="${escapeHtml(l.ticker)}">
                    <td>${securityLink({ ticker: l.ticker, asset: 'stock' })}</td>
                    <td>${termPill(l)}</td>
                    <td class="num pf-strong is-loss">${fmtSigned(l.gain, true)}</td>
                    <td class="num is-loss">${fmtPct(l.gainPct, true)}</td>
                </tr>`).join('')}</tbody>`;
        renderLots();
    }
    function renderLots() {
        const lots = (lastData?.taxes.lots || []).filter((l) => lotTerm === 'all' || l.term === lotTerm);
        $('lotFilter').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.term === lotTerm)));
        $('lotsTable').innerHTML = `${lotHead()}<tbody>${lots.map((l) => lotRow(l)).join('') || '<tr><td colspan="8" class="pf-muted">No open lots.</td></tr>'}</tbody>`;
    }
    $('lotFilter').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-term]');
        if (!button) return;
        lotTerm = button.dataset.term;
        renderLots();
    });

    // ── watchlist ──────────────────────────────────────────────────────────

    const watch = { data: null, timer: null };
    async function loadWatchlist() {
        clearTimeout(watch.timer);
        const data = await run(() => api('/watchlist'));
        if (!data) return;
        watch.data = data;
        renderWatchlist();
        if (data.items.some((i) => i.priceStatus === 'pending') && currentTab() === 'watchlist') {
            watch.timer = setTimeout(loadWatchlist, (data.retryAfter || 5) * 1000);
        }
    }
    function alertText(item) {
        const parts = [];
        if (item.alertAbove != null) parts.push(`<span class="${item.triggered === 'above' ? 'pf-alert pf-alert--above' : ''}">Above ${fmtPrice(item.alertAbove)}</span>`);
        if (item.alertBelow != null) parts.push(`<span class="${item.triggered === 'below' ? 'pf-alert pf-alert--below' : ''}">Below ${fmtPrice(item.alertBelow)}</span>`);
        return parts.join(' · ') || '<span class="pf-muted">—</span>';
    }
    function renderWatchlist() {
        const items = watch.data?.items || [];
        const hits = items.filter((i) => i.triggered).length;
        $('watchSub').textContent = items.length
            ? `${plural(items.length, 'ticker')}${hits ? ` · ${plural(hits, 'alert')} hit` : ''}`
            : 'No tickers yet.';
        $('watchTable').innerHTML = items.length ? `
            <thead><tr><th scope="col">Ticker</th><th scope="col" class="num">Price</th><th scope="col" class="num">Day</th><th scope="col">Alerts</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
            <tbody>${items.map((i) => `
                <tr>
                    <td><a class="pf-ticker" href="/portfolio/research/?ticker=${encodeURIComponent(i.ticker)}">${escapeHtml(i.ticker)}</a>${i.name && i.name !== i.ticker ? `<span class="pf-name">${escapeHtml(i.name)}</span>` : ''}</td>
                    <td class="num pf-strong">${i.price != null ? fmtPrice(i.price) : `<span class="pf-muted">${i.priceStatus === 'pending' ? 'Loading…' : 'Unavailable'}</span>`}</td>
                    <td class="num ${tone(i.dayChangePct)}">${i.dayChangePct != null ? fmtPct(i.dayChangePct, true) : '—'}</td>
                    <td>${alertText(i)}</td>
                    <td class="num"><button type="button" class="pf-remove" data-watch="${escapeHtml(i.ticker)}" aria-label="Stop watching ${escapeHtml(i.ticker)}">×</button></td>
                </tr>`).join('')}
            </tbody>` : '';
    }
    $('watchForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const number = (id) => ($(id).value === '' ? null : Number($(id).value));
        const data = await run(() => api('/watchlist', {
            method: 'POST',
            body: { ticker: $('watchTicker').value.trim(), alert_above: number('watchAbove'), alert_below: number('watchBelow') },
        }));
        if (!data) return;
        $('watchForm').reset();
        watch.data = data;
        renderWatchlist();
    });
    $('watchTable').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-watch]');
        if (!button) return;
        const data = await run(() => api(`/watchlist/${encodeURIComponent(button.dataset.watch)}`, { method: 'DELETE' }));
        if (data) { watch.data = data; renderWatchlist(); }
    });

    // ── header menu and exports ────────────────────────────────────────────

    function setMenuOpen(open) {
        $('moreMenu').hidden = !open;
        $('moreToggle').setAttribute('aria-expanded', String(open));
    }
    $('moreToggle').addEventListener('click', (event) => {
        event.stopPropagation();
        setMenuOpen($('moreMenu').hidden);
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.pf-menu')) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !$('moreMenu').hidden) { setMenuOpen(false); $('moreToggle').focus(); }
    });
    $('moreMenu').addEventListener('click', async (event) => {
        const item = event.target.closest('button');
        if (!item) return;
        setMenuOpen(false);
        if (item.dataset.export) await exportCsv(item.dataset.export);
    });
    async function exportCsv(kind) {
        showError('');
        const response = await fetch(`${API_BASE}/api/stocks/portfolio/export?kind=${kind}`, { credentials: 'same-origin' });
        if (response.status === 403) { showSignedOut(); return; }
        if (!response.ok) { showError(`Export failed (${response.status}).`); return; }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = kind === 'positions' ? 'portfolio-positions.csv' : 'portfolio-realized-gains.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const history = { data: null, range: '1Y', signature: null, retries: 0, timer: null };

    // Whether a holding's average-cost line is drawn; remembered per browser.
    // Hidden, the y axis fits the price alone.
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
        if (currentTab() === 'holding' && holding.data) renderHolding();
    });

    const EYE = '<svg class="pf-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg class="pf-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    function syncPrivacyToggle() {
        const button = $('privacyToggle');
        const label = privacy ? 'Show amounts' : 'Hide amounts';
        button.setAttribute('aria-pressed', String(privacy));
        button.setAttribute('aria-label', label);
        button.title = label;
        button.innerHTML = privacy ? EYE_OFF : EYE;
    }
    syncPrivacyToggle();
    $('privacyToggle').addEventListener('click', () => {
        privacy = !privacy;
        try { localStorage.setItem('pf.privacy', String(privacy)); } catch { /* storage blocked */ }
        syncPrivacyToggle();
        if (lastData) render(lastData);
        if (history.data) renderHistory();
        if (holding.data) renderHolding();
        if (watch.data) renderWatchlist();
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
        if (currentTab() === 'gains') renderPerformance();
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

    // The very first day of a history built from trades alone: what was
    // bought that day and what it closed at. A range that starts there counts
    // that day's gain too, as the contribution figures do; any later start, or
    // a history that opens on a holdings snapshot, counts from the day's close.
    function openingGain(points) {
        const first = points[0];
        if (!first || history.data?.asOf || first !== history.data?.points?.[0]) return null;
        const base = first.flow || 0;
        return base > 0 ? { gain: first.value - base, base } : null;
    }

    // The gain over a range, less money put in or taken out, and its percent
    // as a time-weighted return: each day's gain on what was invested that
    // day, chained. A first $2k buy growing to $45k by adding money then
    // reads as its real gain, not +2,000%.
    // The dollar change carries the color; the percent beside it stays neutral,
    // since deposits can make the two disagree in sign.
    function rangeChangeHtml(gain, pct) {
        const rate = pct == null ? '' : ` <span class="pf-history-rate">(${fmtPct(pct, true)})</span>`;
        return `<span class="pf-history-change ${tone(gain)}">${fmtSigned(gain, true)}</span>${rate}`;
    }

    function rangeReturn(points) {
        let gain = 0;
        let growth = 1;
        let counted = false;
        const opening = openingGain(points);
        if (opening) {
            gain = opening.gain;
            growth = 1 + opening.gain / opening.base;
            counted = true;
        }
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
        const { gain, pct } = rangeReturn(points);
        // The line, its dot and the range buttons go red when the range lost money;
        // with amounts hidden only the percent shows, so it decides instead.
        $('historyCard').classList.toggle('is-down', (privacy ? (pct ?? gain) : gain) < 0);
        if (privacy) {
            els.heroValue.className = `pf-hero__value ${tone(pct)}`;
            showFigure(els.heroValue, fmtPct(pct, true));
            sub.textContent = `Over ${history.range}`;
        } else {
            sub.innerHTML = rangeChangeHtml(gain, pct);
        }

        const notes = [];
        const estimated = points.some((p) => p.estimated);
        const backfilling = (history.data.backfilling || []).length;
        if (backfilling) {
            notes.push(`Fetching older prices for ${plural(backfilling, 'symbol')}…`);
        } else if (pending) {
            notes.push(`Loading prices for ${plural(pending, 'symbol')}…`);
        }
        if (history.data.sampleData) notes.push('Sample prices.');
        note.textContent = notes.join(' ');
        note.hidden = !notes.length;
        $('historyLegend').hidden = !estimated;
        drawChart(points);
    }

    function svg(tag, attrs = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
        return node;
    }

    // Just enough axis to read the chart by: the low, middle and high value on
    // the right, and the first, middle and last date along the bottom.
    // `label` formats a value; the portfolio's dollar labels drop out in
    // privacy mode, a stock's own prices don't.
    function sparseAxes(root, points, { lo, hi, x, y, width, height, pad, label: format = privacy ? null : compactMoney }) {
        // Rounded to two figures of the chart's span, so they read cleanly.
        const step = 10 ** (Math.floor(Math.log10(hi - lo || 1)) - 1);
        const round = (v) => Math.round(v / step) * step;
        const top = round(hi - (hi - lo) * 0.06);
        const bottom = round(lo + (hi - lo) * 0.06);
        if (format) {
            [bottom, round((bottom + top) / 2), top].forEach((v) => {
                root.appendChild(svg('line', { class: 'pf-chart__guide', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
                const label = svg('text', { class: 'pf-chart__axis', x: width - pad.right + 8, y: y(v) + 4 });
                label.textContent = format(v);
                root.appendChild(label);
            });
        }
        const first = new Date(`${points[0].date}T00:00:00Z`);
        const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);
        const long = last - first > 200 * 86400000;
        const fmt = new Intl.DateTimeFormat('en-US', long ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
        const mid = Math.floor((points.length - 1) / 2);
        [[0, 'start'], [mid, 'middle'], [points.length - 1, 'end']].forEach(([i, anchor]) => {
            const label = svg('text', { class: 'pf-chart__axis', x: x(i), y: height - 4, 'text-anchor': anchor });
            label.textContent = fmt.format(new Date(`${points[i].date}T00:00:00Z`));
            root.appendChild(label);
        });
    }

    // The headline line's soft fill, fading to nothing at the chart's floor,
    // and the dot that marks where the line stands now.
    function areaFill(root, line, id, x0, x1, base) {
        const defs = svg('defs');
        const grad = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(svg('stop', { class: 'pf-chart__fill-top', offset: '0' }));
        grad.appendChild(svg('stop', { class: 'pf-chart__fill-end', offset: '1' }));
        defs.appendChild(grad);
        root.appendChild(defs);
        root.appendChild(svg('path', { class: 'pf-chart__area', fill: `url(#${id})`, d: `${line}L${x1.toFixed(1)},${base}L${x0.toFixed(1)},${base}Z` }));
    }

    function endDot(root, cx, cy) {
        root.appendChild(svg('circle', { class: 'pf-chart__halo', cx, cy, r: 9 }));
        root.appendChild(svg('circle', { class: 'pf-chart__end', cx, cy, r: 4 }));
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
    // A chart is drawn to its box, so a box that changes size redraws it.
    function redrawOnResize(id, redraw) {
        new ResizeObserver(([entry]) => {
            const drawn = entry.target.querySelector('svg')?.viewBox.baseVal;
            const { width, height } = entry.contentRect;
            if (drawn && width && (Math.abs(drawn.width - width) > 1 || Math.abs(drawn.height - height) > 1)) redraw();
        }).observe($(id));
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
        // Room on the right for three value labels and below for three dates.
        const pad = { top: 10, right: 46, bottom: 22, left: 4 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;

        const values = points.map((p) => p.value);
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        // A little room above and below the line, and no axis to round to.
        const margin = (hi - lo) * 0.06 || hi * 0.03 || 1;
        lo = Math.max(0, lo - margin);
        hi += margin;

        const x = (i) => pad.left + (i / (points.length - 1)) * innerW;
        const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
        const path = (indices, key) => indices.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(points[i][key]).toFixed(1)}`).join('');

        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Portfolio value from ${points[0].date} to ${points[points.length - 1].date}` });
        sparseAxes(root, points, { lo, hi, x, y, width, height, pad });
        // Private, the tooltip gives the return from the range's start.
        const returns = privacy ? points.map((_, i) => rangeReturn(points.slice(0, i + 1)).pct) : null;

        areaFill(root, path(points.map((_, i) => i), 'value'), 'pfHistoryFill', x(0), x(points.length - 1), pad.top + innerH);
        runs(points, (p) => !p.estimated).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__line', pathLength: 1, d: path(indices, 'value') }));
        });
        runs(points, (p) => p.estimated).forEach((indices) => {
            root.appendChild(svg('path', { class: 'pf-chart__line pf-chart__line--estimated', d: path(indices, 'value') }));
        });

        endDot(root, x(points.length - 1), y(points[points.length - 1].value));
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
            const day = `<span class="pf-bench">${fmtDay(p.date)}${p.estimated ? ' · estimated' : ''}</span>`;
            if (privacy) {
                const r = returns[i] ?? 0;
                scrub.show(fmtPct(r, true), `pf-hero__value ${tone(r)}`, day);
            } else {
                const { gain, pct } = rangeReturn(points.slice(0, i + 1));
                scrub.show(fmtMoney(p.value, true), null, `${rangeChangeHtml(gain, pct)} <span class="pf-dot">·</span>${day}`);
            }
        }
        const scrub = scrubber(els.heroValue, $('historySub'));
        hit.addEventListener('mousemove', hover);
        hit.addEventListener('touchmove', (event) => { hover(event.touches[0]); event.preventDefault(); }, { passive: false });
        const leave = () => {
            cross.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
            scrub.clear();
        };
        hit.addEventListener('mouseleave', leave);
        hit.addEventListener('touchend', leave);
        markFresh(host, root, `${history.range}:${points[0].date}:${points[points.length - 1].date}:${points.length}`);
        host.appendChild(root);
    }

    // ── one holding ────────────────────────────────────────────────────────

    // `signature` is the trades and snapshot the data was loaded against, so
    // a holding reopened after an edit is fetched again.
    const holding = { ticker: null, data: null, range: '1Y', timer: null, retries: 0, signature: null };

    async function loadHolding(ticker, retry = false) {
        clearTimeout(holding.timer);
        if (!ticker) return;
        const signature = lastData ? historySignature(lastData) : null;
        if (!retry) {
            if (holding.ticker === ticker && holding.data && holding.signature === signature) {
                renderHolding();
                return;
            }
            holding.signature = signature;
            holding.ticker = ticker;
            holding.data = null;
            holding.retries = 0;
            $('holdingName').textContent = ticker;
            showFigure($('holdingPrice'), '—');
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
        return fmtPrice(value, true);
    }

    function dividendTile(d) {
        if (!d.dividends?.length) return [];
        const total = d.dividends.reduce((sum, x) => sum + x.amount, 0);
        return [gainTile('Dividends', fmtMoney(total, true), plural(d.dividends.length, 'payment'))];
    }

    function renderHolding() {
        const d = holding.data;
        const pos = d.position;
        const tag = ASSET_TAGS[d.asset] ? ` · ${ASSET_TAGS[d.asset]}` : '';
        $('holdingName').textContent = `${d.ticker}${d.name && d.name !== d.ticker ? ` · ${d.name}` : ''}${tag}`;
        if (d.price == null) showFigure($('holdingPrice'), '—');
        else rollTo($('holdingPrice'), d.price, fmtPrice);

        // Price chart.
        holding.range = renderRanges(d.closes, $('holdingRanges'), holding.range);
        const points = pointsInRange(d.closes, holding.range);
        const sub = $('holdingSub');
        if (points.length < 2) {
            sub.textContent = d.pending ? 'Loading price history…' : d.asset === 'other' ? 'No market price.' : 'No price history yet.';
            $('holdingLegend').hidden = true;
            $('holdingChart').innerHTML = '';
        } else {
            const first = points[0].close;
            const change = points[points.length - 1].close - first;
            $('holdingChart').closest('.pf-hero').classList.toggle('is-down', change < 0);
            sub.innerHTML = `<span class="pf-history-change ${tone(change)}">${privacy ? fmtPct(change / first, true) : `${fmtSigned(change)} (${fmtPct(change / first, true)})`}</span>`;
            const avg = d.open ? pos.avgCost : null;
            const trades = d.trades.filter((t) => t.date >= points[0].date && (t.side === 'buy' || t.side === 'sell'));
            $('holdingLegend').hidden = false;
            $('avgCostKey').hidden = avg == null;
            $('tradeKeys').hidden = !trades.length;
            drawPriceChart(points, avg, trades);
        }
        const notes = [];
        if (d.pending) notes.push('Loading older prices…');
        if (d.sampleData) notes.push('Sample prices.');
        $('holdingNote').textContent = notes.join(' ');
        $('holdingNote').hidden = !notes.length;

        // The position.
        $('holdingTiles').innerHTML = (d.open ? [
            gainTile('Value', fmtMoney(pos.marketValue, true), privacy ? '' : `${fmtShares(pos.shares)} shares`),
            privacy
                ? gainTile('Unrealized', fmtPct(pos.gainPct, true), pos.gainPct == null ? 'No cost basis' : '', tone(pos.gain))
                : gainTile('Unrealized', fmtSigned(pos.gain, true), pos.gainPct == null ? 'No cost basis' : `${fmtPct(pos.gainPct, true)} on ${fmtMoney(pos.costBasis, true)}`, tone(pos.gain)),
            gainTile('Average cost', fmtPrice(pos.avgCost), 'Per share'),
            gainTile('Realized', fmtSigned(pos.realizedGain, true), '', tone(pos.realizedGain)),
            ...dividendTile(d),
        ] : [
            gainTile('Realized', fmtSigned(pos.realizedGain, true), '', tone(pos.realizedGain)),
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
        $('holdingFactsSub').textContent = d.priceAsOf ? `Through ${fmtDay(d.priceAsOf)}` : '';
        const range = $('holdingRange');
        range.hidden = perf.low52w == null || d.price == null || perf.high52w <= perf.low52w;
        if (!range.hidden) {
            const at = Math.min(100, Math.max(0, ((d.price - perf.low52w) / (perf.high52w - perf.low52w)) * 100));
            range.innerHTML = `<div class="pf-range52__label">52-week range</div>
                <div class="pf-range52__track"><div class="pf-range52__fill"></div><span class="pf-range52__mark" style="left:${at}%"></span></div>
                <div class="pf-range52__ends"><span>${fmtPrice(perf.low52w)}</span><span>${fmtPrice(perf.high52w)}</span></div>`;
        }
        const lots = d.lots || [];
        $('holdingLotsCard').hidden = !lots.length;
        $('holdingLots').innerHTML = `${lotHead(false)}<tbody>${lots.map((l) => lotRow(l, false)).join('')}</tbody>`;

        const research = $('holdingResearch');
        research.hidden = d.asset !== 'stock';
        research.href = `/portfolio/research/?ticker=${encodeURIComponent(d.ticker)}`;
        const meta = [...new Set([c.sector, c.industry, c.headquarters, c.employees ? `${countFormat.format(c.employees)} employees` : null].filter(Boolean))];
        // Bitcoin needs no About.
        $('holdingAbout').closest('.pf-card').hidden = d.asset === 'crypto';
        $('holdingAbout').innerHTML = d.asset !== 'stock'
            ? '<p>No market data.</p>'
            : d.company
                ? `${meta.length ? `<p class="pf-about__meta">${meta.map(escapeHtml).join(' · ')}</p>` : ''}
                   <p>${escapeHtml(c.description || 'No description on file.')}</p>
                   ${c.website ? `<p><a class="pf-link" href="${escapeHtml(c.website)}" rel="noopener" target="_blank">${escapeHtml(c.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></p>` : ''}`
                : '<p>No company details yet.</p>';

        // Trades, newest first.
        $('holdingTradesSub').textContent = plural(d.trades.length, 'trade');
        $('holdingTrades').innerHTML = [...d.trades].reverse().map((t) => `
            <tr>
                <td>${fmtDay(t.date)}</td>
                <td><span class="pf-side pf-side--${t.side}">${t.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                <td class="num">${fmtShares(t.shares)}</td>
                <td class="num">${fmtPrice(t.price)}</td>
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
        const pad = { top: 10, right: 46, bottom: 22, left: 4 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;

        const cost = showCost ? avgCost : null;
        const values = points.map((p) => p.close).concat(cost != null ? [cost] : []);
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        // A little room above and below the line, and no axis to round to.
        const margin = (hi - lo) * 0.06 || hi * 0.03 || 1;
        lo = Math.max(0, lo - margin);
        hi += margin;
        const x = (i) => pad.left + (i / (points.length - 1)) * innerW;
        const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
        // A trade sits on the line at the first close on or after its date; its own
        // price can be pre-split or off the close, which left dots floating.
        const indexOf = (iso) => {
            const i = points.findIndex((p) => p.date >= iso);
            return i === -1 ? points.length - 1 : i;
        };

        const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Daily closing price from ${points[0].date} to ${points[points.length - 1].date}` });
        sparseAxes(root, points, {
            lo, hi, x, y, width, height, pad,
            label: (v) => (hi - lo < 20 ? `$${v.toFixed(2)}` : compactMoney(v)),
        });
        const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join('');
        if (cost != null) {
            root.appendChild(svg('line', { class: 'pf-chart__avg', x1: pad.left, x2: width - pad.right, y1: y(cost), y2: y(cost) }));
        }
        areaFill(root, line, 'pfHoldingFill', x(0), x(points.length - 1), pad.top + innerH);
        root.appendChild(svg('path', { class: 'pf-chart__line', pathLength: 1, d: line }));
        endDot(root, x(points.length - 1), y(points[points.length - 1].close));
        trades.forEach((t) => {
            const i = indexOf(t.date);
            root.appendChild(svg('circle', { class: `pf-chart__trade--${t.side}`, cx: x(i), cy: y(points[i].close), r: trades.length > 80 ? 3 : 4.5 }));
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
            const first = points[0].close;
            const change = p.close - first;
            scrub.show(fmtPrice(p.close), null, `<span class="pf-history-change ${tone(change)}">${privacy ? fmtPct(change / first, true) : `${fmtSigned(change)} (${fmtPct(change / first, true)})`}</span> <span class="pf-dot">·</span><span class="pf-bench">${fmtDay(p.date)}</span>`);
        }
        const scrub = scrubber($('holdingPrice'), $('holdingSub'));
        hit.addEventListener('mousemove', hover);
        hit.addEventListener('touchmove', (event) => { hover(event.touches[0]); event.preventDefault(); }, { passive: false });
        const leave = () => {
            cross.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
            scrub.clear();
        };
        hit.addEventListener('mouseleave', leave);
        hit.addEventListener('touchend', leave);
        markFresh(host, root, `${holding.ticker}:${holding.range}:${points[0].date}:${points[points.length - 1].date}:${points.length}`);
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

        const { kind, count, duplicates, removedSample, dividends = 0 } = result.imported;
        const what = kind === 'holdings'
            ? plural(count, 'holding')
            : `${plural(count - dividends, 'trade')}${dividends ? ` and ${plural(dividends, 'dividend')}` : ''}`;
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
        els.fileName.textContent = '';
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

    redrawOnResize('historyChart', () => { if (history.data && currentTab() === 'overview') renderHistory(); });
    redrawOnResize('holdingChart', () => { if (holding.data && currentTab() === 'holding') renderHolding(); });
    $('addDate').value = today();
    els.asOfInput.value = today();
    syncKindOptions();
    load();
})();
