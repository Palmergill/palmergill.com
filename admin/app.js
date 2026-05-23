// Admin dashboard, analytics, and logs
(function () {
    'use strict';

    const AUTO_REFRESH_MS = 3000;

    const els = {
        viewTabs: document.querySelectorAll('[data-view]'),
        dashboardView: document.getElementById('dashboardView'),
        analyticsView: document.getElementById('analyticsView'),
        logsView: document.getElementById('logsView'),
        status: document.getElementById('status'),
        windowSelect: document.getElementById('windowSelect'),
        refreshBtn: document.getElementById('refreshBtn'),
        metricPageViews: document.getElementById('metricPageViews'),
        metricVisitors: document.getElementById('metricVisitors'),
        metricSuccess: document.getElementById('metricSuccess'),
        metricWarning: document.getElementById('metricWarning'),
        metricError: document.getElementById('metricError'),
        metricAdmin: document.getElementById('metricAdmin'),
        metricDuration: document.getElementById('metricDuration'),
        timelineChart: document.getElementById('timelineChart'),
        trafficChart: document.getElementById('trafficChart'),
        outcomeChart: document.getElementById('outcomeChart'),
        appsChart: document.getElementById('appsChart'),
        recentErrors: document.getElementById('recentErrors'),
        errorGroups: document.getElementById('errorGroups'),
        slowRequests: document.getElementById('slowRequests'),
        topPages: document.getElementById('topPages'),
        topApps: document.getElementById('topApps'),
        topReferrers: document.getElementById('topReferrers'),
        topEvents: document.getElementById('topEvents'),
        retentionStatus: document.getElementById('retentionStatus'),
        eventTypeFilter: document.getElementById('eventTypeFilter'),
        outcomeFilter: document.getElementById('outcomeFilter'),
        appFilter: document.getElementById('appFilter'),
        analyticsSearch: document.getElementById('analyticsSearch'),
        analyticsLimit: document.getElementById('analyticsLimit'),
        exportAnalyticsBtn: document.getElementById('exportAnalyticsBtn'),
        analyticsBody: document.getElementById('analyticsBody'),
        logTabBtns: document.querySelectorAll('[data-log-tab]'),
        dbSection: document.getElementById('dbLogsSection'),
        fileSection: document.getElementById('fileLogsSection'),
        dbBody: document.getElementById('dbLogsBody'),
        fileLogsPre: document.getElementById('fileLogsPre'),
        levelFilter: document.getElementById('levelFilter'),
        logOutcomeFilter: document.getElementById('logOutcomeFilter'),
        searchInput: document.getElementById('searchInput'),
        limitInput: document.getElementById('limitInput'),
        autoRefresh: document.getElementById('autoRefreshToggle'),
        clearBtn: document.getElementById('clearBtn'),
        exportLogsBtn: document.getElementById('exportLogsBtn'),
    };

    let currentView = 'dashboard';
    let currentLogTab = 'db';
    let refreshTimer = null;
    let lastAnalyticsEntries = [];
    let lastLogEntries = [];
    const charts = {
        traffic: null,
        outcome: null,
        apps: null,
    };
    const inflight = {};

    function escapeHtml(value) {
        if (value == null) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatTime(iso) {
        if (!iso) return '';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return date.toLocaleString(undefined, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    function number(value) {
        return Number(value || 0).toLocaleString();
    }

    function formatDuration(value) {
        const ms = Number(value || 0);
        if (!ms) return '--';
        if (ms < 1000) return `${Math.round(ms)}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    }

    function chartAvailable() {
        return typeof window.Chart !== 'undefined';
    }

    function chartTextColor() {
        return 'rgba(226, 232, 240, 0.82)';
    }

    function gridColor() {
        return 'rgba(148, 163, 184, 0.16)';
    }

    function destroyChart(name) {
        if (charts[name]) {
            charts[name].destroy();
            charts[name] = null;
        }
    }

    function setStatus(message, isError) {
        els.status.textContent = message || '';
        els.status.classList.toggle('is-error', Boolean(isError));
    }

    async function fetchJson(url, key) {
        if (inflight[key]) return null;
        inflight[key] = true;
        try {
            const response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } finally {
            inflight[key] = false;
        }
    }

    function paramsWithWindow() {
        const params = new URLSearchParams();
        params.set('hours', els.windowSelect.value || '24');
        return params;
    }

    async function refreshDashboard() {
        const params = paramsWithWindow();
        try {
            const [summary, timeseries] = await Promise.all([
                fetchJson(`/api/admin/analytics/summary?${params.toString()}`, 'summary'),
                fetchJson(`/api/admin/analytics/timeseries?${params.toString()}`, 'timeseries'),
            ]);
            if (!summary || !timeseries) return;
            renderDashboard(summary, timeseries.points || []);
            refreshRetention();
            refreshDebugPanels();
            setStatus(`Dashboard updated ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            setStatus(`Failed to load dashboard: ${error.message}`, true);
        }
    }

    function renderDashboard(summary, points) {
        els.metricPageViews.textContent = number(summary.page_views);
        els.metricVisitors.textContent = number(summary.unique_visitors);
        els.metricSuccess.textContent = number(summary.success);
        els.metricWarning.textContent = number(summary.warning);
        els.metricError.textContent = number(summary.error);
        els.metricAdmin.textContent = number(summary.admin);
        els.metricDuration.textContent = formatDuration(summary.avg_duration_ms);

        renderTimeline(points);
        renderOutcomeChart(summary);
        renderAppsChart(summary.top_apps || []);
        renderCompactList(els.topPages, summary.top_pages, 'No page views yet', 'page');
        renderCompactList(els.topApps, summary.top_apps, 'No apps tracked yet', 'app');
        renderCompactList(els.topReferrers, summary.top_referrers, 'No referrers yet', 'referrer');
        renderCompactList(els.topEvents, summary.top_events, 'No app events yet', 'event');
        renderRecentErrors(summary.recent_errors || []);
    }

    async function refreshDebugPanels() {
        const params = paramsWithWindow();
        try {
            const [slow, groups] = await Promise.all([
                fetchJson(`/api/admin/analytics/slow?${params.toString()}`, 'slow'),
                fetchJson(`/api/admin/analytics/error-groups?${params.toString()}`, 'errorGroups'),
            ]);
            if (slow) renderSlowRequests(slow.entries || []);
            if (groups) renderErrorGroups(groups.groups || []);
        } catch (_) {
            els.slowRequests.innerHTML = '<div class="empty compact-empty">Slow requests unavailable.</div>';
            els.errorGroups.innerHTML = '<div class="empty compact-empty">Error groups unavailable.</div>';
        }
    }

    function renderTimeline(points) {
        if (!points.length) {
            destroyChart('traffic');
            els.timelineChart.innerHTML = '<div class="empty compact-empty">No traffic in this window.</div>';
            return;
        }
        if (!chartAvailable()) {
            els.timelineChart.innerHTML = '<div class="empty compact-empty">Chart library unavailable.</div>';
            return;
        }
        if (!els.trafficChart.isConnected) {
            els.timelineChart.innerHTML = '<canvas id="trafficChart"></canvas>';
            els.trafficChart = document.getElementById('trafficChart');
        }

        const labels = points.map((point) => {
            const date = new Date(point.timestamp);
            if (Number.isNaN(date.getTime())) return point.timestamp;
            return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
        });
        const pageViews = points.map((point) => point.page_views || 0);
        const requests = points.map((point) => point.requests || 0);
        const errors = points.map((point) => point.error || 0);

        destroyChart('traffic');
        charts.traffic = new Chart(els.trafficChart, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Page views',
                        data: pageViews,
                        borderColor: '#60a5fa',
                        backgroundColor: 'rgba(96, 165, 250, 0.16)',
                        borderWidth: 2,
                        tension: 0.28,
                        fill: true,
                        pointRadius: 2,
                    },
                    {
                        label: 'Requests',
                        data: requests,
                        borderColor: '#34d399',
                        backgroundColor: 'rgba(52, 211, 153, 0.1)',
                        borderWidth: 2,
                        tension: 0.28,
                        pointRadius: 2,
                    },
                    {
                        label: 'Errors',
                        data: errors,
                        borderColor: '#f87171',
                        backgroundColor: 'rgba(248, 113, 113, 0.12)',
                        borderWidth: 2,
                        tension: 0.2,
                        pointRadius: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: chartTextColor(), boxWidth: 12, usePointStyle: true } },
                    tooltip: { displayColors: true },
                },
                scales: {
                    x: {
                        ticks: { color: chartTextColor(), maxRotation: 0, autoSkip: true },
                        grid: { color: 'transparent' },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: chartTextColor(), precision: 0 },
                        grid: { color: gridColor() },
                    },
                },
            },
        });
    }

    function renderOutcomeChart(summary) {
        destroyChart('outcome');
        if (!chartAvailable() || !els.outcomeChart) return;
        const values = [summary.success || 0, summary.warning || 0, summary.error || 0];
        if (!values.some(Boolean)) return;
        charts.outcome = new Chart(els.outcomeChart, {
            type: 'doughnut',
            data: {
                labels: ['Success', 'Warning', 'Error'],
                datasets: [{
                    data: values,
                    backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'],
                    borderColor: '#111722',
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '64%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: chartTextColor(), boxWidth: 12, usePointStyle: true },
                    },
                },
            },
        });
    }

    function renderAppsChart(items) {
        destroyChart('apps');
        if (!chartAvailable() || !els.appsChart || !items.length) return;
        const top = items.slice(0, 6).reverse();
        charts.apps = new Chart(els.appsChart, {
            type: 'bar',
            data: {
                labels: top.map((item) => item.name),
                datasets: [{
                    label: 'Events',
                    data: top.map((item) => item.count),
                    backgroundColor: 'rgba(96, 165, 250, 0.72)',
                    borderColor: '#60a5fa',
                    borderWidth: 1,
                    borderRadius: 4,
                }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: { color: chartTextColor(), precision: 0 },
                        grid: { color: gridColor() },
                    },
                    y: {
                        ticks: { color: chartTextColor() },
                        grid: { color: 'transparent' },
                    },
                },
            },
        });
    }

    async function refreshRetention() {
        try {
            const data = await fetchJson('/api/admin/retention', 'retention');
            if (!data) return;
            const rows = [
                { name: 'Analytics rows', count: data.analytics_total },
                { name: 'Log rows', count: data.logs_total },
                { name: 'Expired analytics', count: data.analytics_expired },
                { name: 'Expired logs', count: data.logs_expired },
            ];
            renderCompactList(els.retentionStatus, rows, 'No retention data yet');
        } catch (_) {
            els.retentionStatus.innerHTML = '<div class="empty compact-empty">Retention status unavailable.</div>';
        }
    }

    function renderCompactList(container, items, emptyText, action) {
        if (!items || !items.length) {
            container.innerHTML = `<div class="empty compact-empty">${escapeHtml(emptyText)}</div>`;
            return;
        }
        container.innerHTML = items.map((item) => {
            const tag = action ? 'button' : 'div';
            const attrs = action ? ` type="button" data-drilldown="${escapeHtml(action)}" data-value="${escapeHtml(item.name)}"` : '';
            return `
            <${tag} class="compact-row${action ? ' is-clickable' : ''}"${attrs}>
                <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <strong>${number(item.count)}</strong>
            </${tag}>
        `;
        }).join('');
    }

    function renderRecentErrors(errors) {
        if (!errors.length) {
            els.recentErrors.innerHTML = '<div class="empty compact-empty">No errors in this window.</div>';
            return;
        }
        els.recentErrors.innerHTML = errors.map((entry) => `
            <button class="compact-row stacked is-clickable" type="button" data-drilldown="error" data-value="${escapeHtml(entry.path || entry.event_name || '')}">
                <span>${escapeHtml(entry.path || entry.event_name || '(unknown)')}</span>
                <small>${escapeHtml(formatTime(entry.timestamp))} · ${escapeHtml(entry.app || '')} · ${escapeHtml(entry.status_code || 'error')}</small>
            </button>
        `).join('');
    }

    function renderErrorGroups(groups) {
        if (!groups.length) {
            els.errorGroups.innerHTML = '<div class="empty compact-empty">No repeated errors.</div>';
            return;
        }
        els.errorGroups.innerHTML = groups.map((group) => {
            const label = group.path || group.event_name || '(unknown)';
            return `
                <button class="compact-row stacked is-clickable" type="button" data-drilldown="error" data-value="${escapeHtml(label)}">
                    <span title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                    <small>${number(group.count)} hits · ${escapeHtml(group.app || '')} · ${escapeHtml(group.status_code || 'error')}</small>
                </button>
            `;
        }).join('');
    }

    function renderSlowRequests(entries) {
        if (!entries.length) {
            els.slowRequests.innerHTML = '<div class="empty compact-empty">No timed requests yet.</div>';
            return;
        }
        els.slowRequests.innerHTML = entries.map((entry) => {
            const label = entry.path || entry.event_name || '(unknown)';
            return `
                <button class="compact-row stacked is-clickable" type="button" data-drilldown="slow" data-value="${escapeHtml(label)}">
                    <span title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                    <small>${formatDuration(entry.duration_ms)} · ${escapeHtml(entry.method || '')} · ${escapeHtml(entry.status_code || '')}</small>
                </button>
            `;
        }).join('');
    }

    async function refreshApps() {
        try {
            const params = paramsWithWindow();
            const data = await fetchJson(`/api/admin/analytics/apps?${params.toString()}`, 'apps');
            if (!data) return;
            const selected = els.appFilter.value;
            els.appFilter.innerHTML = '<option value="">All</option>' + (data.apps || [])
                .map((app) => `<option value="${escapeHtml(app)}">${escapeHtml(app)}</option>`)
                .join('');
            els.appFilter.value = selected;
        } catch (_) {
            // App filter is helpful but non-critical.
        }
    }

    async function refreshAnalytics() {
        const params = paramsWithWindow();
        if (els.eventTypeFilter.value) params.set('event_type', els.eventTypeFilter.value);
        if (els.outcomeFilter.value) params.set('outcome', els.outcomeFilter.value);
        if (els.appFilter.value) params.set('app', els.appFilter.value);
        if (els.analyticsSearch.value.trim()) params.set('q', els.analyticsSearch.value.trim());
        params.set('limit', els.analyticsLimit.value || '200');

        try {
            await refreshApps();
            const data = await fetchJson(`/api/admin/analytics/events?${params.toString()}`, 'analytics');
            if (!data) return;
            lastAnalyticsEntries = data.entries || [];
            renderAnalyticsRows(data.entries || []);
            setStatus(`${number(data.entries.length)} of ${number(data.total)} analytics events · updated ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            setStatus(`Failed to load analytics: ${error.message}`, true);
        }
    }

    function renderAnalyticsRows(entries) {
        if (!entries.length) {
            els.analyticsBody.innerHTML = '<tr><td colspan="7" class="empty">No analytics events match.</td></tr>';
            return;
        }
        els.analyticsBody.innerHTML = entries.map((entry, index) => {
            const outcome = entry.outcome || 'success';
            const label = entry.path || entry.event_name || '';
            const visitor = entry.is_admin ? 'admin' : (entry.is_authenticated ? 'auth' : 'public');
            const details = [
                entry.event_name && entry.path ? entry.event_name : '',
                entry.method || '',
                entry.duration_ms ? formatDuration(entry.duration_ms) : '',
                entry.ip_address || '',
            ].filter(Boolean).join(' · ');
            return `
                <tr class="expandable-row" data-analytics-index="${index}">
                    <td class="col-time">${escapeHtml(formatTime(entry.timestamp))}</td>
                    <td>${escapeHtml(entry.event_type || '')}</td>
                    <td><span class="level-badge outcome-${escapeHtml(outcome)}">${escapeHtml(outcome)}</span></td>
                    <td>${escapeHtml(entry.app || '')}</td>
                    <td class="col-msg">
                        ${escapeHtml(label)}
                        ${details ? `<small>${escapeHtml(details)}</small>` : ''}
                    </td>
                    <td>${escapeHtml(entry.status_code || '')}</td>
                    <td>${escapeHtml(visitor)}</td>
                </tr>
                <tr class="detail-row hidden" data-detail-for="analytics-${index}">
                    <td colspan="7">${renderAnalyticsDetail(entry)}</td>
                </tr>
            `;
        }).join('');
    }

    function prettyJson(value) {
        if (!value) return '';
        try {
            return JSON.stringify(JSON.parse(value), null, 2);
        } catch (_) {
            return value;
        }
    }

    function renderAnalyticsDetail(entry) {
        const metadata = prettyJson(entry.metadata_json);
        const rows = [
            ['Referrer', entry.referrer],
            ['User agent', entry.user_agent],
            ['IP', entry.ip_address],
            ['Visitor', entry.visitor_id],
            ['Session', entry.session_id],
            ['Username', entry.username],
            ['Duration', entry.duration_ms ? formatDuration(entry.duration_ms) : ''],
        ].filter(([, value]) => value);
        return `
            <div class="detail-panel">
                <div class="detail-grid">
                    ${rows.map(([label, value]) => `
                        <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
                    `).join('')}
                </div>
                ${metadata ? `<pre>${escapeHtml(metadata)}</pre>` : ''}
            </div>
        `;
    }

    async function fetchDbLogs() {
        const params = new URLSearchParams();
        if (els.levelFilter.value) params.set('level', els.levelFilter.value);
        if (els.logOutcomeFilter.value) params.set('outcome', els.logOutcomeFilter.value);
        if (els.searchInput.value.trim()) params.set('q', els.searchInput.value.trim());
        params.set('limit', els.limitInput.value || '200');

        try {
            const data = await fetchJson(`/api/admin/logs?${params.toString()}`, 'dbLogs');
            if (!data) return;
            lastLogEntries = data.entries || [];
            renderDbLogs(data);
            if (currentView === 'logs' && currentLogTab === 'db') {
                setStatus(`${number(data.entries.length)} of ${number(data.total)} log entries · updated ${new Date().toLocaleTimeString()}`);
            }
        } catch (error) {
            if (currentView === 'logs') setStatus(`Failed to load logs: ${error.message}`, true);
        }
    }

    function renderDbLogs(data) {
        if (!data.entries.length) {
            els.dbBody.innerHTML = '<tr><td colspan="7" class="empty">No log entries match.</td></tr>';
            return;
        }
        els.dbBody.innerHTML = data.entries.map((entry, index) => {
            const level = escapeHtml(entry.level || 'INFO');
            const outcome = entry.status_code >= 500 || ['ERROR', 'CRITICAL'].includes(entry.level) ? 'error'
                : entry.status_code >= 400 || entry.level === 'WARNING' ? 'warning'
                    : 'success';
            return `
                <tr class="expandable-row" data-log-index="${index}">
                    <td class="col-time">${escapeHtml(formatTime(entry.timestamp))}</td>
                    <td class="col-level"><span class="level-badge level-${level}">${level}</span></td>
                    <td><span class="level-badge outcome-${outcome}">${escapeHtml(entry.status_code || outcome)}</span></td>
                    <td>${escapeHtml(entry.method || '')}</td>
                    <td class="col-path">${escapeHtml(entry.path || '')}</td>
                    <td class="col-logger">${escapeHtml(entry.logger_name || '')}</td>
                    <td class="col-msg">${escapeHtml(entry.message)}</td>
                </tr>
                <tr class="detail-row hidden" data-detail-for="log-${index}">
                    <td colspan="7">${renderLogDetail(entry)}</td>
                </tr>
            `;
        }).join('');
    }

    function renderLogDetail(entry) {
        const rows = [
            ['Logger', entry.logger_name],
            ['Method', entry.method],
            ['Path', entry.path],
            ['Status', entry.status_code],
            ['Timestamp', formatTime(entry.timestamp)],
        ].filter(([, value]) => value);
        return `
            <div class="detail-panel">
                <div class="detail-grid">
                    ${rows.map(([label, value]) => `
                        <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
                    `).join('')}
                </div>
                <pre>${escapeHtml(entry.message || '')}</pre>
            </div>
        `;
    }

    async function fetchFileLogs() {
        try {
            const limit = els.limitInput.value || '500';
            const data = await fetchJson(`/api/admin/logs/file?lines=${encodeURIComponent(limit)}`, 'fileLogs');
            if (!data) return;
            renderFileLogs(data);
            if (currentView === 'logs' && currentLogTab === 'file') {
                setStatus(`${number(data.lines.length)} lines from ${data.path}`);
            }
        } catch (error) {
            if (currentView === 'logs') setStatus(`Failed to load log file: ${error.message}`, true);
        }
    }

    function renderFileLogs(data) {
        let lines = data.lines || [];
        const level = els.levelFilter.value;
        const query = els.searchInput.value.trim().toLowerCase();
        if (level) lines = lines.filter((line) => line.includes(level));
        if (query) lines = lines.filter((line) => line.toLowerCase().includes(query));
        els.fileLogsPre.textContent = lines.length ? lines.join('\n') : '(no matching lines)';
        els.fileLogsPre.scrollTop = els.fileLogsPre.scrollHeight;
    }

    async function clearDbLogs() {
        if (!confirm('Permanently delete all stored log entries from the database?')) return;
        try {
            const response = await fetch('/api/admin/logs', {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            setStatus(`Deleted ${number(data.deleted)} entries.`);
            refreshCurrent();
        } catch (error) {
            setStatus(`Failed to clear logs: ${error.message}`, true);
        }
    }

    function refreshLogs() {
        if (currentLogTab === 'db') {
            fetchDbLogs();
        } else {
            fetchFileLogs();
        }
    }

    function analyticsParams() {
        const params = paramsWithWindow();
        if (els.eventTypeFilter.value) params.set('event_type', els.eventTypeFilter.value);
        if (els.outcomeFilter.value) params.set('outcome', els.outcomeFilter.value);
        if (els.appFilter.value) params.set('app', els.appFilter.value);
        if (els.analyticsSearch.value.trim()) params.set('q', els.analyticsSearch.value.trim());
        params.set('limit', els.analyticsLimit.value || '200');
        return params;
    }

    function logParams() {
        const params = new URLSearchParams();
        if (els.levelFilter.value) params.set('level', els.levelFilter.value);
        if (els.logOutcomeFilter.value) params.set('outcome', els.logOutcomeFilter.value);
        if (els.searchInput.value.trim()) params.set('q', els.searchInput.value.trim());
        params.set('limit', els.limitInput.value || '200');
        return params;
    }

    function refreshCurrent() {
        if (currentView === 'dashboard') refreshDashboard();
        if (currentView === 'analytics') refreshAnalytics();
        if (currentView === 'logs') refreshLogs();
    }

    function switchView(view) {
        currentView = view;
        els.viewTabs.forEach((button) => button.classList.toggle('active', button.dataset.view === view));
        els.dashboardView.classList.toggle('hidden', view !== 'dashboard');
        els.analyticsView.classList.toggle('hidden', view !== 'analytics');
        els.logsView.classList.toggle('hidden', view !== 'logs');
        refreshCurrent();
        setupAutoRefresh();
    }

    function switchLogTab(tab) {
        currentLogTab = tab;
        els.logTabBtns.forEach((button) => button.classList.toggle('active', button.dataset.logTab === tab));
        els.dbSection.classList.toggle('hidden', tab !== 'db');
        els.fileSection.classList.toggle('hidden', tab !== 'file');
        refreshLogs();
    }

    function setupAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        if (currentView === 'logs' && els.autoRefresh.checked) {
            refreshTimer = setInterval(refreshLogs, AUTO_REFRESH_MS);
        }
    }

    function debounce(fn, delay) {
        let timer;
        return () => {
            clearTimeout(timer);
            timer = setTimeout(fn, delay);
        };
    }

    async function drilldown(type, value) {
        els.eventTypeFilter.value = '';
        els.outcomeFilter.value = '';
        els.analyticsSearch.value = '';
        await refreshApps();

        if (type === 'page') {
            els.eventTypeFilter.value = 'page_view';
            els.analyticsSearch.value = value;
        } else if (type === 'app') {
            els.appFilter.value = value;
        } else if (type === 'event') {
            els.eventTypeFilter.value = 'app_event';
            els.analyticsSearch.value = value;
        } else if (type === 'referrer') {
            els.eventTypeFilter.value = 'page_view';
            els.analyticsSearch.value = value === 'direct' ? '' : value;
        } else if (type === 'error') {
            els.outcomeFilter.value = 'error';
            els.analyticsSearch.value = value || '';
        } else if (type === 'slow') {
            els.eventTypeFilter.value = 'request';
            els.analyticsSearch.value = value || '';
        }

        switchView('analytics');
    }

    els.viewTabs.forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
    els.logTabBtns.forEach((button) => button.addEventListener('click', () => switchLogTab(button.dataset.logTab)));
    els.refreshBtn.addEventListener('click', refreshCurrent);
    els.windowSelect.addEventListener('change', refreshCurrent);
    els.clearBtn.addEventListener('click', clearDbLogs);
    els.autoRefresh.addEventListener('change', setupAutoRefresh);
    els.levelFilter.addEventListener('change', refreshLogs);
    els.logOutcomeFilter.addEventListener('change', refreshLogs);
    els.limitInput.addEventListener('change', refreshLogs);
    els.searchInput.addEventListener('input', debounce(refreshLogs, 250));
    [els.eventTypeFilter, els.outcomeFilter, els.appFilter, els.analyticsLimit].forEach((el) => {
        el.addEventListener('change', refreshAnalytics);
    });
    els.analyticsSearch.addEventListener('input', debounce(refreshAnalytics, 250));
    els.exportAnalyticsBtn.addEventListener('click', () => {
        window.location.assign(`/api/admin/analytics/export?${analyticsParams().toString()}`);
    });
    els.exportLogsBtn.addEventListener('click', () => {
        window.location.assign(`/api/admin/logs/export?${logParams().toString()}`);
    });
    els.dashboardView.addEventListener('click', (event) => {
        const target = event.target.closest('[data-drilldown]');
        if (!target) return;
        drilldown(target.dataset.drilldown, target.dataset.value || '');
    });
    els.analyticsBody.addEventListener('click', (event) => {
        const row = event.target.closest('[data-analytics-index]');
        if (!row) return;
        const detail = els.analyticsBody.querySelector(`[data-detail-for="analytics-${row.dataset.analyticsIndex}"]`);
        if (detail) detail.classList.toggle('hidden');
    });
    els.dbBody.addEventListener('click', (event) => {
        const row = event.target.closest('[data-log-index]');
        if (!row) return;
        const detail = els.dbBody.querySelector(`[data-detail-for="log-${row.dataset.logIndex}"]`);
        if (detail) detail.classList.toggle('hidden');
    });

    refreshDashboard();
})();
