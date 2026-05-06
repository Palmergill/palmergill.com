const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000/api/bitcoin'
    : '/api/bitcoin';

const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const nodeStatus = document.getElementById('nodeStatus');
const heightPill = document.getElementById('heightPill');
const syncPill = document.getElementById('syncPill');
const chainPill = document.getElementById('chainPill');
const evidenceStack = document.getElementById('evidenceStack');
const chatPanel = document.querySelector('.chat-panel');

let sessionId = localStorage.getItem('bitcoinChatSessionId');

const starterMessage = {
    role: 'assistant',
    text: 'Ask anything Bitcoin. I use live node data when needed.',
};

function addMessage({ role, text, warnings, toolsUsed, loading = false, error = false }) {
    const el = document.createElement('article');
    el.className = `message ${role}${loading ? ' loading' : ''}${error ? ' error' : ''}`;
    if (loading) {
        const loadingText = document.createElement('span');
        loadingText.textContent = text;
        const dots = document.createElement('span');
        dots.className = 'typing-dots';
        dots.setAttribute('aria-hidden', 'true');
        dots.innerHTML = '<span></span><span></span><span></span>';
        el.append(loadingText, dots);
    } else {
        el.textContent = text;
    }

    if (toolsUsed?.length || warnings?.length) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        if (toolsUsed?.length) {
            const tools = document.createElement('span');
            tools.textContent = `Tools: ${toolsUsed.join(', ')}`;
            meta.appendChild(tools);
        }
        warnings?.forEach((warning) => {
            const warningEl = document.createElement('span');
            warningEl.textContent = warning;
            meta.appendChild(warningEl);
        });
        el.appendChild(meta);
    }

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
}

function setNodeStatus(text, available = true) {
    const dot = document.createElement('span');
    dot.className = `status-dot${available ? '' : ' muted'}`;
    dot.setAttribute('aria-hidden', 'true');
    nodeStatus.replaceChildren(dot, document.createTextNode(text));
}

function compactJson(value) {
    return JSON.stringify(value, null, 0).replace(/\s+/g, ' ');
}

function truncate(text, length = 92) {
    if (!text || text.length <= length) return text;
    return `${text.slice(0, length - 3)}...`;
}

function flattenData(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, entry]) => {
        const label = prefix ? `${prefix}.${key}` : key;
        if (entry === null || typeof entry !== 'object') {
            return [[label, String(entry)]];
        }
        if (Array.isArray(entry)) {
            return [[label, `${entry.length} items`]];
        }
        return flattenData(entry, label);
    });
}

function addEvidenceCard(label, value, code) {
    const card = document.createElement('div');
    card.className = 'evidence-card';

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = value;
    card.append(labelEl, valueEl);

    if (code) {
        const codeEl = document.createElement('code');
        codeEl.textContent = code;
        card.appendChild(codeEl);
    }

    evidenceStack.appendChild(card);
}

function updateEvidence({ data, toolsUsed, warnings } = {}) {
    evidenceStack.replaceChildren();

    if (!data && !toolsUsed?.length && !warnings?.length) {
        const empty = document.createElement('div');
        empty.className = 'evidence-empty';
        empty.textContent = 'No node call for the last answer.';
        evidenceStack.appendChild(empty);
        return;
    }

    if (toolsUsed?.length) {
        addEvidenceCard('Tool call', toolsUsed.join(', '), 'read-only');
    }

    flattenData(data).slice(0, 3).forEach(([label, value]) => {
        addEvidenceCard(label, truncate(value, 34));
    });

    if (data) {
        addEvidenceCard('Response data', 'available', truncate(compactJson(data)));
    }

    warnings?.slice(0, 2).forEach((warning) => {
        addEvidenceCard('Warning', warning);
    });
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed with ${response.status}`);
    }
    return response.json();
}

async function refreshStatus({ updateEvidencePanel = false } = {}) {
    try {
        const status = await fetchJson(`${API_BASE}/status`);
        const source = status.source === 'node' ? 'Node connected' : 'Demo mode';
        setNodeStatus(source, status.source === 'node');
        heightPill.textContent = `Height ${status.blocks ?? '--'}`;
        syncPill.textContent = status.initial_block_download ? 'Syncing' : 'Synced';
        chainPill.textContent = status.chain || 'Mainnet';
        if (updateEvidencePanel) {
            updateEvidence({ data: status, toolsUsed: ['status'], warnings: status.warnings });
        }
    } catch (error) {
        setNodeStatus('Node unavailable', false);
        heightPill.textContent = 'Height --';
        syncPill.textContent = 'Sync --';
        chainPill.textContent = 'Chain --';
    }
}

async function sendMessage(text) {
    addMessage({ role: 'user', text });
    const loadingEl = addMessage({ role: 'assistant', text: 'Working on your question...', loading: true });
    setBusy(true);

    try {
        const payload = {
            message: text,
            session_id: sessionId,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        const result = await fetchJson(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        sessionId = result.session_id;
        localStorage.setItem('bitcoinChatSessionId', sessionId);
        loadingEl.remove();
        addMessage({
            role: 'assistant',
            text: result.answer,
            warnings: result.warnings,
            toolsUsed: result.tools_used,
        });
        updateEvidence({
            data: result.data,
            toolsUsed: result.tools_used,
            warnings: result.warnings,
        });
        await refreshStatus();
    } catch (error) {
        loadingEl.remove();
        addMessage({ role: 'assistant', text: error.message, error: true });
    } finally {
        setBusy(false);
        messageInput.focus();
    }
}

function setBusy(isBusy) {
    chatForm.querySelector('button').disabled = isBusy;
    messageInput.disabled = isBusy;
}

function canScrollMessages() {
    return messagesEl.scrollHeight > messagesEl.clientHeight;
}

function shouldKeepNativeScroll(target) {
    return target.closest('.messages, textarea, pre');
}

function normalizeWheelDelta(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        return event.deltaY * 32;
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        return event.deltaY * messagesEl.clientHeight;
    }
    return event.deltaY;
}

chatPanel.addEventListener('wheel', (event) => {
    if (!canScrollMessages() || shouldKeepNativeScroll(event.target)) return;
    event.preventDefault();
    messagesEl.scrollTop += normalizeWheelDelta(event) * 1.8;
}, { passive: false });

let touchStartY = null;

chatPanel.addEventListener('touchstart', (event) => {
    if (shouldKeepNativeScroll(event.target)) return;
    touchStartY = event.touches[0]?.clientY ?? null;
}, { passive: true });

chatPanel.addEventListener('touchmove', (event) => {
    if (touchStartY === null || !canScrollMessages() || shouldKeepNativeScroll(event.target)) return;
    const currentY = event.touches[0]?.clientY ?? touchStartY;
    const deltaY = touchStartY - currentY;
    if (deltaY === 0) return;
    event.preventDefault();
    messagesEl.scrollTop += deltaY;
    touchStartY = currentY;
}, { passive: false });

chatPanel.addEventListener('touchend', () => {
    touchStartY = null;
});

messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${messageInput.scrollHeight}px`;
});

messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        chatForm.requestSubmit();
    }
});

chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    await sendMessage(text);
});

addMessage(starterMessage);
refreshStatus({ updateEvidencePanel: true });
