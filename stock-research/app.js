// API_BASE = `${API_ORIGIN}/api`. See /shared/api-base.js for overrides.
const API_BASE = ((typeof window !== 'undefined' && typeof window.API_ORIGIN === 'string')
    ? window.API_ORIGIN
    : '') + '/api';

// ============================================
// FORMATTING
// ============================================

const MINUS = '−';
const DASH = '—';

function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function fmtPrice(value) {
    if (!isNum(value)) return DASH;
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// $3.76T, $560.66B, −$4.26B. Negative values keep the sign in front of the $.
function fmtMoneyCompact(value, digits = 2) {
    if (!isNum(value)) return DASH;
    const sign = value < 0 ? MINUS : '';
    const abs = Math.abs(value);
    if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(digits)}T`;
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(digits)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(digits)}M`;
    return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtCountCompact(value) {
    if (!isNum(value)) return DASH;
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    return value.toLocaleString('en-US');
}

function fmtPct(value, digits = 1) {
    if (!isNum(value)) return DASH;
    return `${value < 0 ? MINUS : ''}${Math.abs(value).toFixed(digits)}%`;
}

function fmtSignedPct(value, digits = 1) {
    if (!isNum(value)) return DASH;
    return `${value >= 0 ? '+' : MINUS}${Math.abs(value).toFixed(digits)}%`;
}

function fmtRatio(value, digits = 2) {
    if (!isNum(value)) return DASH;
    return `${value < 0 ? MINUS : ''}${Math.abs(value).toFixed(digits)}`;
}

function fmtMultiple(value) {
    if (!isNum(value)) return DASH;
    return `${fmtRatio(value, 1)}×`;
}

function pctChange(current, previous) {
    if (!isNum(current) || !isNum(previous) || previous <= 0) return null;
    return ((current - previous) / previous) * 100;
}

function setPill(el, pct, digits = 1) {
    if (!el) return;
    if (!isNum(pct)) {
        el.textContent = '';
        el.className = 'change-pill';
        return;
    }
    el.textContent = fmtSignedPct(pct, digits);
    el.className = 'change-pill ' + (pct >= 0 ? 'positive' : 'negative');
}

function parseDate(value) {
    // Dates arrive as YYYY-MM-DD; parse as local midnight so labels don't
    // shift a day west of UTC.
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function quarterLabel(entry) {
    const date = parseDate(entry.fiscal_date);
    if (!date) return entry.period || '';
    return `Q${Math.floor(date.getMonth() / 3) + 1} '${String(date.getFullYear()).slice(-2)}`;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// ============================================
// CHART THEME
// Charts read the page's CSS tokens so they share one palette with the UI.
// ============================================

function chartTheme() {
    const css = getComputedStyle(document.documentElement);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
        text: token('--text', '#23201c'),
        text2: token('--text-2', '#5d574e'),
        text3: token('--text-3', '#736b5e'),
        card: token('--card', '#ffffff'),
        up: token('--up', '#2e7d4f'),
        down: token('--down', '#b14636'),
        series1: token('--series-1', '#5b7152'),
        series2: token('--series-2', '#5a7794'),
        series3: token('--series-3', '#8a6d8a'),
        series4: token('--series-4', '#b97e35'),
        grid: token('--grid', 'rgba(60, 50, 35, 0.09)'),
        font: token('--font', 'system-ui, sans-serif'),
    };
}

function withAlpha(color, alpha) {
    const hex = color.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Diagonal hatch so "missed" bars differ by pattern, not only by color.
function hatchPattern(color) {
    const size = 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = withAlpha(color, 0.35);
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-2, size + 2);
    ctx.lineTo(size + 2, -2);
    ctx.stroke();
    return ctx.createPattern(canvas, 'repeat');
}

function baseTooltip(theme) {
    return {
        backgroundColor: theme.text,
        titleColor: '#e9e3d8',
        bodyColor: '#ffffff',
        titleFont: { family: theme.font, size: 12, weight: '600' },
        bodyFont: { family: theme.font, size: 13, weight: '700' },
        padding: 10,
        cornerRadius: 8,
        displayColors: false,
        caretSize: 5,
    };
}

function baseScales(theme, { yFormat, beginAtZero = true, yPosition = 'left' } = {}) {
    return {
        x: {
            grid: { display: false },
            border: { color: theme.grid },
            ticks: {
                color: theme.text3,
                font: { family: theme.font, size: 11, weight: '600' },
                maxRotation: 0,
                autoSkip: true,
                autoSkipPadding: 12,
            },
        },
        y: {
            position: yPosition,
            beginAtZero,
            grid: { color: theme.grid },
            border: { display: false },
            ticks: {
                color: theme.text3,
                font: { family: theme.font, size: 11 },
                maxTicksLimit: 5,
                padding: 6,
                callback: yFormat,
            },
        },
    };
}

// Vertical guide line under the active tooltip point.
const crosshairPlugin = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.();
        if (!active || !active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = 'rgba(60, 50, 35, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    },
};

const charts = {};

// Roughly one x label per 80px of plot width, recomputed on resize so
// labels never collide on narrow phones.
function fitXTicks(chart, width) {
    const limit = Math.max(3, Math.min(8, Math.floor(width / 80)));
    const ticks = chart.options.scales?.x?.ticks;
    if (ticks && ticks.maxTicksLimit !== limit) {
        ticks.maxTicksLimit = limit;
        chart.update('none');
    }
}

function mountChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const box = canvas.parentElement;
    box.querySelector('.chart-empty')?.remove();
    canvas.hidden = false;
    if (charts[canvasId]) {
        charts[canvasId].destroy();
        delete charts[canvasId];
    }
    if (typeof Chart === 'undefined') {
        showChartEmpty(canvasId, 'Charts could not load. Check your connection and refresh.');
        return null;
    }
    config.options = config.options || {};
    config.options.onResize = fitXTicks;
    if (config.options.scales?.x?.ticks) {
        config.options.scales.x.ticks.maxTicksLimit = Math.max(3, Math.min(8, Math.floor(box.clientWidth / 80)));
    }
    charts[canvasId] = new Chart(canvas, config);
    return charts[canvasId];
}

function showChartEmpty(canvasId, message) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) {
        charts[canvasId].destroy();
        delete charts[canvasId];
    }
    canvas.hidden = true;
    const box = canvas.parentElement;
    let note = box.querySelector('.chart-empty');
    if (!note) {
        note = document.createElement('p');
        note.className = 'chart-empty';
        box.appendChild(note);
    }
    note.textContent = message;
}

