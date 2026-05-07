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

let sessionId = localStorage.getItem('bitcoinChatSessionId');

const starterMessage = {
    role: 'assistant',
    text: 'Ask anything Bitcoin. I use live node data when needed.',
};

function addMessage({ role, text, data, warnings, toolsUsed, loading = false, error = false }) {
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
    } else if (role === 'assistant') {
        renderRichText(el, text);
    } else {
        el.textContent = text;
    }

    if (!loading && role === 'assistant') {
        appendSourceSummary(el, { data, warnings, toolsUsed });
    }

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
}

function appendInline(parent, text) {
    const pattern = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const token = match[0];
        if (token.startsWith('**')) {
            const strong = document.createElement('strong');
            strong.textContent = token.slice(2, -2);
            parent.appendChild(strong);
        } else if (token.startsWith('*')) {
            const em = document.createElement('em');
            em.textContent = token.slice(1, -1);
            parent.appendChild(em);
        } else if (token.startsWith('`')) {
            const code = document.createElement('code');
            code.textContent = token.slice(1, -1);
            parent.appendChild(code);
        } else {
            const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
            const link = document.createElement('a');
            link.textContent = linkMatch[1];
            link.href = linkMatch[2];
            link.rel = 'noopener noreferrer';
            link.target = '_blank';
            parent.appendChild(link);
        }

        lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}

function appendParagraph(parent, lines) {
    if (!lines.length) return;
    const paragraph = document.createElement('p');
    appendInline(paragraph, lines.join(' '));
    parent.appendChild(paragraph);
}

function renderRichText(parent, text) {
    const lines = text.split(/\r?\n/);
    let paragraphLines = [];
    let listEl = null;
    let codeBlock = null;

    lines.forEach((line) => {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            appendParagraph(parent, paragraphLines);
            paragraphLines = [];
            listEl = null;
            if (codeBlock) {
                parent.appendChild(codeBlock);
                codeBlock = null;
            } else {
                codeBlock = document.createElement('pre');
            }
            return;
        }

        if (codeBlock) {
            codeBlock.textContent += `${line}\n`;
            return;
        }

        if (!trimmed) {
            appendParagraph(parent, paragraphLines);
            paragraphLines = [];
            listEl = null;
            return;
        }

        const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
        if (headingMatch) {
            appendParagraph(parent, paragraphLines);
            paragraphLines = [];
            listEl = null;
            const heading = document.createElement('h3');
            appendInline(heading, headingMatch[1]);
            parent.appendChild(heading);
            return;
        }

        const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
        const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (bulletMatch || numberedMatch) {
            appendParagraph(parent, paragraphLines);
            paragraphLines = [];
            const listType = bulletMatch ? 'ul' : 'ol';
            if (!listEl || listEl.tagName.toLowerCase() !== listType) {
                listEl = document.createElement(listType);
                parent.appendChild(listEl);
            }
            const item = document.createElement('li');
            appendInline(item, bulletMatch?.[1] || numberedMatch[1]);
            listEl.appendChild(item);
            return;
        }

        listEl = null;
        paragraphLines.push(trimmed);
    });

    if (codeBlock) {
        parent.appendChild(codeBlock);
    }
    appendParagraph(parent, paragraphLines);
}

function setNodeStatus(text, available = true) {
    const dot = document.createElement('span');
    dot.className = `status-dot${available ? '' : ' muted'}`;
    dot.setAttribute('aria-hidden', 'true');
    nodeStatus.replaceChildren(dot, document.createTextNode(text));
}

function truncate(text, length = 92) {
    if (!text || text.length <= length) return text;
    return `${text.slice(0, length - 3)}...`;
}

function formatSourceLabel(label) {
    return label
        .replace(/^result\./, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatToolName(tool) {
    return tool.replace(/^get_/, '').replace(/_/g, ' ');
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

function appendSourceSummary(parent, { data, toolsUsed, warnings } = {}) {
    const hasData = data && typeof data === 'object' && Object.keys(data).length > 0;
    const hasTools = Boolean(toolsUsed?.length);
    const hasWarnings = Boolean(warnings?.length);

    if (!hasData && !hasTools && !hasWarnings) {
        return;
    }

    const source = document.createElement('div');
    source.className = 'source-summary';

    const heading = document.createElement('div');
    heading.className = 'source-heading';
    heading.textContent = hasTools || hasData ? 'Node-backed context' : 'Note';
    source.appendChild(heading);

    const items = document.createElement('div');
    items.className = 'source-items';

    if (hasTools) {
        const item = document.createElement('span');
        item.textContent = `Tool: ${toolsUsed.map(formatToolName).join(', ')}`;
        items.appendChild(item);
    }

    flattenData(hasData ? data : null).slice(0, 3).forEach(([label, value]) => {
        if (label === 'warnings') return;
        const item = document.createElement('span');
        item.textContent = `${formatSourceLabel(label)}: ${truncate(value, 34)}`;
        items.appendChild(item);
    });

    if (items.childElementCount) {
        source.appendChild(items);
    }

    warnings?.slice(0, 2).forEach((warning) => {
        const warningEl = document.createElement('div');
        warningEl.className = 'source-warning';
        warningEl.textContent = warning;
        source.appendChild(warningEl);
    });

    parent.appendChild(source);
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed with ${response.status}`);
    }
    return response.json();
}

async function refreshStatus() {
    try {
        const status = await fetchJson(`${API_BASE}/status`);
        const source = status.source === 'node' ? 'Node connected' : 'Demo mode';
        setNodeStatus(source, status.source === 'node');
        heightPill.textContent = `Height ${status.blocks ?? '--'}`;
        syncPill.textContent = status.initial_block_download ? 'Syncing' : 'Synced';
        chainPill.textContent = status.chain || 'Mainnet';
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
            data: result.data,
            warnings: result.warnings,
            toolsUsed: result.tools_used,
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
refreshStatus();
