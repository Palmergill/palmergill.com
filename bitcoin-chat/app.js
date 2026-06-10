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
const demoNotice = document.getElementById('demoNotice');
const levelSwitch = document.getElementById('levelSwitch');
const learnPaths = document.getElementById('learnPaths');
const lookupToggle = document.getElementById('lookupToggle');
const tiles = {
    chainValue: document.getElementById('chainTileValue'),
    chainCaption: document.getElementById('chainTileCaption'),
    feeValue: document.getElementById('feeTileValue'),
    feeCaption: document.getElementById('feeTileCaption'),
    mempoolValue: document.getElementById('mempoolTileValue'),
    mempoolCaption: document.getElementById('mempoolTileCaption'),
    supplyValue: document.getElementById('supplyTileValue'),
    supplyCaption: document.getElementById('supplyTileCaption'),
};
const explorerEls = {
    drawer: document.getElementById('explorerDrawer'),
    form: document.getElementById('explorerSearchForm'),
    input: document.getElementById('explorerInput'),
    type: document.getElementById('explorerType'),
    status: document.getElementById('explorerStatus'),
    result: document.getElementById('explorerResult'),
};

// Session id is stored in an HttpOnly cookie issued by /api/bitcoin/chat.
// JavaScript deliberately never receives or sends it; fetch attaches the
// cookie automatically.
// Clean up any session id left in localStorage from before the cookie cutover.
try { localStorage.removeItem('bitcoinChatSessionId'); } catch (_) { /* ignore */ }

const LEVELS = ['new', 'curious', 'technical'];
const LEVEL_STORAGE_KEY = 'bitcoinChatLevel';
// A simple 1-input, 2-output segwit payment is ~140 vB; used to translate
// fee rates into an approximate dollar cost in the fee tile.
const TYPICAL_TX_VBYTES = 140;
const HALVING_INTERVAL = 210000;
const TOTAL_SUPPLY_BTC = 21000000;

let explanationLevel = readStoredLevel();
const explorerState = {
    lastResult: null,
};
const BITCOIN_ADDRESS_RE = /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;

const starterMessage = {
    role: 'assistant',
    text: 'Welcome — this is a live window into the Bitcoin network, and I\'ll explain anything you see in plain English. The numbers above update with the real chain. Pick a starting point below, or just ask whatever you\'re wondering.',
};