// ============================================
// PRICE CHART
// ============================================

const RANGES = {
    '1M': { days: 31, label: 'past month' },
    '3M': { days: 92, label: 'past 3 months' },
    '6M': { days: 183, label: 'past 6 months' },
    '1Y': { days: 366, label: 'past year' },
    '2Y': { days: 731, label: 'past 2 years' },
};

function sliceRange(prices, rangeKey) {
    if (!prices.length) return prices;
    const last = parseDate(prices[prices.length - 1].date);
    const days = (RANGES[rangeKey] || RANGES['1Y']).days;
    if (!last) return prices.slice(-Math.round(days * 0.69));
    const cutoff = new Date(last);
    cutoff.setDate(cutoff.getDate() - days);
    return prices.filter((row) => {
        const date = parseDate(row.date);
        return date && date > cutoff;
    });
}

function drawPriceChart(allPrices, rangeKey) {
    const rows = sliceRange(allPrices, rangeKey);
    const changeEl = document.getElementById('rangeChange');
    const labelEl = document.getElementById('rangeLabel');

    if (rows.length < 2) {
        if (changeEl) changeEl.textContent = '';
        if (labelEl) labelEl.textContent = '';
        showChartEmpty('priceChart', 'Price history is not available for this ticker.');
        return;
    }

    const theme = chartTheme();
    const closes = rows.map((row) => row.close);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const change = ((last - first) / first) * 100;
    const color = change >= 0 ? theme.up : theme.down;

    if (changeEl) {
        changeEl.textContent = fmtSignedPct(change, 2);
        changeEl.className = 'range-change ' + (change >= 0 ? 'positive' : 'negative');
    }
    if (labelEl) labelEl.textContent = (RANGES[rangeKey] || RANGES['1Y']).label;

    const short = rangeKey === '1M' || rangeKey === '3M';
    const dates = rows.map((row) => parseDate(row.date));
    const tickFormat = new Intl.DateTimeFormat('en-US', short ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' });
    const tooltipFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const scales = baseScales(theme, {
        beginAtZero: false,
        yPosition: 'right',
        yFormat: (value) => '$' + Number(value).toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 2 : 0 }),
    });
    scales.x.ticks.callback = function (value, index) {
        const date = dates[index];
        if (!date) return '';
        const text = tickFormat.format(date);
        return short ? text : text.replace(' ', " '");
    };
    scales.y.grace = '6%';

    mountChart('priceChart', {
        type: 'line',
        data: {
            labels: rows.map((row) => row.date),
            datasets: [{
                data: closes,
                borderColor: color,
                borderWidth: 2,
                fill: true,
                backgroundColor(context) {
                    const { ctx, chartArea } = context.chart;
                    if (!chartArea) return withAlpha(color, 0.08);
                    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                    gradient.addColorStop(0, withAlpha(color, 0.18));
                    gradient.addColorStop(1, withAlpha(color, 0));
                    return gradient;
                },
                tension: 0.25,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: color,
                pointHoverBorderColor: theme.card,
                pointHoverBorderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 350 },
            interaction: { intersect: false, mode: 'index' },
            layout: { padding: { top: 4 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    callbacks: {
                        title: (items) => {
                            const date = dates[items[0].dataIndex];
                            return date ? tooltipFormat.format(date) : '';
                        },
                        label: (item) => fmtPrice(item.parsed.y),
                    },
                },
            },
            scales,
        },
        plugins: [crosshairPlugin],
    });
}

function renderRangeBar(prices, currentPrice) {
    const bar = document.getElementById('rangeBar');
    if (!bar) return;
    const year = sliceRange(prices, '1Y');
    if (year.length < 2 || !isNum(currentPrice)) {
        bar.hidden = true;
        return;
    }
    const low = Math.min(...year.map((row) => (isNum(row.low) ? row.low : row.close)));
    const high = Math.max(...year.map((row) => (isNum(row.high) ? row.high : row.close)));
    setText('low52', fmtPrice(low));
    setText('high52', fmtPrice(high));
    const position = high > low ? Math.min(Math.max((currentPrice - low) / (high - low), 0), 1) : 0.5;
    const marker = document.getElementById('rangeMarker');
    if (marker) marker.style.left = `${(position * 100).toFixed(1)}%`;
    bar.hidden = false;
}

// ============================================
// FUNDAMENTALS CHARTS
// ============================================

