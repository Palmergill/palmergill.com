// Craps Strategy Simulator — UI controller.
//
// Flow: description --(/api/craps/translate)--> StrategyIntent
//       intent + form --CrapsStrategy.normalize--> StrategySpec
//       spec --CrapsEngine.runSimulation--> trials + stats --> charts.
//
// The LLM only ever yields an intent; all money + the seed are decided here so
// runs are reproducible.
(function () {
    'use strict';

    const Strategy = window.CrapsStrategy;
    const Engine = window.CrapsEngine;
    const API_BASE = (window.API_ORIGIN || '') + '/api/craps';
    const TRIALS = 1000;
    const MAX_ROLLS = 1000;

    // Human labels for bet types (CrapsRules covers most; add come/don't-come).
    const LABELS = Object.assign(
        { come: 'Come', dontCome: "Don't Come" },
        (window.CrapsRules && window.CrapsRules.BET_NAMES) || {}
    );
    const labelFor = (type) => LABELS[type] || type;

    const el = (id) => document.getElementById(id);
    const dom = {
        description: el('description'), buyIn: el('buyIn'), baseUnit: el('baseUnit'),
        seed: el('seed'), translateBtn: el('translateBtn'), preset: el('preset'),
        status: el('status'), strategyPanel: el('strategyPanel'),
        strategySummary: el('strategySummary'), betList: el('betList'),
        oddsMult: el('oddsMult'),
        runBtn: el('runBtn'), resultsPanel: el('resultsPanel'), statGrid: el('statGrid'),
        lineChart: el('lineChart'), histChart: el('histChart')
    };

    let currentIntent = null;
    let lineChart = null;
    let histChart = null;

    function setStatus(msg, kind) {
        dom.status.textContent = msg || '';
        dom.status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function readForm(withOverrides) {
        const buyIn = parseInt(dom.buyIn.value, 10);
        const baseUnit = parseInt(dom.baseUnit.value, 10);
        const seedRaw = dom.seed.value.trim();
        const form = {
            buyIn: buyIn > 0 ? buyIn : 300,
            baseUnit: baseUnit > 0 ? baseUnit : 10
        };
        if (seedRaw !== '' && Number.isInteger(+seedRaw) && +seedRaw >= 0) {
            form.seed = +seedRaw;
        }
        // Global odds override: '' keeps the strategy's own odds; otherwise a
        // uniform multiple (or 'none'/'max') on every line bet.
        const oddsVal = dom.oddsMult ? dom.oddsMult.value : '';
        if (oddsVal !== '') {
            form.oddsMultiplier = (oddsVal === 'max' || oddsVal === 'none') ? oddsVal : parseInt(oddsVal, 10);
        }
        if (withOverrides) {
            const overrides = {};
            dom.betList.querySelectorAll('input[data-type]').forEach((input) => {
                const v = parseInt(input.value, 10);
                if (v > 0) overrides[input.dataset.type] = v;
            });
            form.overrides = overrides;
        }
        return form;
    }

    // Build a spec from the current intent + form, surfacing errors to the user.
    function buildSpec(withOverrides) {
        if (!currentIntent) return null;
        try {
            return Strategy.normalize(currentIntent, readForm(withOverrides));
        } catch (err) {
            setStatus(err.message, 'error');
            return null;
        }
    }

    function describeBet(bet) {
        const bits = [];
        if (bet.when && bet.when !== 'always') bits.push(bet.when === 'comeOut' ? 'come-out' : 'point on');
        if (bet.everyRoll) bits.push('every roll');
        if (bet.maxActive) bits.push('up to ' + bet.maxActive);
        return bits.join(' · ');
    }

    function renderStrategy(spec) {
        const oddsTxt = Object.keys(spec.odds).length
            ? ' Odds: ' + Object.entries(spec.odds)
                .map(([k, v]) => labelFor(k) + ' ' + (v === 'max' ? 'max' : v + 'x')).join(', ') + '.'
            : '';
        const p = spec.progression;
        const progTxt = (p.onWin !== 'none' || p.onLoss !== 'none')
            ? ' Progression: ' + [
                p.onWin !== 'none' ? p.onWin + ' on win' : '',
                p.onLoss !== 'none' ? p.onLoss + ' on loss' : '',
                p.resetOnSevenOut ? 'reset on seven-out' : ''
            ].filter(Boolean).join(', ') + (p.appliesTo.length ? ' (' + p.appliesTo.map(labelFor).join(', ') + ')' : '') + '.'
            : '';

        dom.strategySummary.innerHTML =
            '<strong>' + escapeHtml(spec.name) + '.</strong> ' +
            escapeHtml(spec.summary || '') + escapeHtml(oddsTxt + progTxt);

        dom.betList.innerHTML = '';
        spec.bets.forEach((bet) => {
            const row = document.createElement('div');
            row.className = 'bet-row';
            const meta = describeBet(bet);
            row.innerHTML =
                '<div><div class="bet-name">' + escapeHtml(labelFor(bet.type)) + '</div>' +
                (meta ? '<div class="bet-meta">' + escapeHtml(meta) + '</div>' : '') + '</div>' +
                '<label class="bet-amount"><span>$</span>' +
                '<input type="number" min="1" step="1" data-type="' + bet.type + '" value="' + bet.amount + '"></label>';
            dom.betList.appendChild(row);
        });

        dom.strategyPanel.hidden = false;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // ---- Translate / preset -------------------------------------------------
    async function translate() {
        const description = dom.description.value.trim();
        if (!description) { setStatus('Describe a strategy first, or pick a preset.', 'error'); return; }

        dom.translateBtn.disabled = true;
        setStatus('Translating your strategy…');
        try {
            const res = await fetch(API_BASE + '/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description,
                    baseUnit: parseInt(dom.baseUnit.value, 10) || 10
                })
            });
            if (res.status === 503) {
                setStatus('AI translation is unavailable right now — pick a preset below to continue.', 'error');
                return;
            }
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setStatus('Could not translate: ' + (body.detail || res.statusText), 'error');
                return;
            }
            currentIntent = await res.json();
            const spec = buildSpec(false);
            if (spec) { renderStrategy(spec); setStatus('Translated. Review the bets, then run.', 'ok'); }
        } catch (err) {
            setStatus('Network error: ' + err.message, 'error');
        } finally {
            dom.translateBtn.disabled = false;
        }
    }

    function usePreset(key) {
        if (!key || !Strategy.PRESETS[key]) return;
        currentIntent = JSON.parse(JSON.stringify(Strategy.PRESETS[key]));
        if (!dom.description.value.trim()) dom.description.value = Strategy.PRESETS[key].summary;
        const spec = buildSpec(false);
        if (spec) { renderStrategy(spec); setStatus('Loaded preset “' + spec.name + '”. Review and run.', 'ok'); }
    }

    // ---- Run ----------------------------------------------------------------
    function run() {
        const spec = buildSpec(true);
        if (!spec) return;

        dom.runBtn.disabled = true;
        setStatus('Dealing ' + TRIALS + ' bankrolls…');
        // Defer so the button state paints before the (fast) synchronous run.
        setTimeout(() => {
            try {
                const { trials, stats } = Engine.runSimulation(spec, { trials: TRIALS, maxRolls: MAX_ROLLS });
                renderResults(spec, trials, stats);
                setStatus('Done.', 'ok');
                if (window.pgAnalytics && window.pgAnalytics.track) {
                    window.pgAnalytics.track('craps_strategy_simulated', {
                        survivalRate: Math.round(stats.survivalRate * 100),
                        medianEnd: Math.round(stats.medianEnd),
                        trials: TRIALS
                    });
                }
            } catch (err) {
                setStatus('Simulation error: ' + err.message, 'error');
            } finally {
                dom.runBtn.disabled = false;
            }
        }, 20);
    }

    function money(n) {
        const r = Math.round(n);
        return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString();
    }

    function renderResults(spec, trials, stats) {
        const cards = [
            { v: Math.round(stats.survivalRate * 100) + '%', l: 'Survived 1,000 rolls',
              cls: stats.survivalRate >= 0.5 ? 'good' : 'bad' },
            { v: money(stats.medianEnd), l: 'Median ending', cls: stats.medianEnd >= spec.buyIn ? 'good' : 'bad' },
            { v: money(stats.meanEnd), l: 'Mean ending', cls: stats.meanEnd >= spec.buyIn ? 'good' : 'bad' },
            { v: money(stats.bestEnd), l: 'Best run', cls: 'good' },
            { v: money(stats.worstEnd), l: 'Worst run', cls: 'bad' },
            { v: (stats.expectedEdge * 100).toFixed(2) + '%', l: 'Expected house edge',
              cls: stats.expectedEdge > 0 ? 'bad' : 'good' },
            { v: money(stats.avgProfit), l: 'Avg profit / loss per run',
              cls: stats.avgProfit >= 0 ? 'good' : 'bad' },
            { v: stats.meanRollsBeforeBust ? Math.round(stats.meanRollsBeforeBust) : '—',
              l: 'Avg rolls to bust', cls: '' },
            { v: String(spec.baseSeed), l: 'Seed', cls: '' }
        ];
        dom.statGrid.innerHTML = cards.map((c) =>
            '<div class="stat"><div class="stat-value ' + c.cls + '">' + escapeHtml(c.v) +
            '</div><div class="stat-label">' + escapeHtml(c.l) + '</div></div>'
        ).join('');

        drawLineChart(spec, trials);
        drawHistogram(spec, trials);
        dom.resultsPanel.hidden = false;
    }

    // Keep the line chart responsive: with 1,000 trials it would otherwise draw
    // ~1M points. Stats and the histogram use every trial; only the line chart
    // is down-sampled — at most MAX_PLOT_LINES paths, each thinned to MAX_POINTS
    // points. The curve shape is unchanged at this density.
    const MAX_PLOT_LINES = 250;
    const MAX_POINTS = 200;

    // Thin a balances array to <= MAX_POINTS {x,y} points, always keeping the
    // last roll so the ending is exact.
    function thin(balances) {
        const len = balances.length;
        const step = Math.max(1, Math.ceil(len / MAX_POINTS));
        const pts = [];
        for (let i = 0; i < len; i += step) pts.push({ x: i + 1, y: balances[i] });
        if (pts.length && pts[pts.length - 1].x !== len) pts.push({ x: len, y: balances[len - 1] });
        return pts;
    }

    function drawLineChart(spec, trials) {
        const maxLen = trials.reduce((m, t) => Math.max(m, t.balances.length), 1);

        // Evenly stride-sample the trials so the sample spans the whole run.
        const stride = Math.ceil(trials.length / MAX_PLOT_LINES);
        const plotted = trials.filter((_, i) => i % stride === 0);
        const alpha = plotted.length > 150 ? 0.16 : 0.3;

        const datasets = plotted.map((t) => ({
            data: thin(t.balances),
            borderColor: t.busted ? `rgba(255,122,110,${alpha})` : `rgba(88,211,173,${alpha})`,
            borderWidth: 0.6,
            pointRadius: 0,
            tension: 0
        }));

        // Note how many paths are shown vs simulated.
        const titleEl = document.getElementById('lineChartTitle');
        if (titleEl) {
            titleEl.textContent = plotted.length < trials.length
                ? `Bankroll across 1,000 rolls — ${plotted.length} sample paths of ${trials.length.toLocaleString()} trials`
                : `Bankroll across 1,000 rolls — ${trials.length.toLocaleString()} trials`;
        }

        // Buy-in reference line.
        datasets.push({
            data: [{ x: 1, y: spec.buyIn }, { x: maxLen, y: spec.buyIn }],
            borderColor: 'rgba(232,199,115,0.85)',
            borderWidth: 1.4,
            borderDash: [6, 5],
            pointRadius: 0
        });

        const options = baseChartOptions('Roll number', 'Bankroll ($)');
        options.parsing = false;          // data is already {x, y}
        options.scales.x.type = 'linear';
        options.scales.x.min = 1;
        options.scales.x.max = maxLen;

        if (lineChart) lineChart.destroy();
        lineChart = new Chart(dom.lineChart.getContext('2d'), {
            type: 'line',
            data: { datasets },
            options
        });
    }

    function drawHistogram(spec, trials) {
        const ends = trials.map((t) => t.endValue);
        const min = Math.min(...ends, 0);
        const max = Math.max(...ends, spec.buyIn);
        const BUCKETS = 12;
        const span = (max - min) || 1;
        const size = span / BUCKETS;
        const counts = new Array(BUCKETS).fill(0);
        ends.forEach((v) => {
            let idx = Math.floor((v - min) / size);
            if (idx >= BUCKETS) idx = BUCKETS - 1;
            if (idx < 0) idx = 0;
            counts[idx]++;
        });
        const labels = counts.map((_, i) => money(min + i * size));

        if (histChart) histChart.destroy();
        histChart = new Chart(dom.histChart.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: counts,
                    backgroundColor: 'rgba(232,199,115,0.55)',
                    borderColor: 'rgba(232,199,115,0.9)',
                    borderWidth: 1
                }]
            },
            options: Object.assign(baseChartOptions('Ending bankroll', 'Trials'), {
                plugins: { legend: { display: false }, tooltip: { enabled: true } }
            })
        });
    }

    function baseChartOptions(xTitle, yTitle) {
        const grid = 'rgba(245,235,216,0.08)';
        const tick = 'rgba(245,235,216,0.6)';
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            normalized: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: {
                    title: { display: true, text: xTitle, color: tick },
                    grid: { color: grid }, ticks: { color: tick, maxTicksLimit: 11 }
                },
                y: {
                    title: { display: true, text: yTitle, color: tick },
                    grid: { color: grid }, ticks: { color: tick }
                }
            }
        };
    }

    // ---- Wire up ------------------------------------------------------------
    dom.translateBtn.addEventListener('click', translate);
    dom.preset.addEventListener('change', (e) => usePreset(e.target.value));
    dom.runBtn.addEventListener('click', run);
    // Re-render the confirm view (and its odds line) when the odds selector
    // changes, preserving any edited bet amounts.
    dom.oddsMult.addEventListener('change', () => {
        if (!currentIntent) return;
        const spec = buildSpec(true);
        if (spec) renderStrategy(spec);
    });
})();
