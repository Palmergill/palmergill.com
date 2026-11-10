// The Portfolio app's frame: the sidebar (a bottom bar on phones), the account
// corner, and the ticker search in the top bar. Shared by the tracker and
// its Research section. On the tracker the nav's links are ordinary hash
// links, and portfolio.js marks the current one.
(function () {
    const API_BASE = window.API_ORIGIN || '';
    const ROOT = '/portfolio/';
    const RESEARCH = `${ROOT}research/`;

    const ICONS = {
        overview: '<path d="M3 13h7V3H3zM14 21h7V11h-7zM14 7h7V3h-7zM3 21h7v-4H3z"/>',
        holdings: '<path d="M4 6h16M4 12h16M4 18h16"/>',
        gains: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
        income: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1.2-1.6-2-3-2-1.8 0-3 1-3 2.3 0 3.2 6 1.6 6 4.6 0 1.3-1.3 2.1-3 2.1-1.5 0-2.7-.8-3.1-2M12 5.5v13"/>',
        taxes: '<path d="M7 3h10l3 3v15H4V3z"/><path d="M8 12h8M8 16h8M8 8h4"/>',
        research: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        watchlist: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.4L12 17.5l-5.6 3 1.1-6.4L3 9.7l6.2-.9z"/>',
        activity: '<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
        accounts: '<path d="M3 10l9-6 9 6M5 10v9M19 10v9M9.5 10v9M14.5 10v9M3 21h18"/>',
    };
    const GROUPS = [
        ['Portfolio', [
            { tab: 'overview', label: 'Overview', primary: true },
            { tab: 'holdings', label: 'Holdings', primary: true },
            { tab: 'gains', label: 'Performance' },
            { tab: 'income', label: 'Income' },
            { tab: 'taxes', label: 'Taxes' },
        ]],
        ['Markets', [
            { icon: 'research', label: 'Research', href: RESEARCH, primary: true },
            { tab: 'watchlist', label: 'Watchlist', primary: true },
        ]],
        ['Records', [
            { tab: 'activity', label: 'Activity' },
            { tab: 'accounts', label: 'Accounts' },
        ]],
    ];
    const onResearch = window.location.pathname.startsWith(RESEARCH);

    function icon(name) {
        return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    }
    function renderLink(item) {
        const href = item.href || `${ROOT}#${item.tab}`;
        const current = onResearch && item.href === RESEARCH ? ' aria-current="page"' : '';
        return `<a href="${href}"${item.tab ? ` data-tab="${item.tab}"` : ''}${item.primary ? '' : ' data-secondary'}${current}>${icon(item.icon || item.tab)}<span>${item.label}</span></a>`;
    }

    function renderNav() {
        const nav = document.getElementById('appNav');
        nav.innerHTML = `
            <a class="app-nav__brand" href="${ROOT}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2f54eb"/><path d="M5 16l4.5-5 3.5 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Portfolio
            </a>
            <nav class="app-nav__links" id="tabs" aria-label="Portfolio sections">
                ${GROUPS.map(([name, items]) => `<p class="app-nav__group">${name}</p>${items.map(renderLink).join('')}`).join('')}
                <button type="button" class="app-nav__more" id="navMore" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>More</span></button>
            </nav>
            <div class="app-nav__foot">
                <div class="app-nav__user" id="navUser"></div>
                <a href="/">palmergill.com ↗</a>
            </div>`;
        const setOpen = (open) => {
            document.body.classList.toggle('nav-open', open);
            document.getElementById('navMore').setAttribute('aria-expanded', String(open));
        };
        document.getElementById('navMore').addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(!document.body.classList.contains('nav-open'));
        });
        document.addEventListener('click', () => setOpen(false));
    }

    function loginHref() {
        const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        return `/login/?next=${encodeURIComponent(next)}`;
    }
    // Who's signed in ('' for nobody); the Research section waits on this
    // before asking for anything account-owned.
    window.AppSession = fetch('/login/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : {}))
        .then((session) => (session.authenticated ? String(session.username || '').trim() : ''))
        .catch(() => '');

    async function renderAccount() {
        const box = document.getElementById('navUser');
        const username = await window.AppSession;
        if (!username) {
            box.innerHTML = `<a href="${loginHref()}">Sign in</a>`;
            return;
        }
        box.innerHTML = '<span></span><button type="button">Sign out</button>';
        box.querySelector('span').textContent = username;
        box.querySelector('button').addEventListener('click', async () => {
            await fetch('/login/logout', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } }).catch(() => {});
            window.location.assign(loginHref());
        });
    }

    function initSearch() {
        const host = document.getElementById('appSearch');
        if (!host) return;
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        host.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
            <input id="appSearchInput" type="search" placeholder="Research a ticker or company" aria-label="Research a ticker or company" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="appSearchList">
            <kbd>${mac ? '⌘' : 'Ctrl '}K</kbd>
            <ul class="app-search__list" id="appSearchList" role="listbox" hidden></ul>`;
        const input = document.getElementById('appSearchInput');
        const list = document.getElementById('appSearchList');
        let results = [];
        let active = -1;
        let timer = null;
        let latest = 0;

        const go = (ticker) => { window.location.assign(`${RESEARCH}?ticker=${encodeURIComponent(ticker)}`); };
        const close = () => {
            list.hidden = true;
            active = -1;
            input.setAttribute('aria-expanded', 'false');
        };
        const draw = () => {
            list.replaceChildren(...results.map((item, i) => {
                const row = document.createElement('li');
                row.setAttribute('role', 'option');
                row.className = i === active ? 'is-active' : '';
                const ticker = document.createElement('strong');
                ticker.textContent = item.ticker;
                const name = document.createElement('span');
                name.textContent = item.name || '';
                row.append(ticker, name);
                row.addEventListener('mousedown', (event) => { event.preventDefault(); go(item.ticker); });
                return row;
            }));
            list.hidden = !results.length;
            input.setAttribute('aria-expanded', String(!list.hidden));
        };
        const lookup = async (query) => {
            const asked = ++latest;
            try {
                const response = await fetch(`${API_BASE}/api/stocks/search?q=${encodeURIComponent(query)}&limit=8`, { credentials: 'include' });
                if (!response.ok || asked !== latest) return;
                results = (await response.json()).results || [];
                active = -1;
                draw();
            } catch { /* Enter still opens what was typed */ }
        };
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const query = input.value.trim();
            if (!query) { latest += 1; results = []; close(); return; }
            timer = setTimeout(() => lookup(query), 150);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!results.length) return;
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                active = (active + step + results.length) % results.length;
                draw();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                const typed = input.value.trim().toUpperCase();
                const pick = results[active] || results.find((r) => r.ticker === typed) || results[0];
                if (pick) go(pick.ticker);
                else if (typed) go(typed);
            } else if (event.key === 'Escape') {
                close();
                input.blur();
            }
        });
        input.addEventListener('blur', close);
        document.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                input.focus();
                input.select();
            }
        });
    }

    renderNav();
    renderAccount();
    initSearch();
})();