function drawEPSChart(quarters) {
    const rows = quarters.filter((q) => isNum(q.reported_eps));
    const summaryEl = document.getElementById('beatSummary');
    if (!rows.length) {
        if (summaryEl) summaryEl.textContent = '';
        showChartEmpty('epsChart', 'No earnings history for this ticker.');
        return;
    }

    const theme = chartTheme();
    const missFill = hatchPattern(theme.down);
    const outcomes = rows.map((q) => {
        if (!isNum(q.estimated_eps) || q.estimated_eps === 0) return null;
        return ((q.reported_eps - q.estimated_eps) / Math.abs(q.estimated_eps)) * 100;
    });
    const rated = outcomes.filter(isNum);
    const beats = rated.filter((value) => value >= 0).length;
    if (summaryEl) {
        summaryEl.textContent = rated.length
            ? `Beat estimates in ${beats} of the last ${rated.length} quarters.`
            : '';
    }

    mountChart('epsChart', {
        data: {
            labels: rows.map(quarterLabel),
            datasets: [
                {
                    type: 'bar',
                    label: 'EPS',
                    data: rows.map((q) => q.reported_eps),
                    backgroundColor: outcomes.map((value) => (!isNum(value) ? theme.series1 : value >= 0 ? theme.up : missFill)),
                    borderColor: outcomes.map((value) => (!isNum(value) ? theme.series1 : value >= 0 ? theme.up : theme.down)),
                    borderWidth: outcomes.map((value) => (isNum(value) && value < 0 ? 1.5 : 0)),
                    borderRadius: 4,
                    maxBarThickness: 36,
                    order: 2,
                },
                {
                    type: 'line',
                    label: 'Estimate',
                    data: rows.map((q) => (isNum(q.estimated_eps) ? q.estimated_eps : null)),
                    borderColor: theme.text,
                    backgroundColor: theme.card,
                    borderWidth: 2,
                    pointRadius: 3.5,
                    pointBorderWidth: 2,
                    pointHoverRadius: 5,
                    tension: 0,
                    order: 1,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    callbacks: {
                        label: (item) => `${item.dataset.label} ${fmtPrice(item.parsed.y)}`,
                        footer: (items) => {
                            const value = outcomes[items[0].dataIndex];
                            if (!isNum(value)) return '';
                            return value >= 0 ? `Beat by ${fmtPct(value)}` : `Missed by ${fmtPct(-value)}`;
                        },
                    },
                    footerFont: { family: theme.font, size: 12, weight: '600' },
                    footerColor: '#e9e3d8',
                },
            },
            scales: baseScales(theme, { yFormat: (value) => fmtPrice(value) }),
        },
    });
}

function drawQuarterBars(canvasId, quarters, field, color, emptyMessage) {
    const rows = quarters.filter((q) => isNum(q[field]));
    if (!rows.length) {
        showChartEmpty(canvasId, emptyMessage);
        return;
    }
    const theme = chartTheme();
    const values = rows.map((q) => q[field]);
    const yearAgo = (index) => {
        const target = parseDate(rows[index].fiscal_date);
        if (!target) return null;
        const match = rows.find((q) => {
            const date = parseDate(q.fiscal_date);
            return date && Math.abs((target - date) / 86400000 - 365) < 20;
        });
        return match ? match[field] : null;
    };

    mountChart(canvasId, {
        type: 'bar',
        data: {
            labels: rows.map(quarterLabel),
            datasets: [{
                data: values,
                backgroundColor: values.map((value) => (value < 0 ? theme.down : color)),
                borderRadius: 4,
                maxBarThickness: 36,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    callbacks: {
                        label: (item) => fmtMoneyCompact(item.parsed.y),
                        footer: (items) => {
                            const change = pctChange(values[items[0].dataIndex], yearAgo(items[0].dataIndex));
                            return isNum(change) ? `${fmtSignedPct(change)} vs. a year earlier` : '';
                        },
                    },
                    footerFont: { family: theme.font, size: 12, weight: '600' },
                    footerColor: '#e9e3d8',
                },
            },
            scales: baseScales(theme, { yFormat: (value) => fmtMoneyCompact(value, 0) }),
        },
    });
}

// Trailing P/E at each quarter end: close on (or just before) the quarter
// end divided by the sum of the four quarters' EPS ending there.
function trailingPE(quarters, prices, currentPrice, currentPE) {
    const points = [];
    const sortedPrices = prices.filter((row) => isNum(row.close));

    function closeOnOrBefore(date) {
        let found = null;
        for (const row of sortedPrices) {
            const rowDate = parseDate(row.date);
            if (!rowDate) continue;
            if (rowDate > date) break;
            found = { close: row.close, date: rowDate };
        }
        if (!found) return null;
        // Ignore a match more than a week stale (gap in the price history)
        return (date - found.date) / 86400000 <= 7 ? found.close : null;
    }

    for (let i = 3; i < quarters.length; i++) {
        const window4 = quarters.slice(i - 3, i + 1).map((q) => q.reported_eps);
        if (!window4.every(isNum)) continue;
        const ttm = window4.reduce((sum, value) => sum + value, 0);
        if (ttm <= 0) continue;
        const date = parseDate(quarters[i].fiscal_date);
        const close = date ? closeOnOrBefore(date) : null;
        if (!isNum(close)) continue;
        points.push({ label: quarterLabel(quarters[i]), pe: close / ttm });
    }

    const latest = quarters.slice(-4).map((q) => q.reported_eps);
    let nowPE = isNum(currentPE) ? currentPE : null;
    if (nowPE == null && latest.length === 4 && latest.every(isNum) && isNum(currentPrice)) {
        const ttm = latest.reduce((sum, value) => sum + value, 0);
        if (ttm > 0) nowPE = currentPrice / ttm;
    }
    if (isNum(nowPE)) points.push({ label: 'Now', pe: nowPE });
    return points;
}

