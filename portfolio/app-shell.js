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
        research: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        activity: '<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
    };
    // Five sections; Analysis and Activity have their own sub-tabs.
    const SECTIONS = [
        { tab: 'overview', label: 'Overview' },
        { tab: 'holdings', label: 'Holdings' },
        { tab: 'gains', icon: 'gains', label: 'Analysis' },
        { tab: 'research', icon: 'research', label: 'Research', href: RESEARCH },
        { tab: 'activity', label: 'Activity' },
    ];
    const onResearch = window.location.pathname.startsWith(RESEARCH);

    function icon(name) {
        return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    }
    function renderLink(item) {
        const href = item.href || `${ROOT}#${item.tab}`;
        const current = onResearch && item.href === RESEARCH ? ' aria-current="page"' : '';
        return `<a href="${href}" data-tab="${item.tab}"${current}>${icon(item.icon || item.tab)}<span>${item.label}</span></a>`;
    }

    function renderNav() {
        const nav = document.getElementById('appNav');
        nav.innerHTML = `
            <a class="app-nav__brand" href="${ROOT}">Portfolio</a>
            <nav class="app-nav__links" id="tabs" aria-label="Portfolio sections">
                ${SECTIONS.map(renderLink).join('')}
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
