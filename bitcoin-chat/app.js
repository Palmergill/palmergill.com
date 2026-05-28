// API_BASE = `${API_ORIGIN}/api/bitcoin`. See /shared/api-base.js — for an
// uncommon dev setup where the static site is served separately from FastAPI,
// set `window.PALMER_API_ORIGIN = 'http://localhost:8000'` before this script.
const API_BASE = ((typeof window !== 'undefined' && typeof window.API_ORIGIN === 'string')
    ? window.API_ORIGIN
    : '') + '/api/bitcoin';

const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const nodeStatus = document.getElementById('nodeStatus');
const heightPill = document.getElementById('heightPill');
const syncPill = document.getElementById('syncPill');
const chainPill = document.getElementById('chainPill');
const demoNotice = document.getElementById('demoNotice');
const explorerEls = {
    panel: document.querySelector('.explorer-panel'),
    form: document.getElementById('explorerSearchForm'),
    input: document.getElementById('explorerInput'),
    type: document.getElementById('explorerType'),
    status: document.getElementById('explorerStatus'),
    refresh: document.getElementById('refreshExplorerBtn'),
    latestCard: document.getElementById('latestBlockCard'),
    mempoolCard: document.getElementById('mempoolCard'),
    result: document.getElementById('explorerResult'),
};

// Session id is stored in an HttpOnly cookie issued by /api/bitcoin/chat.
// JavaScript deliberately never receives or sends it; fetch attaches the
// cookie automatically.
// Clean up any session id left in localStorage from before the cookie cutover.
try { localStorage.removeItem('bitcoinChatSessionId'); } catch (_) { /* ignore */ }
const explorerState = {
    latestBlock: null,
    mempool: null,
    lastResult: null,
};
const BITCOIN_ADDRESS_RE = /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;