function addMessage({ role, text, data, warnings, toolsUsed, loading = false, error = false }) {
    const row = document.createElement('div');
    row.className = `msg-row ${role}`;

    if (role === 'assistant') {
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = '₿';
        row.appendChild(avatar);
    }

    const el = document.createElement('article');
    el.className = `message${loading ? ' loading' : ''}${error ? ' error' : ''}`;
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

    row.appendChild(el);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
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
    heading.textContent = hasTools || hasData ? 'live bitcoin context' : 'note';
    source.appendChild(heading);

    const items = document.createElement('div');
    items.className = 'source-items';

    if (hasTools) {
        const item = document.createElement('span');
        item.textContent = `tool: ${toolsUsed.map(formatToolName).join(', ')}`;
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

function relativeMinutes(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return `${hours}h ago`;
}

function shortHash(value, left = 10, right = 8) {
    if (!value) return '--';
    const text = String(value);
    if (text.length <= left + right + 3) return text;
    return `${text.slice(0, left)}...${text.slice(-right)}`;
}

// Cumulative coins issued after `height` blocks, walking the halving
// schedule (50 BTC, then 25, then 12.5, ...).
function issuedSupplyBtc(height) {
    if (!Number.isFinite(height) || height < 0) return null;
    let supply = 0;
    let subsidy = 50;
    let remaining = height + 1;
    while (remaining > 0 && subsidy > 1e-9) {
        const blocksInEpoch = Math.min(remaining, HALVING_INTERVAL);
        supply += blocksInEpoch * subsidy;
        remaining -= blocksInEpoch;
        subsidy /= 2;
    }
    return supply;
}

function feeBusynessLabel(satsVb) {
    if (satsVb < 5) return 'a very cheap moment to transact';
    if (satsVb < 20) return 'a cheap day to transact';
    if (satsVb < 80) return 'a typical day to transact';
    return 'a busy, expensive day to transact';
}

function renderChainTile(block) {
    if (!block || block.error) {
        tiles.chainValue.textContent = '--';
        tiles.chainCaption.textContent = 'chain data unavailable right now';
        return;
    }
    tiles.chainValue.textContent = formatInteger(block.height);
    const mined = relativeMinutes(block.time);
    tiles.chainCaption.textContent = mined
        ? `blocks ever mined — the last one ${mined}`
        : 'blocks ever mined — a new one ~every 10 min';
}

function renderFeeTile(mempool, price) {
    const fast = Number(mempool?.fee_estimates_sats_vb?.['2']);
    if (!mempool || mempool.error || !Number.isFinite(fast)) {
        tiles.feeValue.textContent = '--';
        tiles.feeCaption.textContent = 'fee data unavailable right now';
        return;
    }
    const usd = Number(price?.usd);
    if (Number.isFinite(usd) && usd > 0) {
        const dollars = (fast * TYPICAL_TX_VBYTES * usd) / 1e8;
        tiles.feeValue.textContent = dollars < 10 ? `~$${dollars.toFixed(2)}` : `~$${Math.round(dollars)}`;
        tiles.feeCaption.textContent = `${fast.toFixed(fast < 10 ? 1 : 0)} sat/vB — ${feeBusynessLabel(fast)}`;
    } else {
        tiles.feeValue.textContent = `${fast.toFixed(fast < 10 ? 1 : 0)} sat/vB`;
        tiles.feeCaption.textContent = `the going rate to confirm within ~20 minutes`;
    }
}

function renderMempoolTile(mempool) {
    if (!mempool || mempool.error) {
        tiles.mempoolValue.textContent = '--';
        tiles.mempoolCaption.textContent = 'mempool data unavailable right now';
        return;
    }
    tiles.mempoolValue.textContent = formatInteger(mempool.tx_count);
    tiles.mempoolCaption.textContent = 'payments queued for the next blocks';
}

function renderSupplyTile(block) {
    const height = Number(block?.height);
    const supply = issuedSupplyBtc(height);
    if (!block || block.error || supply === null) {
        tiles.supplyValue.textContent = '--';
        tiles.supplyCaption.textContent = 'of all 21M bitcoin already exist';
        return;
    }
    tiles.supplyValue.textContent = `${((supply / TOTAL_SUPPLY_BTC) * 100).toFixed(1)}%`;
    tiles.supplyCaption.textContent = `of all 21M bitcoin already exist (${(supply / 1e6).toFixed(2)}M BTC)`;
}

async function refreshTiles() {
    const [blockResult, mempoolResult, priceResult] = await Promise.allSettled([
        fetchJson(`${API_BASE}/block/latest`),
        fetchJson(`${API_BASE}/mempool/summary`),
        fetchJson(`${API_BASE}/price`),
    ]);
    const block = blockResult.status === 'fulfilled' ? blockResult.value : null;
    const mempool = mempoolResult.status === 'fulfilled' ? mempoolResult.value : null;
    const price = priceResult.status === 'fulfilled' ? priceResult.value : null;
    renderChainTile(block);
    renderFeeTile(mempool, price);
    renderMempoolTile(mempool);
    renderSupplyTile(block);
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
    ask.textContent = 'Explain this';
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

function setDrawerOpen(open) {
    if (!explorerEls.drawer) return;
    explorerEls.drawer.hidden = !open;
    lookupToggle?.setAttribute('aria-expanded', String(open));
    if (open) {
        explorerEls.input?.focus();
    }
}

function wireExplorer() {
    if (!explorerEls.drawer) return;
    lookupToggle?.addEventListener('click', () => {
        setDrawerOpen(explorerEls.drawer.hidden);
    });
    document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setDrawerOpen(explorerEls.drawer.hidden);
        } else if (event.key === 'Escape' && !explorerEls.drawer.hidden) {
            setDrawerOpen(false);
        }
    });
    explorerEls.form?.addEventListener('submit', (event) => {
        event.preventDefault();
        lookupExplorer(explorerEls.input?.value || '', explorerEls.type?.value || 'auto');
    });
    explorerEls.drawer.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ask]');
        if (!button) return;
        if (button.getAttribute('data-ask') === 'result' && explorerState.lastResult) {
            askChat(promptForExplorer(explorerState.lastResult.kind, explorerState.lastResult.data));
        }
    });
}

function readStoredLevel() {
    try {
        const stored = localStorage.getItem(LEVEL_STORAGE_KEY);
        if (stored && LEVELS.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    return 'new';
}

function setLevel(level) {
    if (!LEVELS.includes(level)) return;
    explanationLevel = level;
    try { localStorage.setItem(LEVEL_STORAGE_KEY, level); } catch (_) { /* ignore */ }
    levelSwitch?.querySelectorAll('button[data-level]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.level === level));
    });
}

function wireLevelSwitch() {
    if (!levelSwitch) return;
    setLevel(explanationLevel);
    levelSwitch.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-level]');
        if (!button) return;
        setLevel(button.dataset.level);
        window.pgAnalytics?.track?.('bitcoin_chat_level', { level: button.dataset.level });
    });
}

async function refreshStatus() {
    try {
        const status = await fetchJson(`${API_BASE}/status`);
        const liveSource = status.source === 'node' || status.source === 'mempool.space';
        if (demoNotice) {
            demoNotice.hidden = status.source !== 'demo';
        }
        const chain = status.chain || 'mainnet';
        const sync = status.initial_block_download ? 'syncing' : 'synced';
        const source = status.source === 'node'
            ? 'node online'
            : status.source === 'mempool.space'
                ? 'mempool.space online'
                : 'demo mode';
        setNodeStatus(`${source} · ${chain} · ${sync}`, liveSource);
    } catch (error) {
        setNodeStatus('bitcoin data unavailable', false);
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
            level: explanationLevel,
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

// The starter message should sit above the learning-path cards, so render
// it first and then move the (static) cards back to the end of the thread.
addMessage(starterMessage);
if (learnPaths) {
    messagesEl.appendChild(learnPaths);
    learnPaths.querySelectorAll('.learn-card').forEach((card) => {
        card.addEventListener('click', () => {
            askChat(card.getAttribute('data-prompt'));
        });
    });
    chatForm.addEventListener('submit', () => {
        learnPaths.hidden = true;
    }, { once: true });
}

document.querySelectorAll('.tile-question[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
        askChat(button.getAttribute('data-prompt'));
    });
});

wireLevelSwitch();
wireExplorer();
refreshStatus();
refreshTiles();
setInterval(refreshTiles, 120000);
