// Shelby easter egg: search "SHELBY" and a stock line rallies across the
// screen, traces itself into a heart, and the ticker reads "Priceless".
(function () {
    if (window.ShelbyEgg) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HEART_COLORS = ['#d4576b', '#e8828c', '#f2b3b0', '#b96a4b', '#c9a24b'];
    const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let overlay = null;
    let floatTimer = null;
    let closeTimer = null;
    let readyToClose = false;

    function svg(tag, attrs = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        return node;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // Classic parametric heart; t = π is the bottom tip.
    function heartPoint(t, cx, cy, s) {
        const x = 16 * Math.sin(t) ** 3;
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        return [cx + x * s, cy - y * s];
    }

    // One continuous path: a wiggly, rising "price" line from the left edge
    // that lands on the heart's tip and then loops around the heart.
    function buildPaths() {
        const cx = 200;
        const cy = 128;
        const s = 6.2;
        const [tipX, tipY] = heartPoint(Math.PI, cx, cy, s);

        const chart = [];
        const steps = 48;
        const startY = tipY + 44;
        for (let i = 0; i <= steps; i++) {
            const p = i / steps;
            const x = 6 + (tipX - 6) * p;
            const trend = startY + (tipY - startY) * p ** 1.4;
            // Two gentle waves plus a little chop, easing off as it nears the tip.
            const calm = Math.sin(p * Math.PI);
            const wiggle = calm * (Math.sin(p * 13) * 8 + Math.sin(p * 31 + 1) * 3.5);
            chart.push([x, trend + wiggle]);
        }

        const heart = [];
        for (let i = 0; i <= 120; i++) heart.push(heartPoint(Math.PI + (i / 120) * Math.PI * 2, cx, cy, s));

        const toPath = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
        return {
            line: toPath([...chart, ...heart.slice(1)]),
            heart: `${toPath(heart)}Z`,
            start: chart[0]
        };
    }

    function floatingHeart(layer) {
        const size = 10 + Math.random() * 16;
        const icon = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'shelby-float' });
        icon.append(svg('path', {
            d: 'M12 21s-7.5-4.6-9.5-9.2C1.1 8.4 3.2 5 6.6 5c2 0 3.6 1.1 5.4 3 1.8-1.9 3.4-3 5.4-3 3.4 0 5.5 3.4 4.1 6.8C19.5 16.4 12 21 12 21z',
            fill: HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)]
        }));
        icon.style.left = `${Math.random() * 100}%`;
        icon.style.setProperty('--drift', `${(Math.random() - 0.5) * 80}px`);
        icon.style.setProperty('--spin', `${(Math.random() - 0.5) * 50}deg`);
        icon.style.animationDuration = `${5 + Math.random() * 4}s`;
        icon.style.opacity = String(0.55 + Math.random() * 0.4);
        icon.addEventListener('animationend', () => icon.remove());
        layer.append(icon);
    }

    function build() {
        const root = el('div', 'shelby-overlay');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'I love you, Shelby');

        const floats = el('div', 'shelby-floats');
        floats.setAttribute('aria-hidden', 'true');

        const stage = el('div', 'shelby-stage');

        const ticker = el('div', 'shelby-ticker');
        const top = el('div', 'shelby-ticker-top');
        top.append(el('span', 'shelby-symbol', 'SHELBY'), el('span', 'shelby-name', 'My favorite person'));
        const delta = el('div', 'shelby-delta');
        delta.append(el('span', 'shelby-arrow', '▲'), el('span', null, '+∞%'), el('span', 'shelby-delta-label', 'all time'));
        ticker.append(top, el('div', 'shelby-price', 'Priceless'), delta);

        const { line, heart, start } = buildPaths();
        const chart = svg('svg', { viewBox: '0 0 400 300', class: 'shelby-chart' });
        chart.setAttribute('aria-hidden', 'true');
        const defs = svg('defs');
        const grad = svg('linearGradient', { id: 'shelbyFill', x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.append(svg('stop', { offset: '0%', 'stop-color': '#e8828c' }), svg('stop', { offset: '100%', 'stop-color': '#c4485e' }));
        defs.append(grad);
        chart.append(defs);
        chart.append(svg('line', { x1: 0, x2: 400, y1: start[1], y2: start[1], class: 'shelby-ref' }));
        const fillGroup = svg('g', { class: 'shelby-heart-fill' });
        fillGroup.append(svg('path', { d: heart, fill: 'url(#shelbyFill)' }));
        chart.append(fillGroup);
        chart.append(svg('path', { d: line, pathLength: 1, class: 'shelby-line' }));

        const message = el('p', 'shelby-message');
        message.append(document.createTextNode('I love you, '), el('span', 'shelby-name-accent', 'Shelby'));

        stage.append(ticker, chart, message);
        const hint = el('div', 'shelby-hint', 'Tap anywhere to close');
        root.append(floats, stage, hint);
        return { root, floats };
    }

    function close() {
        if (!overlay || !readyToClose) return;
        const node = overlay;
        overlay = null;
        clearInterval(floatTimer);
        clearTimeout(closeTimer);
        document.removeEventListener('keydown', onKey);
        node.classList.remove('is-open');
        node.classList.add('is-closing');
        setTimeout(() => node.remove(), 450);
        document.documentElement.classList.remove('shelby-lock');
    }

    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    function show() {
        if (overlay) return;
        window.pgAnalytics?.track?.('stock_easter_egg', { name: 'shelby' });
        const { root, floats } = build();
        overlay = root;
        readyToClose = false;
        document.body.append(root);
        document.documentElement.classList.add('shelby-lock');
        if (reduceMotion()) root.classList.add('is-static');

        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));

        if (!reduceMotion()) {
            setTimeout(() => {
                if (overlay !== root) return;
                for (let i = 0; i < 6; i++) floatingHeart(floats);
                floatTimer = setInterval(() => {
                    if (floats.childElementCount < 28) floatingHeart(floats);
                }, 420);
            }, 3400);
        }

        closeTimer = setTimeout(() => {
            readyToClose = true;
            root.classList.add('can-close');
        }, reduceMotion() ? 300 : 1500);
        root.addEventListener('click', close);
        document.addEventListener('keydown', onKey);
    }

    window.ShelbyEgg = { show };
})();