function drawPEChart(points) {
    if (points.length < 2) {
        showChartEmpty('peChart', 'Not enough earnings and price history to chart P/E.');
        return;
    }
    const theme = chartTheme();
    const benchmark = 22;

    mountChart('peChart', {
        type: 'line',
        data: {
            labels: points.map((point) => point.label),
            datasets: [
                {
                    label: 'Trailing P/E',
                    data: points.map((point) => point.pe),
                    borderColor: theme.series3,
                    backgroundColor: withAlpha(theme.series3, 0.12),
                    fill: 'origin',
                    borderWidth: 2.5,
                    pointRadius: 3.5,
                    pointBackgroundColor: theme.card,
                    pointBorderColor: theme.series3,
                    pointBorderWidth: 2,
                    tension: 0.2,
                },
                {
                    label: 'S&P 500 average',
                    data: points.map(() => benchmark),
                    borderColor: theme.series4,
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    filter: (item) => item.datasetIndex === 0,
                    callbacks: {
                        label: (item) => `P/E ${item.parsed.y.toFixed(1)}`,
                        footer: (items) => {
                            const ratio = items[0].parsed.y / benchmark;
                            return ratio >= 1
                                ? `${ratio.toFixed(1)}× the S&P 500 average`
                                : `Below the S&P 500 average`;
                        },
                    },
                    footerFont: { family: theme.font, size: 12, weight: '600' },
                    footerColor: '#e9e3d8',
                },
            },
            scales: baseScales(theme, { yFormat: (value) => `${value}×` }),
        },
    });
}

