// Admin Logs page
(function () {
    'use strict';

    const AUTO_REFRESH_MS = 3000;

    const els = {
        tabBtns: document.querySelectorAll('.tab-btn'),
        dbSection: document.getElementById('dbLogsSection'),
        fileSection: document.getElementById('fileLogsSection'),
        dbBody: document.getElementById('dbLogsBody'),
        fileLogsPre: document.getElementById('fileLogsPre'),
        levelFilter: document.getElementById('levelFilter'),
        searchInput: document.getElementById('searchInput'),
        limitInput: document.getElementById('limitInput'),
        autoRefresh: document.getElementById('autoRefreshToggle'),
        refreshBtn: document.getElementById('refreshBtn'),
        clearBtn: document.getElementById('clearBtn'),
        status: document.getElementById('status'),
    };

    let currentTab = 'db';
    let refreshTimer = null;
    const inflight = {
        db: false,
        file: false,
    };

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
            month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
    }

    function setStatus(msg, isError) {
        els.status.textContent = msg || '';
        els.status.style.color = isError ? '#fca5a5' : '#94a3b8';
    }

    async function fetchDbLogs() {
        if (inflight.db) return;
        inflight.db = true;
        try {
            const params = new URLSearchParams();
            const level = els.levelFilter.value;
            const q = els.searchInput.value.trim();
            const limit = els.limitInput.value || '200';
            if (level) params.set('level', level);
            if (q) params.set('q', q);
            params.set('limit', limit);

            const res = await fetch(`/api/admin/logs?${params.toString()}`, {
                credentials: 'same-origin',
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            renderDbLogs(data);
            if (currentTab === 'db') {
                setStatus(`${data.entries.length} of ${data.total} entries · updated ${new Date().toLocaleTimeString()}`);
            }
        } catch (err) {
            if (currentTab === 'db') {
                setStatus(`Failed to load logs: ${err.message}`, true);
            }
        } finally {
            inflight.db = false;
        }
    }

    function renderDbLogs(data) {
        if (!data.entries.length) {
            els.dbBody.innerHTML = '<tr><td colspan="4" class="empty">No log entries match.</td></tr>';
            return;
        }
        const rows = data.entries.map((e) => {
            const lvl = escapeHtml(e.level || 'INFO');
            return `
                <tr>
                    <td class="col-time">${escapeHtml(formatTime(e.timestamp))}</td>
                    <td class="col-level"><span class="level-badge level-${lvl}">${lvl}</span></td>
                    <td class="col-logger">${escapeHtml(e.logger_name || '')}</td>
                    <td class="col-msg">${escapeHtml(e.message)}</td>
                </tr>
            `;
        });
        els.dbBody.innerHTML = rows.join('');
    }

    async function fetchFileLogs() {
        if (inflight.file) return;
        inflight.file = true;
        try {
            const limit = els.limitInput.value || '500';
            const res = await fetch(`/api/admin/logs/file?lines=${encodeURIComponent(limit)}`, {
                credentials: 'same-origin',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            renderFileLogs(data);
            if (currentTab === 'file') {
                setStatus(`${data.lines.length} lines from ${data.path}`);
            }
        } catch (err) {
            if (currentTab === 'file') {
                setStatus(`Failed to load log file: ${err.message}`, true);
            }
        } finally {
            inflight.file = false;
        }
    }

    function renderFileLogs(data) {
        let lines = data.lines || [];
        const level = els.levelFilter.value;
        const q = els.searchInput.value.trim().toLowerCase();
        if (level) {
            lines = lines.filter((l) => l.includes(level));
        }
        if (q) {
            lines = lines.filter((l) => l.toLowerCase().includes(q));
        }
        if (!lines.length) {
            els.fileLogsPre.textContent = '(no matching lines)';
            return;
        }
        els.fileLogsPre.textContent = lines.join('\n');
        // Auto-scroll to bottom for live tail effect
        els.fileLogsPre.scrollTop = els.fileLogsPre.scrollHeight;
    }

    function refreshCurrent() {
        if (currentTab === 'db') {
            fetchDbLogs();
        } else {
            fetchFileLogs();
        }
    }

    function setupAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        if (els.autoRefresh.checked) {
            refreshTimer = setInterval(refreshCurrent, AUTO_REFRESH_MS);
        }
    }

    function switchTab(tab) {
        currentTab = tab;
        els.tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        els.dbSection.classList.toggle('hidden', tab !== 'db');
        els.fileSection.classList.toggle('hidden', tab !== 'file');
        refreshCurrent();
    }

    async function clearDbLogs() {
        if (!confirm('Permanently delete all stored log entries from the database?')) return;
        try {
            const res = await fetch('/api/admin/logs', {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setStatus(`Deleted ${data.deleted} entries.`);
            refreshCurrent();
        } catch (err) {
            setStatus(`Failed to clear logs: ${err.message}`, true);
        }
    }

    // Wire up events
    els.tabBtns.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    els.refreshBtn.addEventListener('click', refreshCurrent);
    els.clearBtn.addEventListener('click', clearDbLogs);
    els.autoRefresh.addEventListener('change', setupAutoRefresh);
    els.levelFilter.addEventListener('change', refreshCurrent);
    els.limitInput.addEventListener('change', refreshCurrent);

    let searchDebounce;
    els.searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(refreshCurrent, 250);
    });

    // Initial load
    refreshCurrent();
    setupAutoRefresh();
})();