const starterMessage = {
    role: 'assistant',
    text: 'Ask anything Bitcoin. Public visitors get a protected demo; authenticated sessions can use live Bitcoin data when needed.',
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
    // Count fences up front. An odd number means the model returned an
    // unmatched ``` somewhere; treat the *last* opener as malformed (drop
    // it) so the trailing paragraphs render as prose instead of getting
    // swallowed into a never-closing code block.
    const fenceCount = lines.reduce((n, l) => n + (l.trim().startsWith('```') ? 1 : 0), 0);
    let remainingFenceToggles = fenceCount - (fenceCount % 2);
    let paragraphLines = [];
    let listEl = null;
    let codeBlock = null;

    lines.forEach((line) => {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            if (remainingFenceToggles <= 0) {
                // Unbalanced trailing fence — render the marker as prose.
                paragraphLines.push(trimmed);
                return;
            }
            remainingFenceToggles -= 1;
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
    heading.textContent = hasTools || hasData ? 'Live Bitcoin context' : 'Note';
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

function formatInteger(value) {
    if (value === null || value === undefined || value === '') return '--';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : String(value);
}

function formatBtc(value) {
    if (value === null || value === undefined || value === '') return '--';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `${n.toFixed(n < 0.01 ? 8 : 4)} BTC`;
}

function formatSignedBtc(value) {
    if (value === null || value === undefined || value === '') return '--';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (n === 0) return '0.00000000 BTC';
    const sign = n > 0 ? '+' : '-';
    return `${sign}${Math.abs(n).toFixed(Math.abs(n) < 0.01 ? 8 : 4)} BTC`;
}

function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
    return `${n} B`;
}

function formatTimestamp(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function shortHash(value, left = 10, right = 8) {
    if (!value) return '--';
    const text = String(value);
    if (text.length <= left + right + 3) return text;
    return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function explorerSetStatus(message, isError = false) {
    if (!explorerEls.status) return;
    explorerEls.status.textContent = message || '';
    explorerEls.status.classList.toggle('is-error', Boolean(isError));
}

function statRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = value ?? '--';
    row.append(labelEl, valueEl);
    return row;
}

function appendWarnings(parent, warnings) {
    if (!Array.isArray(warnings) || !warnings.length) return;
    const list = document.createElement('div');
    list.className = 'warning-list';
    warnings.slice(0, 2).forEach((warning) => {
        const item = document.createElement('span');
        item.textContent = warning;
        list.appendChild(item);
    });
    parent.appendChild(list);
}

function cardBody(card) {
    const body = card?.querySelector('.card-body');
    if (!body) return null;
    body.classList.remove('muted');
    body.replaceChildren();
    return body;
}

function renderCardError(card, message) {
    const body = cardBody(card);
    if (!body) return;
    body.classList.add('muted');
    body.textContent = message;
}

function renderLatestBlock(data) {
    if (!data || data.error) {
        renderCardError(explorerEls.latestCard, data?.error || 'Latest block unavailable.');
        return;
    }
    explorerState.latestBlock = data;
    const body = cardBody(explorerEls.latestCard);
    if (!body) return;
    body.append(
        statRow('Height', formatInteger(data.height)),
        statRow('Tx count', formatInteger(data.tx_count)),
        statRow('Mined', formatTimestamp(data.time)),
        statRow('Hash', shortHash(data.hash)),
        statRow('Source', data.source || '--')
    );
    appendWarnings(body, data.warnings);
}

function renderMempool(data) {
    if (!data || data.error) {
        renderCardError(explorerEls.mempoolCard, data?.error || 'Mempool unavailable.');
        return;
    }
    explorerState.mempool = data;
    const body = cardBody(explorerEls.mempoolCard);
    if (!body) return;
    const fees = data.fee_estimates_sats_vb || {};
    const feeRow = document.createElement('div');
    feeRow.className = 'fee-row';
    [
        ['Fast', fees['2']],
        ['Hour', fees['6']],
        ['Economy', fees['12']],
    ].forEach(([label, value]) => {
        const chip = document.createElement('div');
        chip.className = 'fee-chip';
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        const valueEl = document.createElement('strong');
        valueEl.textContent = value === null || value === undefined ? '--' : `${Number(value).toFixed(1)} sats/vB`;
        chip.append(labelEl, valueEl);
        feeRow.appendChild(chip);
    });
    body.append(
        statRow('Transactions', formatInteger(data.tx_count)),
        statRow('Virtual size', formatBytes(data.virtual_size_vb)),
        statRow('Total fees', formatBtc(data.total_fees_btc)),
        feeRow,
        statRow('Source', data.source || '--')
    );
    appendWarnings(body, data.warnings);
}

function renderExplorerResult(kind, data) {
    if (!explorerEls.result) return;
    explorerState.lastResult = { kind, data };
    explorerEls.result.hidden = false;
    explorerEls.result.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'result-heading';
    const title = document.createElement('h3');
    title.textContent = kind === 'tx' ? 'Transaction' : kind === 'address' ? 'Address' : 'Block';
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'card-action';
    ask.dataset.ask = 'result';
    ask.textContent = 'Ask';
    heading.append(title, ask);

    const body = document.createElement('div');
    body.className = 'result-body';
    if (!data || data.error) {
        body.appendChild(statRow('Error', data?.error || 'Lookup failed.'));
        appendWarnings(body, data?.warnings);
        explorerEls.result.append(heading, body);
        return;
    }

    if (kind === 'tx') {
        body.append(
            statRow('Txid', shortHash(data.txid, 12, 12)),
            statRow('Status', data.confirmed ? `${formatInteger(data.confirmations)} confirmations` : 'Unconfirmed'),
            statRow('Block', data.block_height ? formatInteger(data.block_height) : '--'),
            statRow('Inputs / outputs', `${formatInteger(data.input_count)} / ${formatInteger(data.output_count)}`),
            statRow('Total output', formatBtc(data.total_output_btc)),
            statRow('Fee rate', data.fee_rate_sats_vb == null ? '--' : `${Number(data.fee_rate_sats_vb).toFixed(2)} sats/vB`),
            statRow('Source', data.source || '--')
        );
    } else if (kind === 'address') {
        body.append(
            statRow('Address', shortHash(data.address, 14, 12)),
            statRow('Confirmed balance', formatBtc(data.confirmed_balance_btc)),
            statRow('Unconfirmed delta', formatSignedBtc(data.unconfirmed_delta_btc)),
            statRow('Total balance', formatBtc(data.total_balance_btc)),
            statRow('Transactions', `${formatInteger(data.chain_tx_count)} confirmed / ${formatInteger(data.mempool_tx_count)} mempool`),
            statRow('UTXOs', `${formatInteger(data.utxo_count)} current, ${formatInteger(data.utxos_returned)} shown`),
            statRow('Source', data.source || '--')
        );
        appendUtxos(body, data.utxos);
    } else {
        body.append(
            statRow('Height', formatInteger(data.height)),
            statRow('Tx count', formatInteger(data.tx_count)),
            statRow('Mined', formatTimestamp(data.time)),
            statRow('Subsidy', formatBtc(data.subsidy_btc)),
            statRow('Hash', shortHash(data.hash, 12, 12)),
            statRow('Source', data.source || '--')
        );
    }
    appendWarnings(body, data.warnings);
    explorerEls.result.append(heading, body);
}

function appendUtxos(parent, utxos) {
    if (!Array.isArray(utxos) || !utxos.length) return;
    const section = document.createElement('div');
    section.className = 'utxo-list';
    const heading = document.createElement('div');
    heading.className = 'utxo-list-heading';
    heading.textContent = 'Current UTXOs';
    section.appendChild(heading);
    utxos.slice(0, 10).forEach((utxo) => {
        const row = document.createElement('div');
        row.className = 'utxo-row';
        const main = document.createElement('span');
        main.textContent = `${shortHash(utxo.txid, 8, 6)}:${utxo.vout ?? 0}`;
        const value = document.createElement('strong');
        value.textContent = formatBtc(utxo.value_btc);
        const meta = document.createElement('span');
        meta.textContent = utxo.confirmed
            ? `${formatInteger(utxo.confirmations)} conf${utxo.block_height ? ` · #${formatInteger(utxo.block_height)}` : ''}`
            : 'Unconfirmed';
        row.append(main, value, meta);
        section.appendChild(row);
    });
    parent.appendChild(section);
}

function promptForExplorer(kind, data) {
    if (!data || data.error) {
        return 'Explain why this Bitcoin explorer lookup failed and what I should try next.';
    }
    if (kind === 'latest') {
        return `Explain the latest Bitcoin block at height ${data.height}, hash ${data.hash}, with ${data.tx_count} transactions.`;
    }
    if (kind === 'mempool') {
        const fees = data.fee_estimates_sats_vb || {};
        return `Explain the current Bitcoin mempool: ${data.tx_count} transactions, ${formatBtc(data.total_fees_btc)} total fees, and fee estimates of ${fees['2'] ?? '--'}, ${fees['6'] ?? '--'}, and ${fees['12'] ?? '--'} sats/vB.`;
    }
    if (kind === 'tx') {
        return `Explain this Bitcoin transaction: ${data.txid}. Include confirmation status, fee rate, input/output counts, and what can and cannot be inferred.`;
    }
    if (kind === 'address') {
        return `Explain this public Bitcoin address snapshot: ${data.address}. Include confirmed balance, unconfirmed delta, transaction counts, current UTXO count, and avoid inferring ownership or identity.`;
    }
    return `Explain Bitcoin block ${data.height || data.hash}. Include transaction count, subsidy, timestamp, and what this block tells us.`;
}

function askChat(prompt) {
    if (!prompt) return;
    messageInput.value = prompt;
    messageInput.dispatchEvent(new Event('input'));
    chatForm.requestSubmit();
}

async function refreshExplorer() {
    explorerSetStatus('Refreshing chain summaries...');
    try {
        const [latest, mempool] = await Promise.all([
            fetchJson(`${API_BASE}/block/latest`),
            fetchJson(`${API_BASE}/mempool/summary`),
        ]);
        renderLatestBlock(latest);
        renderMempool(mempool);
        explorerSetStatus(`Explorer updated ${new Date().toLocaleTimeString()}`);
    } catch (error) {
        explorerSetStatus(`Explorer refresh failed: ${error.message}`, true);
        renderCardError(explorerEls.latestCard, 'Latest block unavailable.');
        renderCardError(explorerEls.mempoolCard, 'Mempool unavailable.');
    }
}

function inferLookupType(value, selected) {
    if (selected === 'block' || selected === 'tx' || selected === 'address') return selected;
    if (/^\d+$/.test(value)) return 'block';
    if (BITCOIN_ADDRESS_RE.test(value)) return 'address';
    if (/^[a-fA-F0-9]{64}$/.test(value)) return 'tx';
    return null;
}

async function lookupExplorer(value, selectedType) {
    const query = value.trim();
    if (!query) {
        explorerSetStatus('Enter a block height, block hash, transaction id, or Bitcoin address.', true);
        return;
    }
    const type = inferLookupType(query, selectedType);
    if (!type) {
        explorerSetStatus('Use a block height, 64-character hash, transaction id, or Bitcoin address.', true);
        return;
    }

    const loadingText = type === 'tx'
        ? 'Looking up transaction...'
        : type === 'address'
            ? 'Looking up address and UTXOs...'
            : 'Looking up block...';
    explorerSetStatus(loadingText);
    try {
        const data = type === 'tx'
            ? await fetchJson(`${API_BASE}/tx/${encodeURIComponent(query)}`)
            : type === 'address'
                ? await fetchJson(`${API_BASE}/address/${encodeURIComponent(query)}?utxo_limit=25`)
                : await fetchJson(`${API_BASE}/block/${encodeURIComponent(query)}`);
        renderExplorerResult(type, data);
        explorerSetStatus(type === 'tx' ? 'Transaction loaded.' : type === 'address' ? 'Address loaded.' : 'Block loaded.');
        window.pgAnalytics?.track?.('bitcoin_explorer_lookup', { type });
    } catch (error) {
        renderExplorerResult(type, { error: error.message, warnings: [error.message] });
        explorerSetStatus(`Lookup failed: ${error.message}`, true);
        window.pgAnalytics?.track?.('bitcoin_explorer_failed', { type, message: error.message });
    }
}

function wireExplorer() {
    if (!explorerEls.panel) return;
    explorerEls.refresh?.addEventListener('click', () => {
        window.pgAnalytics?.track?.('bitcoin_explorer_refreshed');
        refreshExplorer();
    });
    explorerEls.form?.addEventListener('submit', (event) => {
        event.preventDefault();
        lookupExplorer(explorerEls.input?.value || '', explorerEls.type?.value || 'auto');
    });
    explorerEls.panel.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ask]');
        if (!button) return;
        const askType = button.getAttribute('data-ask');
        if (askType === 'latest') askChat(promptForExplorer('latest', explorerState.latestBlock));
        else if (askType === 'mempool') askChat(promptForExplorer('mempool', explorerState.mempool));
        else if (askType === 'result' && explorerState.lastResult) {
            askChat(promptForExplorer(explorerState.lastResult.kind, explorerState.lastResult.data));
        }
    });
}