// ============================================
// PAGE
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    const searchModal = $('searchModal');
    const searchForm = $('searchForm');
    const tickerInput = $('tickerInput');
    const searchSuggestions = $('searchSuggestions');
    const loading = $('loading');
    const error = $('error');
    const errorMessage = $('errorMessage');
    const retryBtn = $('retryBtn');
    const retryCountdown = $('retryCountdown');
    const empty = $('empty');
    const results = $('results');
    const demoBanner = $('demoBanner');
    const headerLogo = $('headerLogo');
    const headerQuote = $('headerStockContent');

    if (!searchForm || !tickerInput) return;

    const TAB_IDS = ['overview', 'fundamentals', 'about'];
    const RANGE_KEY = 'stock-research-range';

    let currentTicker = '';
    let loadToken = 0;
    let retryTimer = null;
    let activeTab = 'overview';
    let currentRange = readStoredRange();
    let lastData = null;
    let lastPrices = [];
    let lastQuarters = [];
    let fundamentalsDirty = false;

    function readStoredRange() {
        try {
            const stored = localStorage.getItem(RANGE_KEY);
            return RANGES[stored] ? stored : '1Y';
        } catch {
            return '1Y';
        }
    }

    // ---------- Demo note ----------

    function setDemoMode(isDemo) {
        if (!demoBanner) return;
        if (!isDemo) {
            demoBanner.classList.add('hidden');
            return;
        }
        const link = document.createElement('a');
        link.href = `/login/?next=${encodeURIComponent(location.pathname + location.search)}`;
        link.textContent = 'Sign in';
        demoBanner.replaceChildren(
            document.createTextNode('Sample data: these values are generated for the public demo. '),
            link,
            document.createTextNode(' for live prices.'),
        );
        demoBanner.classList.remove('hidden');
    }

    // ---------- Search sheet ----------

    let lastFocus = null;
    let suggestionSeq = 0;
    let searchTimeout = null;
    let suggestions = [];
    let selectedIndex = -1;

    function openSearch() {
        lastFocus = document.activeElement;
        searchModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        tickerInput.value = '';
        hideSuggestions();
        // Focus inside the click handler so mobile browsers raise the keyboard.
        tickerInput.focus();
    }

    function closeSearch({ restoreFocus = true } = {}) {
        if (searchModal.classList.contains('hidden')) return;
        searchModal.classList.add('hidden');
        document.body.style.overflow = '';
        clearTimeout(searchTimeout);
        suggestionSeq++;
        hideSuggestions();
        tickerInput.value = '';
        if (restoreFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }

    function hideSuggestions() {
        suggestions = [];
        selectedIndex = -1;
        searchSuggestions.classList.add('hidden');
        searchSuggestions.replaceChildren();
        tickerInput.removeAttribute('aria-activedescendant');
    }

    async function fetchSuggestions(query) {
        const seq = ++suggestionSeq;
        if (!query) {
            hideSuggestions();
            return;
        }
        try {
            const response = await fetch(`${API_BASE}/stocks/search?q=${encodeURIComponent(query)}&limit=8`, {
                credentials: 'include',
            });
            if (!response.ok || seq !== suggestionSeq) return;
            const data = await response.json();
            if (seq !== suggestionSeq) return;
            renderSuggestions(data.results || []);
        } catch (err) {
            console.error('Error fetching suggestions:', err);
        }
    }

    function renderSuggestions(items) {
        suggestions = items;
        selectedIndex = -1;
        if (!items.length) {
            hideSuggestions();
            return;
        }
        searchSuggestions.replaceChildren(...items.map((item, index) => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            row.id = `suggestion-${index}`;
            row.setAttribute('role', 'option');
            row.dataset.ticker = item.ticker || '';

            const main = document.createElement('div');
            main.className = 'suggestion-main';
            const ticker = document.createElement('span');
            ticker.className = 'suggestion-ticker';
            ticker.textContent = item.ticker || '';
            const name = document.createElement('span');
            name.className = 'suggestion-name';
            name.textContent = item.name || '';
            main.append(ticker, name);
            row.append(main);

            if (item.sector) {
                const sector = document.createElement('span');
                sector.className = 'suggestion-sector';
                sector.textContent = item.sector;
                row.append(sector);
            }
            return row;
        }));
        searchSuggestions.classList.remove('hidden');
    }

    function updateSelection() {
        searchSuggestions.querySelectorAll('.suggestion-item').forEach((row, index) => {
            const selected = index === selectedIndex;
            row.classList.toggle('active', selected);
            row.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (selected) {
                tickerInput.setAttribute('aria-activedescendant', row.id);
                row.scrollIntoView({ block: 'nearest' });
            }
        });
        if (selectedIndex < 0) tickerInput.removeAttribute('aria-activedescendant');
    }

    // Every way of picking a ticker from search ends here, so the sheet
    // always closes and analytics always fire.
    function chooseTicker(raw) {
        const ticker = (raw || '').trim().toUpperCase();
        if (!ticker) return;
        closeSearch({ restoreFocus: false });
        if (ticker === 'SHELBY') {
            showShelbyEasterEgg();
            return;
        }
        window.pgAnalytics?.track?.('stock_ticker_searched', { ticker });
        loadStock(ticker);
    }

    tickerInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = tickerInput.value.trim();
        searchTimeout = setTimeout(() => fetchSuggestions(query), 150);
    });

    tickerInput.addEventListener('keydown', (event) => {
        if (!suggestions.length) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
            updateSelection();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelection();
        } else if (event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            chooseTicker(suggestions[selectedIndex].ticker);
        }
        // A plain Enter falls through to the form's submit handler.
    });

    searchSuggestions.addEventListener('click', (event) => {
        const row = event.target.closest('.suggestion-item');
        if (row) chooseTicker(row.dataset.ticker);
    });

    searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        chooseTicker(tickerInput.value);
    });

    $('closeSearchModal')?.addEventListener('click', () => closeSearch());
    searchModal.querySelector('.search-modal-backdrop')?.addEventListener('click', () => closeSearch());
    $('searchIconBtnMain')?.addEventListener('click', openSearch);
    $('searchIconBtnInline')?.addEventListener('click', openSearch);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !searchModal.classList.contains('hidden')) {
            closeSearch();
        } else if (event.key === '/' && searchModal.classList.contains('hidden')
            && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
            event.preventDefault();
            openSearch();
        }
    });

    // ---------- Landing ----------

    // Popular tiles and watchlist rows share one delegated handler.
    empty.addEventListener('click', (event) => {
        const target = event.target.closest('[data-ticker]');
        if (target && empty.contains(target)) loadStock(target.dataset.ticker);
    });

    function showLanding() {
        loadToken++;
        clearRetry();
        currentTicker = '';
        lastData = null;
        loading.classList.add('hidden');
        error.classList.add('hidden');
        results.classList.add('hidden');
        empty.classList.remove('hidden');
        headerQuote.classList.add('hidden');
        headerLogo.classList.remove('hidden');
        setDemoMode(false);
        document.title = 'Stock Research';
        window.Watchlist?.render?.();
        window.scrollTo(0, 0);
    }

    function goBack() {
        if (history.state && history.state.fromLanding) {
            history.back();
        } else {
            history.replaceState(null, '', location.pathname);
            showLanding();
        }
    }

    $('backBtn')?.addEventListener('click', goBack);
    $('errorBackBtn')?.addEventListener('click', goBack);

    window.addEventListener('popstate', () => {
        const params = new URLSearchParams(location.search);
        const ticker = params.get('ticker')?.trim().toUpperCase();
        if (ticker) {
            activeTab = TAB_IDS.includes(params.get('tab')) ? params.get('tab') : 'overview';
            loadStock(ticker, { push: false });
        } else {
            showLanding();
        }
    });

    // ---------- Tabs ----------

    const tabButtons = [...document.querySelectorAll('.tab[role="tab"]')];

    function switchTab(tabId, { focus = false, updateUrl = true } = {}) {
        if (!TAB_IDS.includes(tabId)) tabId = 'overview';
        activeTab = tabId;
        tabButtons.forEach((button) => {
            const selected = button.dataset.tab === tabId;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.tabIndex = selected ? 0 : -1;
            if (selected && focus) button.focus();
        });
        TAB_IDS.forEach((id) => {
            const panel = $(id);
            if (panel) panel.hidden = id !== tabId;
        });
        if (tabId === 'fundamentals' && fundamentalsDirty) renderFundamentals();
        if (updateUrl && currentTicker) {
            const params = new URLSearchParams(location.search);
            if (tabId === 'overview') params.delete('tab');
            else params.set('tab', tabId);
            history.replaceState(history.state, '', `${location.pathname}?${params}`);
        }
    }

    tabButtons.forEach((button, index) => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
        button.addEventListener('keydown', (event) => {
            let next = null;
            if (event.key === 'ArrowRight') next = (index + 1) % tabButtons.length;
            else if (event.key === 'ArrowLeft') next = (index - 1 + tabButtons.length) % tabButtons.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabButtons.length - 1;
            if (next === null) return;
            event.preventDefault();
            switchTab(tabButtons[next].dataset.tab, { focus: true });
        });
    });

    // ---------- Range control ----------

    const rangeButtons = [...document.querySelectorAll('#rangeControl [data-range]')];

    function syncRangeButtons() {
        rangeButtons.forEach((button) => {
            button.setAttribute('aria-pressed', button.dataset.range === currentRange ? 'true' : 'false');
        });
    }

    rangeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            currentRange = button.dataset.range;
            try { localStorage.setItem(RANGE_KEY, currentRange); } catch { /* storage unavailable */ }
            syncRangeButtons();
            if (lastPrices.length) drawPriceChart(lastPrices, currentRange);
        });
    });
    syncRangeButtons();

    // ---------- Metric explanations ----------

    document.querySelectorAll('.metric-group').forEach((group) => {
        const explain = group.querySelector('.metric-explain');
        const defaultText = explain ? explain.textContent : '';
        group.querySelectorAll('.metric').forEach((metric) => {
            metric.setAttribute('aria-pressed', 'false');
            metric.addEventListener('click', () => {
                const wasOn = metric.getAttribute('aria-pressed') === 'true';
                group.querySelectorAll('.metric').forEach((m) => m.setAttribute('aria-pressed', 'false'));
                if (!explain) return;
                if (wasOn) {
                    explain.textContent = defaultText;
                    return;
                }
                metric.setAttribute('aria-pressed', 'true');
                const title = document.createElement('strong');
                title.textContent = metric.querySelector('.metric-label')?.textContent || '';
                explain.replaceChildren(title, document.createTextNode(`: ${metric.dataset.desc}`));
            });
        });
    });

    // ---------- Loading ----------

    function clearRetry() {
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
        }
        retryCountdown.classList.add('hidden');
    }

    function showLoadingFor(ticker) {
        headerLogo.classList.add('hidden');
        headerQuote.classList.remove('hidden');
        setText('headerStockTicker', ticker);
        setText('headerStockName', '');
        setText('headerStockPrice', '');
        setPill($('headerStockChange'), null);
        const watchBtn = $('watchlistBtn');
        if (watchBtn) watchBtn.hidden = true;
        empty.classList.add('hidden');
        error.classList.add('hidden');
        results.classList.add('hidden');
        loading.classList.remove('hidden');
    }

    async function fetchJSON(url) {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            const err = new Error(typeof body.detail === 'string' ? body.detail : `Server error: ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return response.json();
    }

    async function loadStock(rawTicker, { push = true, attempt = 1, refresh = false } = {}) {
        const ticker = String(rawTicker || '').trim().toUpperCase();
        if (!ticker) return;
        const token = ++loadToken;
        clearRetry();

        if (attempt === 1 && push) {
            const params = new URLSearchParams({ ticker });
            if (activeTab !== 'overview' && ticker === currentTicker) params.set('tab', activeTab);
            const url = `${location.pathname}?${params}`;
            if (currentTicker) history.replaceState({ fromLanding: history.state?.fromLanding }, '', url);
            else history.pushState({ fromLanding: true }, '', url);
        }
        if (ticker !== currentTicker && push) activeTab = 'overview';
        currentTicker = ticker;
        showLoadingFor(ticker);
        window.scrollTo(0, 0);

        try {
            const encoded = encodeURIComponent(ticker);
            const [data, priceData] = await Promise.all([
                fetchJSON(`${API_BASE}/stocks/${encoded}?refresh=${refresh}`),
                fetchJSON(`${API_BASE}/stocks/${encoded}/prices?days=730`).catch((err) => {
                    console.warn('Price history unavailable:', err.message);
                    return null;
                }),
            ]);
            if (token !== loadToken) return;
            if (!data || !data.summary) throw new Error('The server sent an unexpected response.');

            displayResults(data, priceData?.prices || []);
            window.pgAnalytics?.track?.('stock_ticker_loaded', { ticker, demo: Boolean(data._demo), attempt });
        } catch (err) {
            if (token !== loadToken) return;
            console.error('Error loading stock:', err);
            showError(ticker, err, attempt, refresh);
        }
    }

    function showError(ticker, err, attempt, refresh) {
        loading.classList.add('hidden');
        error.classList.remove('hidden');

        let message = err.message || 'Something went wrong.';
        if (err.status === 404) message = `We couldn't find "${ticker}". Check the symbol and try again.`;
        else if (/Failed to fetch|NetworkError/i.test(message)) message = 'Network error. Check your connection and try again.';
        errorMessage.textContent = message;

        // Retry transient failures automatically; a missing ticker won't fix itself.
        const retryable = err.status !== 404 && err.status !== 400;
        if (retryable && attempt < 3) {
            let seconds = 3;
            const countdown = retryCountdown.querySelector('.countdown-seconds');
            countdown.textContent = seconds;
            retryCountdown.classList.remove('hidden');
            retryTimer = setInterval(() => {
                seconds--;
                countdown.textContent = seconds;
                if (seconds <= 0) {
                    clearRetry();
                    loadStock(ticker, { push: false, attempt: attempt + 1, refresh });
                }
            }, 1000);
        } else {
            window.pgAnalytics?.track?.('stock_ticker_failed', { ticker, message: err.message, attempt });
        }
    }

    retryBtn.addEventListener('click', () => {
        if (currentTicker) loadStock(currentTicker, { push: false });
    });

    // ---------- Rendering ----------

    function displayResults(data, prices) {
        const summary = data.summary || {};
        lastData = data;
        lastPrices = prices
            .filter((row) => row && row.date && isNum(row.close))
            .sort((a, b) => (a.date < b.date ? -1 : 1));
        lastQuarters = [...(data.earnings || [])]
            .filter((q) => q && q.fiscal_date)
            .sort((a, b) => (a.fiscal_date < b.fiscal_date ? -1 : 1))
            .slice(-8);

        setDemoMode(Boolean(data._demo));
        loading.classList.add('hidden');
        error.classList.add('hidden');
        results.classList.remove('hidden');

        const ticker = data.ticker || currentTicker;
        const name = data.name || summary.name || '';
        document.title = `${ticker}${name ? ` · ${name}` : ''} · Stock Research`;

        // Header quote
        const lastClose = lastPrices.length ? lastPrices[lastPrices.length - 1].close : null;
        const price = isNum(summary.current_price) ? summary.current_price : lastClose;
        let dayChange = null;
        if (lastPrices.length >= 2) {
            dayChange = pctChange(lastClose, lastPrices[lastPrices.length - 2].close);
        }
        setText('headerStockTicker', ticker);
        setText('headerStockName', name);
        setText('headerStockPrice', fmtPrice(price));
        setPill($('headerStockChange'), dayChange, 2);

        if (window.Watchlist && ticker) {
            window.Watchlist.touchSnapshot(ticker, { name, price: price ?? null, changePercent: dayChange });
            window.Watchlist.syncToggleButton();
        }

        renderOverview(summary, price);
        renderFundamentalMetrics(summary);
        renderAbout(data, summary, price);

        fundamentalsDirty = true;
        switchTab(activeTab, { updateUrl: false });
        drawPriceChart(lastPrices, currentRange);
    }

    function trailingSums(field) {
        // lastQuarters is oldest -> newest
        const recent = lastQuarters.slice(-4).map((q) => q[field]);
        const prior = lastQuarters.slice(-8, -4).map((q) => q[field]);
        const sum = (values) => (values.length === 4 && values.every(isNum) ? values.reduce((a, b) => a + b, 0) : null);
        return { current: sum(recent), previous: sum(prior) };
    }

    function renderOverview(summary, price) {
        renderRangeBar(lastPrices, price);

        const revenue = trailingSums('revenue');
        const fcf = trailingSums('free_cash_flow');
        const eps = trailingSums('reported_eps');
        const shares = isNum(summary.shares_outstanding) ? summary.shares_outstanding : null;
        const earnings = {
            current: isNum(eps.current) && shares ? eps.current * shares : null,
            previous: isNum(eps.previous) && shares ? eps.previous * shares : null,
        };

        let pe = isNum(summary.pe_ratio) ? summary.pe_ratio : null;
        if (pe == null && isNum(price) && isNum(eps.current) && eps.current > 0) pe = price / eps.current;

        setText('marketCap', fmtMoneyCompact(summary.market_cap));
        setText('peRatio', isNum(pe) ? pe.toFixed(1) : DASH);
        setText('ttmRevenue', fmtMoneyCompact(revenue.current));
        setPill($('ttmRevenueChange'), pctChange(revenue.current, revenue.previous));
        setText('ttmEarnings', fmtMoneyCompact(earnings.current));
        setPill($('ttmEarningsChange'), pctChange(earnings.current, earnings.previous));
        setText('ttmFCF', fmtMoneyCompact(fcf.current));
        setPill($('ttmFCFChange'), pctChange(fcf.current, fcf.previous));
        setText('ttmEPS', fmtPrice(eps.current));
        setPill($('ttmEPSChange'), pctChange(eps.current, eps.previous));
    }

    function renderFundamentalMetrics(summary) {
        setText('grossMargin', fmtPct(summary.gross_margin));
        setText('ebitdaMargin', fmtPct(summary.ebitda_margin));
        setText('roa', fmtPct(summary.roa));
        setText('roic', fmtPct(summary.roic));

        setText('currentRatio', fmtRatio(summary.current_ratio));
        setText('quickRatio', fmtRatio(summary.quick_ratio));
        setText('interestCoverage', fmtMultiple(summary.interest_coverage));
        setText('cash', fmtMoneyCompact(summary.cash));
        setText('workingCapital', fmtMoneyCompact(summary.working_capital));

        setText('psRatio', fmtMultiple(summary.ps_ratio));
        setText('pbRatio', fmtMultiple(summary.pb_ratio));
        setText('evebitda', fmtMultiple(summary.ev_ebitda));
        setText('enterpriseValue', fmtMoneyCompact(summary.enterprise_value));
        setText('sharesOutstanding', fmtCountCompact(summary.shares_outstanding));

        // Reset any open explanation from the previous ticker
        document.querySelectorAll('.metric-group .metric[aria-pressed="true"]').forEach((metric) => metric.click());
    }

    function renderFundamentals() {
        if (!lastData) return;
        fundamentalsDirty = false;
        const theme = chartTheme();
        const summary = lastData.summary || {};
        const price = isNum(summary.current_price) ? summary.current_price : lastPrices[lastPrices.length - 1]?.close;
        drawEPSChart(lastQuarters);
        drawQuarterBars('revenueChart', lastQuarters, 'revenue', theme.series1, 'No revenue history for this ticker.');
        drawQuarterBars('fcfChart', lastQuarters, 'free_cash_flow', theme.series2, 'No free cash flow history for this ticker.');
        drawPEChart(trailingPE(lastQuarters, lastPrices, price, summary.pe_ratio));
    }

    function renderAbout(data, summary, price) {
        const name = data.name || summary.name || data.ticker;
        const parts = [];
        if (isNum(price)) parts.push(`trades around ${fmtPrice(price)}`);
        if (isNum(summary.market_cap)) parts.push(`has a market cap of ${fmtMoneyCompact(summary.market_cap)}`);
        setText('companyDescription', data.description
            || (parts.length ? `${name} (${data.ticker}) ${parts.join(' and ')}.` : `${name} (${data.ticker}) is a publicly traded company.`));

        const clean = (value) => (value && value !== '-' ? value : DASH);
        setText('companyIndustry', clean(data.industry));
        setText('companySector', clean(data.sector));
        setText('companyEmployees', isNum(data.employees) ? data.employees.toLocaleString('en-US') : DASH);
        setText('companyFounded', clean(data.founded || data.list_date));
        setText('companyHQ', clean(data.hq || data.headquarters));

        const website = $('companyWebsite');
        if (website) {
            if (data.website) {
                website.textContent = data.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
                website.href = data.website;
                website.removeAttribute('aria-disabled');
            } else {
                website.textContent = DASH;
                website.removeAttribute('href');
                website.setAttribute('aria-disabled', 'true');
            }
        }
    }

    // ---------- Start ----------

    window.loadStock = (ticker) => loadStock(ticker);

    if (typeof Chart !== 'undefined') {
        const theme = chartTheme();
        Chart.defaults.font.family = theme.font;
        Chart.defaults.color = theme.text3;
    }

    const params = new URLSearchParams(location.search);
    const initialTicker = params.get('ticker')?.trim().toUpperCase();
    if (initialTicker) {
        activeTab = TAB_IDS.includes(params.get('tab')) ? params.get('tab') : 'overview';
        loadStock(initialTicker, { push: false });
    }

    // ============================================
    // SHELBY EASTER EGG
    // ============================================
    function showShelbyEasterEgg() {
        const overlay = document.getElementById('shelbyOverlay');
        const canvas = document.getElementById('shelbyCanvas');
        const message = document.getElementById('shelbyMessage');
        const heartsContainer = document.getElementById('shelbyHearts');
        const hint = document.querySelector('.shelby-hint');
        
        if (!overlay || !canvas) return;

        let heartInterval = null;

        // Show overlay
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('visible'), 10);
        
        // Setup canvas
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        // Heart drawing animation - positioned below the text
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2 + 80; // Moved down to make room for text
        const size = Math.min(canvas.width, canvas.height) * 0.22; // Slightly smaller
        
        let progress = 0;
        const duration = 3000; // 3 seconds to draw
        const startTime = performance.now();
        let heartsStarted = false;
        
        function drawHeart(p) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw heart path with sparkle
            ctx.beginPath();
            ctx.strokeStyle = '#ff1744';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#ff1744';
            
            // Heart shape using parametric equations
            const points = [];
            const totalPoints = 200;
            const drawPoints = Math.floor(totalPoints * p);
            
            for (let i = 0; i <= drawPoints; i++) {
                const t = (i / totalPoints) * Math.PI * 2;
                const x = centerX + size * (16 * Math.pow(Math.sin(t), 3)) / 16;
                const y = centerY - size * (13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t)) / 16;
                points.push({x, y});
            }
            
            if (points.length > 1) {
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }
                ctx.stroke();
                
                // Add sparkle at the end
                if (points.length > 5) {
                    const last = points[points.length - 1];
                    ctx.shadowBlur = 30;
                    ctx.fillStyle = '#3b82f6';
                    ctx.beginPath();
                    ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            
            // Add glow effect
            if (p > 0.8) {
                ctx.globalAlpha = (p - 0.8) * 5;
                ctx.fillStyle = '#ff1744';
                ctx.beginPath();
                for (let i = 0; i < points.length; i++) {
                    const t = (i / totalPoints) * Math.PI * 2;
                    const x = centerX + size * 0.9 * (16 * Math.pow(Math.sin(t), 3)) / 16;
                    const y = centerY - size * 0.9 * (13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t)) / 16;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        
        function animate(currentTime) {
            const elapsed = currentTime - startTime;
            progress = Math.min(elapsed / duration, 1);
            
            drawHeart(progress);
            
            // Start hearts early (at 30% progress)
            if (progress > 0.3 && !heartsStarted) {
                heartsStarted = true;
                startFloatingHearts();
            }
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Show message when heart is complete
                message.classList.add('visible');
                // Show hint
                setTimeout(() => hint.classList.add('visible'), 2000);
            }
        }
        
        requestAnimationFrame(animate);
        
        // Floating hearts
        function startFloatingHearts() {
            const heartEmojis = ['❤️', '💕', '💗', '💖', '💝'];
            
            function createHeart() {
                const heart = document.createElement('div');
                heart.className = 'shelby-heart';
                heart.textContent = heartEmojis[Math.floor(Math.random() * heartEmojis.length)];
                heart.style.left = Math.random() * 100 + '%';
                heart.style.fontSize = (16 + Math.random() * 24) + 'px';
                heart.style.animationDuration = (3 + Math.random() * 3) + 's';
                heart.style.animationDelay = Math.random() * 2 + 's';
                heartsContainer.appendChild(heart);
                
                // Remove after animation
                setTimeout(() => heart.remove(), 7000);
            }
            
            // Create hearts continuously. Keep the id in the closure so the
            // close handler can clear it reliably — storing it on dataset
            // round-trips through a string and parseInt(NaN) silently leaks
            // the interval if the value is lost or replaced.
            heartInterval = setInterval(createHeart, 300);
        }
        
        // Click to close
        function closeOverlay() {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay.classList.add('hidden');
                message.classList.remove('visible');
                hint.classList.remove('visible');
                heartsContainer.innerHTML = '';
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (heartInterval !== null) {
                    clearInterval(heartInterval);
                    heartInterval = null;
                }
            }, 1000);
            overlay.removeEventListener('click', closeOverlay);
            overlay.removeEventListener('touchstart', closeOverlay);
        }
        
        setTimeout(() => {
            overlay.addEventListener('click', closeOverlay);
            overlay.addEventListener('touchstart', closeOverlay);
        }, 4000); // Allow close after animation
    }
});
