// Overview tab: mobile-first metrics visualization.
// Renders a scrubbable price hero, 52-week range meter, TTM stat tiles with
// quarterly mini-bars, an earnings beat/miss dot plot, margin bars and a
// valuation snapshot. All charts are hand-built SVG sized to their container.
(function () {
    if (window.StockOverview) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const RANGES = [
        { key: '1M', label: '1M', days: 31 },
        { key: '3M', label: '3M', days: 92 },
        { key: '6M', label: '6M', days: 183 },
        { key: 'YTD', label: 'YTD' },
        { key: '1Y', label: '1Y', days: 366 }
    ];
    const RANGE_PHRASE = { '1M': 'past month', '3M': 'past 3 months', '6M': 'past 6 months', YTD: 'year to date', '1Y': 'past year' };
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let state = { data: null, prices: [], range: '1Y' };

    // ---------- formatting ----------
    function money(value, digits = 2) {
        if (value == null || Number.isNaN(value)) return '—';
        return (value < 0 ? '−$' : '$') + Math.abs(value).toLocaleString('en-US', {
            minimumFractionDigits: digits, maximumFractionDigits: digits
        });
    }

    function compactMoney(value) {
        if (value == null || Number.isNaN(value)) return '—';
        const abs = Math.abs(value);
        const sign = value < 0 ? '−' : '';
        if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
        if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e11 ? 0 : 1)}B`;
        if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
        return `${sign}$${abs.toLocaleString('en-US')}`;
    }

    function signedPct(value, digits = 1) {
        if (value == null || !Number.isFinite(value)) return '';
        return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}%`;
    }

    function ratio(value, suffix = '×') {
        return value == null || Number.isNaN(value) ? '—' : `${value.toFixed(1)}${suffix}`;
    }

    // Round axis ticks (1, 2, 2.5, 5 × 10^k) spanning [lo, hi] with ~intervals + 1 lines.
    function niceTicks(lo, hi, intervals = 2) {
        const span = hi - lo || Math.abs(hi) || 1;
        const raw = span / intervals;
        const mag = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
        // Zero stays the floor/ceiling when the data touches it (bars grow from 0).
        const start = Math.floor((lo === 0 ? 0 : lo - span * 0.08) / step) * step;
        const end = Math.ceil((hi === 0 ? 0 : hi + span * 0.08) / step) * step;
        const ticks = [];
        for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
        return ticks;
    }

    function parseDate(str) {
        const d = new Date(`${String(str).slice(0, 10)}T00:00:00`);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function longDate(str) {
        const d = parseDate(str);
        return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    }

    function shortDate(str) {
        const d = parseDate(str);
        return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    }

    function quarterParts(entry) {
        const d = parseDate(entry.fiscal_date);
        if (!d) return { q: entry.period || '', y: '' };
        return { q: `Q${Math.floor(d.getMonth() / 3) + 1}`, y: `'${String(d.getFullYear()).slice(-2)}` };
    }

    // ---------- DOM helpers ----------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function svg(tag, attrs = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        return node;
    }

    function card(title, subtitle) {
        const section = el('section', 'ov-card');
        const head = el('div', 'ov-card-head');
        head.append(el('h3', 'ov-card-title', title));
        if (subtitle) head.append(el('p', 'ov-card-sub', subtitle));
        section.append(head);
        return section;
    }

    // ---------- data shaping ----------
    function pricesInRange(prices, key) {
        if (!prices.length) return [];
        const last = parseDate(prices[prices.length - 1].date);
        let cutoff;
        if (key === 'YTD') {
            cutoff = new Date(last.getFullYear(), 0, 1);
        } else {
            const range = RANGES.find((r) => r.key === key);
            cutoff = new Date(last.getTime() - range.days * 864e5);
        }
        const rows = prices.filter((p) => parseDate(p.date) >= cutoff);
        return rows.length >= 2 ? rows : prices.slice(-2);
    }

    function quarterlySeries(earnings, shares) {
        return [...earnings]
            .filter((e) => e && e.fiscal_date)
            .sort((a, b) => parseDate(a.fiscal_date) - parseDate(b.fiscal_date))
            .slice(-8)
            .map((e) => ({
                ...quarterParts(e),
                revenue: e.revenue ?? null,
                earnings: e.reported_eps != null && shares ? e.reported_eps * shares : null,
                fcf: e.free_cash_flow ?? null,
                eps: e.reported_eps ?? null,
                est: e.estimated_eps ?? null
            }));
    }

    function ttm(series, key) {
        const last4 = series.slice(-4).map((q) => q[key]);
        const prev4 = series.slice(-8, -4).map((q) => q[key]);
        const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
        const current = last4.some((v) => v != null) ? sum(last4) : null;
        const prior = prev4.length === 4 && prev4.every((v) => v != null) ? sum(prev4) : null;
        const change = current != null && prior != null && prior > 0 ? ((current - prior) / prior) * 100 : null;
        return { current, change };
    }

    // ---------- hero: price + scrubbable chart ----------
    function renderHero(root) {
        const { data } = state;
        const hero = el('section', 'ov-hero');
        const meta = el('p', 'ov-hero-meta');
        meta.textContent = [data.name, data.sector].filter(Boolean).join(' · ');
        const price = el('div', 'ov-price');
        const delta = el('div', 'ov-delta');
        const chartBox = el('div', 'ov-chart');
        const ranges = el('div', 'ov-ranges');
        ranges.setAttribute('role', 'group');
        ranges.setAttribute('aria-label', 'Chart time range');

        RANGES.forEach((r) => {
            const btn = el('button', 'ov-range-btn', r.label);
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String(r.key === state.range));
            btn.addEventListener('click', () => {
                state.range = r.key;
                ranges.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
                drawPrice();
            });
            ranges.append(btn);
        });

        hero.append(meta, price, delta, chartBox, ranges);
        root.append(hero);

        function setReadout(close, start, label) {
            price.textContent = money(close);
            const diff = close - start;
            const pct = start ? (diff / start) * 100 : 0;
            const up = diff >= 0;
            delta.className = `ov-delta ${up ? 'is-up' : 'is-down'}`;
            delta.replaceChildren(
                el('span', 'ov-delta-arrow', up ? '▲' : '▼'),
                el('span', 'ov-delta-value', `${money(Math.abs(diff))} (${signedPct(pct, 2)})`),
                el('span', 'ov-delta-label', label)
            );
        }

        function drawPrice() {
            const rows = pricesInRange(state.prices, state.range);
            chartBox.replaceChildren();
            if (rows.length < 2) {
                const fallback = state.data.summary?.current_price;
                price.textContent = money(fallback);
                delta.replaceChildren();
                chartBox.append(el('p', 'ov-empty', 'Price history unavailable right now.'));
                return;
            }

            const closes = rows.map((r) => r.close);
            const start = closes[0];
            const end = closes[closes.length - 1];
            const up = end >= start;
            const restLabel = RANGE_PHRASE[state.range];
            setReadout(end, start, restLabel);

            const W = Math.max(chartBox.clientWidth, 280);
            const H = 200;
            const pad = { top: 24, right: 8, bottom: 24, left: 8 };
            const lo = Math.min(...closes);
            const hi = Math.max(...closes);
            const span = hi - lo || 1;
            const x = (i) => pad.left + (i / (rows.length - 1)) * (W - pad.left - pad.right);
            const y = (v) => pad.top + (1 - (v - lo) / span) * (H - pad.top - pad.bottom);

            const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: `ov-price-svg ${up ? 'is-up' : 'is-down'}` });
            root.setAttribute('role', 'img');
            root.setAttribute('aria-label', `${state.data.ticker} price ${restLabel}: from ${money(start)} to ${money(end)}, low ${money(lo)}, high ${money(hi)}.`);

            const gradId = `ovGrad${Math.random().toString(36).slice(2, 8)}`;
            const defs = svg('defs');
            const grad = svg('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
            grad.append(svg('stop', { offset: '0%', class: 'ov-grad-top' }), svg('stop', { offset: '100%', class: 'ov-grad-bottom' }));
            defs.append(grad);
            root.append(defs);

            // Reference line at the range's opening price.
            root.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: y(start), y2: y(start), class: 'ov-ref-line' }));

            const pts = closes.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
            const linePath = `M${pts.join('L')}`;
            const areaPath = `${linePath}L${x(closes.length - 1).toFixed(1)},${H - pad.bottom}L${pad.left},${H - pad.bottom}Z`;
            root.append(svg('path', { d: areaPath, fill: `url(#${gradId})`, class: 'ov-area' }));
            const line = svg('path', { d: linePath, class: 'ov-line', pathLength: 1 });
            root.append(line);
            if (!reduceMotion) line.classList.add('is-drawing');

            // Direct labels on the extremes only.
            const hiIdx = closes.indexOf(hi);
            const loIdx = closes.indexOf(lo);
            const extremeLabel = (idx, value, above) => {
                const px = x(idx);
                const anchor = px < 48 ? 'start' : px > W - 48 ? 'end' : 'middle';
                const t = svg('text', { x: px, y: above ? y(value) - 10 : y(value) + 18, 'text-anchor': anchor, class: 'ov-extreme' });
                t.textContent = money(value);
                return t;
            };
            root.append(extremeLabel(hiIdx, hi, true), extremeLabel(loIdx, lo, false));

            // End marker with a soft pulse.
            const ex = x(closes.length - 1);
            const ey = y(end);
            if (!reduceMotion) root.append(svg('circle', { cx: ex, cy: ey, r: 4, class: 'ov-pulse' }));
            root.append(svg('circle', { cx: ex, cy: ey, r: 4, class: 'ov-end-dot' }));

            // Scrub layer.
            const cross = svg('line', { y1: pad.top - 8, y2: H - pad.bottom, class: 'ov-crosshair' });
            const crossDot = svg('circle', { r: 5, class: 'ov-cross-dot' });
            const crossGroup = svg('g', { class: 'ov-cross', visibility: 'hidden' });
            crossGroup.append(cross, crossDot);
            root.append(crossGroup);

            const dateRow = el('div', 'ov-chart-dates');
            dateRow.append(el('span', null, shortDate(rows[0].date)), el('span', 'ov-scrub-date', ''), el('span', null, shortDate(rows[rows.length - 1].date)));
            const scrubDate = dateRow.querySelector('.ov-scrub-date');

            function scrubTo(clientX) {
                const rect = root.getBoundingClientRect();
                const rel = ((clientX - rect.left) / rect.width) * W;
                const i = Math.max(0, Math.min(rows.length - 1, Math.round(((rel - pad.left) / (W - pad.left - pad.right)) * (rows.length - 1))));
                const cx = x(i);
                cross.setAttribute('x1', cx);
                cross.setAttribute('x2', cx);
                crossDot.setAttribute('cx', cx);
                crossDot.setAttribute('cy', y(closes[i]));
                crossGroup.setAttribute('visibility', 'visible');
                root.classList.add('is-scrubbing');
                setReadout(closes[i], start, `since ${shortDate(rows[0].date)}`);
                scrubDate.textContent = longDate(rows[i].date);
            }

            function endScrub() {
                crossGroup.setAttribute('visibility', 'hidden');
                root.classList.remove('is-scrubbing');
                setReadout(end, start, restLabel);
                scrubDate.textContent = '';
            }

            root.addEventListener('pointerdown', (e) => scrubTo(e.clientX));
            root.addEventListener('pointermove', (e) => {
                if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) scrubTo(e.clientX);
            });
            root.addEventListener('pointerleave', endScrub);
            root.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') endScrub(); });
            root.addEventListener('pointercancel', endScrub);

            chartBox.append(root, dateRow);
        }

        return drawPrice;
    }

    // ---------- 52-week range ----------
    function renderRange52(root) {
        const { summary = {} } = state.data;
        const year = state.prices.slice(-260).map((p) => p.close);
        const low = summary.price_52w_low ?? (year.length ? Math.min(...year) : null);
        const high = summary.price_52w_high ?? (year.length ? Math.max(...year) : null);
        const current = state.prices.length ? state.prices[state.prices.length - 1].close : summary.current_price;
        if (low == null || high == null || current == null || high <= low) return;

        const pos = Math.max(0, Math.min(1, (current - low) / (high - low)));
        const offHigh = ((high - current) / high) * 100;
        const sub = offHigh < 1
            ? 'Trading at its 52-week high'
            : `${offHigh.toFixed(0)}% below its 52-week high`;
        const section = card('52-week range', sub);

        const meter = el('div', 'ov-meter');
        meter.setAttribute('role', 'img');
        meter.setAttribute('aria-label', `52-week low ${money(low)}, high ${money(high)}, current ${money(current)}`);
        const track = el('div', 'ov-meter-track');
        const fill = el('div', 'ov-meter-fill');
        fill.style.width = `${pos * 100}%`;
        const marker = el('div', 'ov-meter-marker');
        marker.style.left = `${pos * 100}%`;
        const bubble = el('div', 'ov-meter-bubble', money(current));
        bubble.style.left = `${pos * 100}%`;
        bubble.dataset.edge = pos < 0.15 ? 'start' : pos > 0.85 ? 'end' : '';
        track.append(fill, marker);
        meter.append(bubble, track);

        const ends = el('div', 'ov-meter-ends');
        const lowBox = el('div');
        lowBox.append(el('span', 'ov-k', 'Low'), el('span', 'ov-v', money(low)));
        const highBox = el('div', 'is-end');
        highBox.append(el('span', 'ov-k', 'High'), el('span', 'ov-v', money(high)));
        ends.append(lowBox, highBox);

        section.append(meter, ends);
        root.append(section);
    }

    // ---------- stat tiles ----------
    function miniBars(series, key, caption, formatter) {
        const values = series.map((q) => q[key]);
        const box = el('div', 'ov-bars');
        if (values.filter((v) => v != null).length < 2) return box;

        const W = 140;
        const H = 44;
        const n = values.length;
        const slot = W / n;
        const barW = Math.min(12, slot - 3);
        const max = Math.max(0, ...values.filter((v) => v != null));
        const min = Math.min(0, ...values.filter((v) => v != null));
        const scale = (H - 2) / (max - min || 1);
        const zeroY = 1 + max * scale;

        const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ov-bars-svg', preserveAspectRatio: 'none' });
        root.setAttribute('aria-hidden', 'true');
        root.append(svg('line', { x1: 0, x2: W, y1: zeroY, y2: zeroY, class: 'ov-baseline' }));

        values.forEach((v, i) => {
            const g = svg('g', { class: `ov-bar${i === n - 1 ? ' is-latest' : ''}` });
            const bx = i * slot + (slot - barW) / 2;
            g.append(svg('rect', { x: i * slot, y: 0, width: slot, height: H, class: 'ov-bar-hit' }));
            if (v != null) {
                const h = Math.max(1.5, Math.abs(v) * scale);
                g.append(svg('rect', { x: bx, y: v >= 0 ? zeroY - h : zeroY, width: barW, height: h, rx: 2, class: 'ov-bar-fill' }));
            }
            const show = () => {
                root.querySelectorAll('.ov-bar').forEach((b) => b.classList.toggle('is-active', b === g));
                caption.textContent = `${series[i].q} ${series[i].y} · ${formatter(v)}`;
                caption.classList.add('is-peek');
            };
            g.addEventListener('pointerenter', show);
            g.addEventListener('pointerdown', show);
            root.append(g);
        });

        root.addEventListener('pointerleave', () => {
            root.querySelectorAll('.ov-bar').forEach((b) => b.classList.remove('is-active'));
            caption.textContent = caption.dataset.rest;
            caption.classList.remove('is-peek');
        });

        box.append(root);
        return box;
    }

    function statTile({ label, value, change, series, key }) {
        const tile = el('article', 'ov-tile');
        tile.append(el('h4', 'ov-tile-label', label), el('div', 'ov-tile-value', compactMoney(value)));
        const caption = el('div', 'ov-tile-caption');
        if (change != null) {
            caption.dataset.rest = `${signedPct(change)} vs. prior year`;
            caption.className = `ov-tile-caption ${change >= 0 ? 'is-up' : 'is-down'}`;
        } else {
            caption.dataset.rest = 'Trailing 12 months';
        }
        caption.textContent = caption.dataset.rest;
        tile.append(caption, miniBars(series, key, caption, compactMoney));
        tile.setAttribute('aria-label', `${label}: ${compactMoney(value)} trailing twelve months${change != null ? `, ${signedPct(change)} year over year` : ''}`);
        return tile;
    }

    function peTile(pe) {
        const tile = el('article', 'ov-tile ov-tile-pe');
        tile.append(el('h4', 'ov-tile-label', 'P/E ratio'), el('div', 'ov-tile-value', pe != null && pe > 0 ? pe.toFixed(1) : '—'));
        let verdict = 'No positive earnings';
        if (pe != null && pe > 0) verdict = pe < 15 ? 'Value territory' : pe <= 25 ? 'Near market average' : 'Priced for growth';
        tile.append(el('div', 'ov-tile-caption', verdict));

        const scaleMax = 50;
        const scale = el('div', 'ov-pe-scale');
        scale.setAttribute('aria-hidden', 'true');
        const zones = el('div', 'ov-pe-zones');
        [[0, 15], [15, 25], [25, scaleMax]].forEach(([a, b], i) => {
            const z = el('span', `ov-pe-zone z${i}`);
            z.style.flex = String(b - a);
            zones.append(z);
        });
        scale.append(zones);
        if (pe != null && pe > 0) {
            const mk = el('span', 'ov-pe-marker');
            mk.style.left = `${Math.min(pe, scaleMax) / scaleMax * 100}%`;
            scale.append(mk);
        }
        const ticks = el('div', 'ov-pe-ticks');
        ['0', '15', '25', '50+'].forEach((t, i) => {
            const s = el('span', null, t);
            s.style.left = `${[0, 30, 50, 100][i]}%`;
            ticks.append(s);
        });
        scale.append(ticks);
        tile.append(scale);
        tile.setAttribute('aria-label', `P/E ratio ${pe != null ? pe.toFixed(1) : 'unavailable'}: ${verdict}`);
        return tile;
    }

    function renderTiles(root, series) {
        const { summary = {} } = state.data;
        const grid = el('section', 'ov-tiles');
        const rev = ttm(series, 'revenue');
        const earn = ttm(series, 'earnings');
        const fcf = ttm(series, 'fcf');
        grid.append(
            statTile({ label: 'Revenue', value: rev.current, change: rev.change, series, key: 'revenue' }),
            statTile({ label: 'Earnings', value: earn.current, change: earn.change, series, key: 'earnings' }),
            statTile({ label: 'Free cash flow', value: fcf.current, change: fcf.change, series, key: 'fcf' }),
            peTile(summary.pe_ratio)
        );
        root.append(el('h3', 'ov-section-title', 'Last 12 months'));
        root.append(grid);
    }

    // ---------- earnings beat / miss ----------
    function renderEarnings(root, series) {
        const rows = series.filter((q) => q.eps != null && q.est != null);
        if (rows.length < 2) return;
        const beats = rows.filter((q) => q.eps >= q.est).length;
        const section = card('Earnings vs. estimates', `Beat Wall Street estimates in ${beats} of the last ${rows.length} quarters`);

        const legend = el('div', 'ov-legend');
        [['is-beat', 'Beat'], ['is-miss', 'Missed'], ['is-est', 'Estimate']].forEach(([cls, text]) => {
            const item = el('span', 'ov-legend-item');
            item.append(el('span', `ov-legend-key ${cls}`), document.createTextNode(text));
            legend.append(item);
        });

        const box = el('div', 'ov-eps-chart');
        const readout = el('div', 'ov-eps-readout');
        section.append(legend, box, readout);
        root.append(section);

        const draw = () => {
            box.replaceChildren();
            const W = Math.max(box.clientWidth, 280);
            const H = 180;
            const pad = { top: 12, right: 4, bottom: 36, left: 40 };
            const all = rows.flatMap((q) => [q.eps, q.est]);
            const ticks = niceTicks(Math.min(...all), Math.max(...all));
            const lo = ticks[0];
            const hi = ticks[ticks.length - 1];
            const slot = (W - pad.left - pad.right) / rows.length;
            const cx = (i) => pad.left + slot * i + slot / 2;
            const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);

            const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-eps-svg' });
            root.setAttribute('role', 'img');
            root.setAttribute('aria-label', `Earnings per share versus estimates. Beat in ${beats} of ${rows.length} quarters.`);

            ticks.forEach((v) => {
                const gy = y(v);
                root.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: gy, y2: gy, class: 'ov-grid' }));
                const t = svg('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end', class: 'ov-axis' });
                t.textContent = `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
                root.append(t);
            });

            const groups = rows.map((q, i) => {
                const beat = q.eps >= q.est;
                const g = svg('g', { class: `ov-eps-q ${beat ? 'is-beat' : 'is-miss'}` });
                g.append(svg('rect', { x: cx(i) - slot / 2, y: 0, width: slot, height: H, class: 'ov-hit' }));
                g.append(svg('line', { x1: cx(i), x2: cx(i), y1: y(q.est), y2: y(q.eps), class: 'ov-eps-gap' }));
                g.append(svg('circle', { cx: cx(i), cy: y(q.est), r: 5, class: 'ov-eps-est' }));
                g.append(svg('circle', { cx: cx(i), cy: y(q.eps), r: 6, class: 'ov-eps-act' }));
                const ql = svg('text', { x: cx(i), y: H - pad.bottom + 18, 'text-anchor': 'middle', class: 'ov-axis ov-axis-strong' });
                ql.textContent = q.q;
                const yl = svg('text', { x: cx(i), y: H - pad.bottom + 32, 'text-anchor': 'middle', class: 'ov-axis' });
                yl.textContent = q.y;
                g.append(ql, yl);
                const select = () => {
                    groups.forEach((other) => other.classList.toggle('is-active', other === g));
                    const surprise = q.est ? ((q.eps - q.est) / Math.abs(q.est)) * 100 : 0;
                    readout.replaceChildren(
                        el('span', 'ov-eps-readout-q', `${q.q} ${q.y}`),
                        el('span', `ov-eps-badge ${beat ? 'is-beat' : 'is-miss'}`, `${beat ? '▲ Beat' : '▼ Missed'} by ${Math.abs(surprise).toFixed(1)}%`),
                        el('span', 'ov-eps-readout-detail', `${money(q.eps)} per share vs. ${money(q.est)} expected`)
                    );
                };
                g.addEventListener('pointerenter', select);
                g.addEventListener('pointerdown', select);
                g._select = select;
                root.append(g);
                return g;
            });
            groups[groups.length - 1]._select();
            box.append(root);
        };
        return draw;
    }

    // Column with a 4px rounded data end, square at the baseline (y0). Grows
    // up or down depending on which side of the baseline yv sits.
    function columnPath(x, w, y0, yv) {
        const h = Math.max(1.5, Math.abs(yv - y0));
        const r = Math.min(4, w / 2, h);
        const dir = yv <= y0 ? -1 : 1;
        const end = y0 + dir * h;
        return `M${x},${y0}V${end - dir * r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end - dir * r}V${y0}Z`;
    }

    // Shared card scaffolding for the Fundamentals charts.
    function chartCard(root, title, subtitle) {
        root.replaceChildren();
        const head = el('div', 'ov-card-head');
        head.append(el('h3', 'ov-card-title', title));
        if (subtitle) head.append(el('p', 'ov-card-sub', subtitle));
        root.append(head);
    }

    function statBlock(label, value, note, noteClass) {
        const box = el('div', 'ec-stat');
        box.append(el('span', 'ec-stat-label', label), el('span', 'ec-stat-value', value));
        if (note) box.append(el('span', `ec-stat-note${noteClass ? ` ${noteClass}` : ''}`, note));
        return box;
    }

    // ---------- revenue by quarter (Fundamentals tab) ----------
    function renderRevenue(root, series) {
        const rows = series.filter((q) => q.revenue != null);
        chartCard(root, 'Revenue by quarter', 'Total sales each quarter, before any costs');
        if (rows.length < 2) {
            root.append(el('p', 'ov-empty', 'Quarterly revenue unavailable.'));
            return null;
        }

        const total = ttm(series, 'revenue');
        const stats = el('div', 'ec-stats');
        stats.append(statBlock(
            'Last 12 months',
            compactMoney(total.current),
            total.change != null ? `${signedPct(total.change)} vs. prior year` : null,
            total.change != null ? (total.change >= 0 ? 'is-up' : 'is-down') : null
        ));
        const box = el('div', 'ec-chart');
        const readout = el('div', 'ec-readout');
        root.append(stats, box, readout);

        return () => {
            box.replaceChildren();
            const W = Math.max(box.clientWidth, 280);
            const H = 190;
            const pad = { top: 8, right: 4, bottom: 36, left: 46 };
            const vals = rows.map((q) => q.revenue);
            const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 3);
            const lo = ticks[0];
            const hi = ticks[ticks.length - 1];
            const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);
            const slot = (W - pad.left - pad.right) / rows.length;
            const barW = Math.min(24, slot - 12);

            const svgRoot = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ec-svg' });
            svgRoot.setAttribute('role', 'img');
            svgRoot.setAttribute('aria-label', `Quarterly revenue. Last 12 months: ${compactMoney(total.current)}.`);
            ticks.forEach((v) => {
                const gy = y(v);
                svgRoot.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: gy, y2: gy, class: v === 0 ? 'ec-zero' : 'ov-grid' }));
                const t = svg('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end', class: 'ov-axis' });
                t.textContent = axisMoney(v);
                svgRoot.append(t);
            });

            const groups = rows.map((q, i) => {
                const cx = pad.left + slot * i + slot / 2;
                const g = svg('g', { class: `ec-q${i === rows.length - 1 ? ' is-latest' : ''}` });
                g.append(svg('rect', { x: cx - slot / 2, y: 0, width: slot, height: H - pad.bottom + 30, rx: 8, class: 'ov-hit' }));
                g.append(svg('path', { d: columnPath(cx - barW / 2, barW, y(0), y(q.revenue)), class: 'ec-bar is-rev' }));
                const ql = svg('text', { x: cx, y: H - pad.bottom + 18, 'text-anchor': 'middle', class: 'ov-axis ov-axis-strong' });
                ql.textContent = q.q;
                const yl = svg('text', { x: cx, y: H - pad.bottom + 32, 'text-anchor': 'middle', class: 'ov-axis' });
                yl.textContent = q.y;
                g.append(ql, yl);
                // Same quarter a year earlier, for seasonality-free growth.
                const yearAgo = rows[i - 4];
                const select = () => {
                    groups.forEach((other) => other.classList.toggle('is-active', other === g));
                    const parts = [el('span', 'ov-eps-readout-q', `${q.q} ${q.y}`), el('strong', 'ec-readout-strong', compactMoney(q.revenue))];
                    if (yearAgo && yearAgo.revenue > 0) {
                        const yoy = ((q.revenue - yearAgo.revenue) / yearAgo.revenue) * 100;
                        parts.push(el('span', `ec-readout-delta ${yoy >= 0 ? 'is-up' : 'is-down'}`, `${yoy >= 0 ? '▲' : '▼'} ${signedPct(yoy)} vs. ${yearAgo.q} ${yearAgo.y}`));
                    }
                    readout.replaceChildren(...parts);
                };
                g.addEventListener('pointerenter', select);
                g.addEventListener('pointerdown', select);
                g._select = select;
                svgRoot.append(g);
                return g;
            });
            groups[groups.length - 1]._select();
            box.append(svgRoot);
        };
    }

    // ---------- P/E over time (Fundamentals tab) ----------
    // Daily P/E for the price window: each day's close divided by the sum of
    // the four quarters of EPS reported on or before that day.
    function peHistory(earnings, prices) {
        const quarters = [...earnings]
            .filter((e) => e && e.fiscal_date && e.reported_eps != null)
            .map((e) => ({ date: parseDate(e.fiscal_date), eps: e.reported_eps }))
            .filter((e) => e.date)
            .sort((a, b) => a.date - b.date);
        const points = [];
        let idx = -1;
        prices.forEach((p) => {
            const day = parseDate(p.date);
            while (idx + 1 < quarters.length && quarters[idx + 1].date <= day) idx++;
            if (idx < 3) return;
            const ttmEps = quarters.slice(idx - 3, idx + 1).reduce((sum, q) => sum + q.eps, 0);
            if (ttmEps > 0) points.push({ date: p.date, pe: p.close / ttmEps });
        });
        return points;
    }

    function renderPE(root) {
        const points = peHistory(state.data.earnings || [], state.prices);
        chartCard(root, 'P/E ratio over time', 'Share price ÷ the last 12 months of earnings per share. Lower means cheaper for each dollar of profit.');
        if (points.length < 2) {
            root.append(el('p', 'ov-empty', 'Not enough profitable quarters to chart P/E.'));
            return null;
        }

        const first = points[0].pe;
        const last = points[points.length - 1].pe;
        const pes = points.map((p) => p.pe);
        const stats = el('div', 'ec-stats');
        stats.append(
            statBlock('Now', `${last.toFixed(1)}×`, last < 15 ? 'Value territory' : last <= 25 ? 'Near market average' : 'Priced for growth'),
            statBlock('Past-year range', `${Math.min(...pes).toFixed(0)}–${Math.max(...pes).toFixed(0)}×`, `${last >= first ? 'Up' : 'Down'} from ${first.toFixed(1)}× a year ago`)
        );
        const box = el('div', 'ec-chart');
        const readout = el('div', 'ec-readout');
        root.append(stats, box, readout);

        const legendNote = el('p', 'pe-note');
        legendNote.append(el('span', 'pe-band-key'), document.createTextNode('Shaded band: 15–25×, where the broad market usually trades'));
        root.append(legendNote);

        return () => {
            box.replaceChildren();
            const W = Math.max(box.clientWidth, 280);
            const H = 190;
            const pad = { top: 12, right: 8, bottom: 22, left: 34 };
            const ticks = niceTicks(Math.min(...pes, 15), Math.max(...pes, 25), 3);
            const lo = ticks[0];
            const hi = ticks[ticks.length - 1];
            const x = (i) => pad.left + (i / (points.length - 1)) * (W - pad.left - pad.right);
            const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);

            const svgRoot = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ec-svg pe-svg' });
            svgRoot.setAttribute('role', 'img');
            svgRoot.setAttribute('aria-label', `P/E ratio over the past year, from ${first.toFixed(1)} to ${last.toFixed(1)}.`);

            svgRoot.append(svg('rect', { x: pad.left, y: y(25), width: W - pad.left - pad.right, height: y(15) - y(25), class: 'pe-band' }));
            ticks.forEach((v) => {
                const gy = y(v);
                svgRoot.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: gy, y2: gy, class: 'ov-grid' }));
                const t = svg('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end', class: 'ov-axis' });
                t.textContent = `${v}×`;
                svgRoot.append(t);
            });

            const d = `M${points.map((p, i) => `${x(i).toFixed(1)},${y(p.pe).toFixed(1)}`).join('L')}`;
            svgRoot.append(svg('path', { d, class: 'pe-line' }));
            const ex = x(points.length - 1);
            svgRoot.append(svg('circle', { cx: ex, cy: y(last), r: 4, class: 'pe-end' }));

            [0, points.length - 1].forEach((i) => {
                const t = svg('text', { x: x(i), y: H - 4, 'text-anchor': i === 0 ? 'start' : 'end', class: 'ov-axis' });
                t.textContent = shortDate(points[i].date);
                svgRoot.append(t);
            });

            const cross = svg('line', { y1: pad.top, y2: H - pad.bottom, class: 'ov-crosshair' });
            const crossDot = svg('circle', { r: 5, class: 'pe-end' });
            const crossGroup = svg('g', { visibility: 'hidden' });
            crossGroup.append(cross, crossDot);
            svgRoot.append(crossGroup);

            const show = (i) => {
                readout.replaceChildren(
                    el('span', 'ov-eps-readout-q', i === points.length - 1 ? 'Latest' : longDate(points[i].date)),
                    el('strong', 'ec-readout-strong', `${points[i].pe.toFixed(1)}× earnings`)
                );
            };
            const scrubTo = (clientX) => {
                const rect = svgRoot.getBoundingClientRect();
                const rel = ((clientX - rect.left) / rect.width) * W;
                const i = Math.max(0, Math.min(points.length - 1, Math.round(((rel - pad.left) / (W - pad.left - pad.right)) * (points.length - 1))));
                cross.setAttribute('x1', x(i));
                cross.setAttribute('x2', x(i));
                crossDot.setAttribute('cx', x(i));
                crossDot.setAttribute('cy', y(points[i].pe));
                crossGroup.setAttribute('visibility', 'visible');
                show(i);
            };
            const endScrub = () => {
                crossGroup.setAttribute('visibility', 'hidden');
                show(points.length - 1);
            };
            svgRoot.addEventListener('pointerdown', (e) => scrubTo(e.clientX));
            svgRoot.addEventListener('pointermove', (e) => {
                if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) scrubTo(e.clientX);
            });
            svgRoot.addEventListener('pointerleave', endScrub);
            svgRoot.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') endScrub(); });
            svgRoot.addEventListener('pointercancel', endScrub);
            show(points.length - 1);
            box.append(svgRoot);
        };
    }

    // ---------- metric groups (Fundamentals tab) ----------
    function renderMetricGroups(root) {
        const s = state.data.summary || {};
        const pct = (v) => (v == null ? null : `${v.toFixed(1)}%`);
        const x = (v, digits = 2) => (v == null ? null : `${v.toFixed(digits)}×`);
        const groups = [
            ['Profitability', 'How efficiently sales turn into profit', [
                ['Gross margin', pct(s.gross_margin), 'Revenue left after the cost of making the product'],
                ['Operating margin', pct(s.operating_margin), 'Left after day-to-day running costs'],
                ['Net margin', pct(s.profit_margin), 'Left as profit after everything, including taxes'],
                ['Return on assets', pct(s.roa), 'Profit generated per dollar of assets'],
                ['Return on equity', pct(s.roe), 'Profit generated per dollar shareholders own'],
                ['Return on invested capital', pct(s.roic), 'Return on all money invested, debt and equity']
            ]],
            ['Financial health', 'Can the company comfortably pay its bills?', [
                ['Current ratio', x(s.current_ratio), 'Short-term assets ÷ bills due within a year; above 1.5 is comfortable'],
                ['Quick ratio', x(s.quick_ratio), 'Same, minus inventory; above 1 is comfortable'],
                ['Interest coverage', x(s.interest_coverage), 'Operating profit ÷ interest owed; above 3 is safe'],
                ['Debt to equity', x(s.debt_to_equity), 'Debt per dollar of shareholder equity'],
                ['Cash', s.cash != null ? compactMoney(s.cash) : null, 'Cash and equivalents on hand'],
                ['Working capital', s.working_capital != null ? compactMoney(s.working_capital) : null, 'Short-term assets minus short-term bills']
            ]],
            ['Valuation', 'What the market is paying for the business', [
                ['P/E ratio', x(s.pe_ratio, 1), 'Price per dollar of yearly profit'],
                ['Price / sales', x(s.ps_ratio, 1), 'Price per dollar of yearly revenue'],
                ['Price / book', x(s.pb_ratio, 1), 'Price vs. the accounting value of its assets'],
                ['EV / EBITDA', x(s.ev_ebitda, 1), 'Takeover price vs. operating cash profit'],
                ['Market cap', s.market_cap != null ? compactMoney(s.market_cap) : null, 'Value of all shares combined'],
                ['Enterprise value', s.enterprise_value != null ? compactMoney(s.enterprise_value) : null, 'Market cap plus debt, minus cash'],
                ['Shares outstanding', s.shares_outstanding != null ? `${(s.shares_outstanding / 1e9).toFixed(2)}B` : null, 'Total shares held by investors']
            ]]
        ];

        root.replaceChildren();
        groups.forEach(([title, subtitle, items]) => {
            const shown = items.filter(([, v]) => v != null);
            if (!shown.length) return;
            const section = card(title, subtitle);
            const dl = el('dl', 'ov-glance fm-glance');
            shown.forEach(([k, v, hint]) => {
                const item = el('div', 'ov-glance-item');
                item.append(el('dt', null, k), el('dd', null, v), el('p', 'fm-hint', hint));
                dl.append(item);
            });
            section.append(dl);
            root.append(section);
        });
    }

    // ---------- earnings vs. free cash flow (Fundamentals tab) ----------
    function axisMoney(value) {
        if (value === 0) return '$0';
        const abs = Math.abs(value);
        const sign = value < 0 ? '−' : '';
        const [div, unit] = abs >= 1e12 ? [1e12, 'T'] : abs >= 1e9 ? [1e9, 'B'] : [1e6, 'M'];
        const n = abs / div;
        return `${sign}$${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
    }

    function renderEarningsCash(root, series) {
        root.replaceChildren();
        const rows = series.filter((q) => q.earnings != null || q.fcf != null);
        if (rows.length < 2) {
            root.append(el('p', 'ov-empty', 'Quarterly earnings data unavailable.'));
            return null;
        }

        const head = el('div', 'ov-card-head');
        head.append(
            el('h3', 'ov-card-title', 'Earnings & free cash flow'),
            el('p', 'ov-card-sub', 'Profit on paper vs. the cash the business actually brought in, by quarter')
        );

        const earn = ttm(rows, 'earnings').current;
        const fcf = ttm(rows, 'fcf').current;
        const stats = el('div', 'ec-stats');
        const stat = (cls, label, value) => {
            const box = el('div', 'ec-stat');
            const k = el('span', 'ec-stat-label');
            k.append(el('span', `ec-key ${cls}`), document.createTextNode(label));
            box.append(k, el('span', 'ec-stat-value', compactMoney(value)), el('span', 'ec-stat-note', 'Last 12 months'));
            return box;
        };
        stats.append(stat('is-earn', 'Earnings', earn), stat('is-fcf', 'Free cash flow', fcf));
        if (earn > 0 && fcf != null) {
            const conv = (fcf / earn) * 100;
            const box = el('div', 'ec-stat ec-stat-wide');
            box.append(
                el('span', 'ec-stat-label', 'Cash conversion'),
                el('span', 'ec-stat-value', `${conv.toFixed(0)}%`),
                el('span', 'ec-stat-note', conv >= 90
                    ? 'Profits are backed by real cash'
                    : conv >= 50 ? 'Some profit is tied up in spending' : 'Much less cash than reported profit')
            );
            stats.append(box);
        }

        const box = el('div', 'ec-chart');
        const readout = el('div', 'ec-readout');
        root.append(head, stats, box, readout);

        return () => {
            box.replaceChildren();
            const W = Math.max(box.clientWidth, 280);
            const H = 200;
            const pad = { top: 8, right: 4, bottom: 36, left: 46 };
            const vals = rows.flatMap((q) => [q.earnings, q.fcf]).filter((v) => v != null);
            const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 3);
            const lo = ticks[0];
            const hi = ticks[ticks.length - 1];
            const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);
            const slot = (W - pad.left - pad.right) / rows.length;
            const barW = Math.min(14, (slot - 10) / 2);
            const gap = 2;

            const svgRoot = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ec-svg' });
            svgRoot.setAttribute('role', 'img');
            svgRoot.setAttribute('aria-label', `Quarterly earnings and free cash flow. Last 12 months: earnings ${compactMoney(earn)}, free cash flow ${compactMoney(fcf)}.`);

            ticks.forEach((v) => {
                const gy = y(v);
                svgRoot.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: gy, y2: gy, class: v === 0 ? 'ec-zero' : 'ov-grid' }));
                const t = svg('text', { x: pad.left - 8, y: gy + 4, 'text-anchor': 'end', class: 'ov-axis' });
                t.textContent = axisMoney(v);
                svgRoot.append(t);
            });

            const column = (x, v, cls) => svg('path', { d: columnPath(x, barW, y(0), y(v)), class: `ec-bar ${cls}` });

            const groups = rows.map((q, i) => {
                const cx = pad.left + slot * i + slot / 2;
                const g = svg('g', { class: 'ec-q' });
                g.append(svg('rect', { x: cx - slot / 2, y: 0, width: slot, height: H - pad.bottom + 30, rx: 8, class: 'ov-hit' }));
                if (q.earnings != null) g.append(column(cx - gap / 2 - barW, q.earnings, 'is-earn'));
                if (q.fcf != null) g.append(column(cx + gap / 2, q.fcf, 'is-fcf'));
                const ql = svg('text', { x: cx, y: H - pad.bottom + 18, 'text-anchor': 'middle', class: 'ov-axis ov-axis-strong' });
                ql.textContent = q.q;
                const yl = svg('text', { x: cx, y: H - pad.bottom + 32, 'text-anchor': 'middle', class: 'ov-axis' });
                yl.textContent = q.y;
                g.append(ql, yl);
                const select = () => {
                    groups.forEach((other) => other.classList.toggle('is-active', other === g));
                    const item = (cls, label, v) => {
                        const span = el('span', 'ec-readout-item');
                        span.append(el('span', `ec-key ${cls}`), document.createTextNode(`${label} `), el('strong', null, compactMoney(v)));
                        return span;
                    };
                    readout.replaceChildren(
                        el('span', 'ov-eps-readout-q', `${q.q} ${q.y}`),
                        item('is-earn', 'Earnings', q.earnings),
                        item('is-fcf', 'Free cash flow', q.fcf)
                    );
                };
                g.addEventListener('pointerenter', select);
                g.addEventListener('pointerdown', select);
                g._select = select;
                svgRoot.append(g);
                return g;
            });
            groups[groups.length - 1]._select();
            box.append(svgRoot);
        };
    }

    // ---------- profitability ----------
    function renderMargins(root) {
        const { summary = {} } = state.data;
        const items = [
            ['Gross margin', summary.gross_margin, 'Kept from each sales dollar after making the product'],
            ['Operating margin', summary.operating_margin, 'Left after running the business'],
            ['Net margin', summary.profit_margin, 'Left as profit after everything, including taxes']
        ].filter(([, v]) => v != null);
        if (!items.length) return;

        const section = card('Profitability', 'How many cents of each revenue dollar the company keeps');
        const list = el('div', 'ov-margins');
        items.forEach(([label, value, hint], i) => {
            const row = el('div', 'ov-margin');
            const top = el('div', 'ov-margin-top');
            top.append(el('span', 'ov-margin-label', label), el('span', 'ov-margin-value', `${value.toFixed(1)}%`));
            const track = el('div', 'ov-margin-track');
            const fill = el('div', 'ov-margin-fill');
            fill.style.setProperty('--w', `${Math.max(0, Math.min(100, value))}%`);
            fill.style.transitionDelay = `${i * 80}ms`;
            track.append(fill);
            row.append(top, track, el('p', 'ov-margin-hint', hint));
            list.append(row);
        });
        section.append(list);
        root.append(section);
        requestAnimationFrame(() => requestAnimationFrame(() => section.classList.add('is-in')));
    }

    // ---------- valuation snapshot ----------
    function renderSnapshot(root) {
        const { summary = {} } = state.data;
        const rows = [
            ['Market cap', compactMoney(summary.market_cap)],
            ['Enterprise value', compactMoney(summary.enterprise_value)],
            ['Price / sales', ratio(summary.ps_ratio)],
            ['Price / book', ratio(summary.pb_ratio)],
            ['EV / EBITDA', ratio(summary.ev_ebitda)],
            ['Return on equity', summary.roe != null ? `${summary.roe.toFixed(1)}%` : '—'],
            ['Beta', summary.beta != null ? summary.beta.toFixed(2) : '—'],
            ['Dividend yield', summary.dividend_yield != null ? `${summary.dividend_yield.toFixed(2)}%` : 'None']
        ];
        const section = card('At a glance');
        const dl = el('dl', 'ov-glance');
        rows.forEach(([k, v]) => {
            const item = el('div', 'ov-glance-item');
            item.append(el('dt', null, k), el('dd', null, v));
            dl.append(item);
        });
        section.append(dl);
        root.append(section);
    }

    // ---------- public ----------
    let redrawers = [];
    let resizeTimer = null;
    let lastWidth = 0;

    function render(data, priceHistory) {
        const root = document.getElementById('overviewViz');
        if (!root || !data) return;
        state.data = data;
        state.prices = (priceHistory || [])
            .map((p) => ({ date: p.date, close: p.close ?? p.price }))
            .filter((p) => p.close != null && parseDate(p.date));

        root.replaceChildren();
        const summary = data.summary || {};
        const series = quarterlySeries(data.earnings || [], summary.shares_outstanding);

        const drawPrice = renderHero(root);
        renderRange52(root);
        renderTiles(root, series);
        const drawEps = renderEarnings(root, series);
        const pair = el('div', 'ov-pair');
        root.append(pair);
        renderMargins(pair);
        renderSnapshot(pair);

        const fundamental = (id, fn) => {
            const target = document.getElementById(id);
            return target ? fn(target) : null;
        };
        const drawEc = fundamental('earningsCashViz', (t) => renderEarningsCash(t, series));
        const drawRev = fundamental('revenueViz', (t) => renderRevenue(t, series));
        const drawPe = fundamental('peViz', (t) => renderPE(t));
        fundamental('metricGroupsViz', (t) => renderMetricGroups(t));

        redrawers = [drawPrice, drawEps, drawEc, drawRev, drawPe].filter(Boolean);
        redrawers.forEach((fn) => fn());
        lastWidth = root.clientWidth;
    }

    function redraw() {
        const root = document.getElementById('overviewViz');
        if (!root || !state.data || !root.clientWidth) return;
        lastWidth = root.clientWidth;
        redrawers.forEach((fn) => fn());
    }

    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const root = document.getElementById('overviewViz');
            if (root && root.clientWidth !== lastWidth) redraw();
        }, 120);
    });

    window.StockOverview = { render, redraw };
})();