async function refreshStatus() {
    try {
        const status = await fetchJson(`${API_BASE}/status`);
        const liveSource = status.source === 'node' || status.source === 'mempool.space';
        if (demoNotice) {
            demoNotice.hidden = status.source !== 'demo';
        }
        const source = status.source === 'node'
            ? 'Node connected'
            : status.source === 'mempool.space'
                ? 'mempool.space connected'
                : 'Demo mode';
        setNodeStatus(source, liveSource);
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
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        const result = await fetchJson(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
        });

        loadingEl.remove();
        addMessage({
            role: 'assistant',
            text: result.answer,
            data: result.data,
            warnings: result.warnings,
            toolsUsed: result.tools_used,
        });
        window.pgAnalytics?.track?.('bitcoin_chat_answered', {
            tools_used: result.tools_used || [],
            warnings: result.warnings?.length || 0,
        });
        await refreshStatus();
    } catch (error) {
        loadingEl.remove();
        addMessage({ role: 'assistant', text: error.message, error: true });
        window.pgAnalytics?.track?.('bitcoin_chat_failed', { message: error.message });
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
    window.pgAnalytics?.track?.('bitcoin_chat_sent', { length: text.length });
    messageInput.value = '';
    messageInput.style.height = 'auto';
    await sendMessage(text);
});

addMessage(starterMessage);

const promptChipsContainer = document.getElementById('promptChips');
if (promptChipsContainer) {
    promptChipsContainer.querySelectorAll('.prompt-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const prompt = chip.getAttribute('data-prompt');
            if (!prompt) return;
            messageInput.value = prompt;
            messageInput.dispatchEvent(new Event('input'));
            chatForm.requestSubmit();
        });
    });
    chatForm.addEventListener('submit', () => {
        promptChipsContainer.hidden = true;
    }, { once: true });
}
wireExplorer();
refreshStatus();
refreshExplorer();
