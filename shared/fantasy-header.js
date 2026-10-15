// Shared fantasy section nav: the one menu for everything under /fantasy/.
//
// Five slots and a More. League, Standings, Stats and Rosters are views of
// the hub at /fantasy/; My team is your own team page. The quieter league pages
// (free agents, recaps, history) and the tools that are the same for every
// league sit behind More, so the row fits a phone without scrolling.
//
// Usage:
//   <link rel="stylesheet" href="/shared/fantasy-header.css?v=3">
//   <div id="fantasy-header-mount"></div>
//   <script src="/shared/fantasy-header.js?v=6"></script>
//   <script>FantasyHeader.mount({ page: 'home' });</script>
//
// `page` may be omitted — the current section is inferred from the path — but
// passing it keeps the nav correct if a page ever moves.
(function () {
    if (window.FantasyHeader) return;

    const BRAND = "Fantasy";

    let mounted = null;

    // The league's own pages, in the order you reach for them. On the hub
    // these switch views in place (app.js catches the click); from any other
    // page in the section they are ordinary links back to it.
    const PRIMARY = [
        { key: "home", label: "League", href: "/fantasy/" },
        { key: "standings", label: "Standings", href: "/fantasy/?view=standings" },
        { key: "stats", label: "Stats", href: "/fantasy/?view=stats" },
        { key: "rosters", label: "Rosters", href: "/fantasy/?view=rosters" },
        // `team=me` rather than a team id: the header has no idea which team
        // is yours and should not have to fetch to find out. The hub already
        // reads /league/me for the ledger highlight, so it resolves this.
        { key: "my-team", label: "My team", href: "/fantasy/?team=me" },
    ];

    // Everything else sits behind one "More": the league's quieter boards
    // and recaps, then the tools that are the same for every league.
    const MORE = [
        {
            heading: "League",
            items: [
                { key: "free-agents", label: "Free agents", href: "/fantasy/?view=free-agents", note: "Who is still claimable" },
                { key: "week", label: "Weekly recap", href: "/fantasy/week/", note: "The week, written up" },
                { key: "draft-recap", label: "Draft recap", href: "/fantasy/draft-recap/", note: "How every team drafted" },
                { key: "history", label: "History", href: "/fantasy/?view=history", note: "Past seasons and champions" },
            ],
        },
        {
            heading: "Tools",
            items: [
                { key: "market", label: "Implied Value", href: "/fantasy/market/", note: "Player value from the betting markets" },
                { key: "rankings", label: "My Rankings", href: "/fantasy/rankings/", note: "Your own board, kept all season" },
                { key: "draft-order", label: "Fourth & Fortune", href: "/fantasy/draft-order/", note: "Draft-order game for draft night" },
            ],
        },
    ];

    const MORE_KEYS = MORE.flatMap((group) => group.items.map((item) => item.key));

    // Longest path first: every fantasy path starts with /fantasy/, so a
    // plain find() would call every page the home page.
    const ROUTES = [
        { key: "market", href: "/fantasy/market/" },
        { key: "rankings", href: "/fantasy/rankings/" },
        { key: "draft-order", href: "/fantasy/draft-order/" },
        { key: "draft-recap", href: "/fantasy/draft-recap/" },
        { key: "week", href: "/fantasy/week/" },
        { key: "home", href: "/fantasy/" },
    ];

    function resolveMount(target) {
        if (!target) return document.getElementById("fantasy-header-mount");
        return typeof target === "string" ? document.querySelector(target) : target;
    }

    function inferPage(path) {
        const match = ROUTES.find((route) => path.startsWith(route.href));
        return match ? match.key : null;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // Always a link, so the hub can switch views from it; the current one
    // is marked rather than turned into text.
    function primarySlot(item) {
        const link = el("a", "fantasy-header__link", item.label);
        link.href = item.href;
        link.dataset.key = item.key;
        return link;
    }

    function markCurrent(root, page) {
        root.querySelectorAll("[data-key]").forEach((node) => {
            const current = node.dataset.key === page;
            node.classList.toggle("is-current", current);
            if (current) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        });
        const more = root.querySelector(".fantasy-header__tools-button");
        if (more) more.classList.toggle("is-current", MORE_KEYS.includes(page));
    }

    function buildMoreMenu(menuId) {
        const wrap = el("div", "fantasy-header__tools");

        const button = el("button", "fantasy-header__link fantasy-header__tools-button");
        button.type = "button";
        button.id = `${menuId}-button`;
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-controls", menuId);
        button.append("More");
        const caret = el("span", "fantasy-header__caret", "▾");
        caret.setAttribute("aria-hidden", "true");
        button.appendChild(caret);

        const menu = el("ul", "fantasy-header__menu");
        menu.id = menuId;
        menu.hidden = true;
        menu.setAttribute("aria-labelledby", button.id);

        MORE.forEach((group) => {
            const heading = el("li", "fantasy-header__menu-heading", group.heading);
            heading.setAttribute("role", "presentation");
            menu.appendChild(heading);
            group.items.forEach((entry) => {
                const item = el("li", "fantasy-header__menu-item");
                const link = el("a", "fantasy-header__menu-link");
                link.href = entry.href;
                link.dataset.key = entry.key;
                link.appendChild(el("strong", "fantasy-header__menu-label", entry.label));
                link.appendChild(el("span", "fantasy-header__menu-note", entry.note));
                link.addEventListener("click", () => close(false));
                item.appendChild(link);
                menu.appendChild(item);
            });
        });

        function close(refocus) {
            if (menu.hidden) return;
            menu.hidden = true;
            button.setAttribute("aria-expanded", "false");
            if (refocus) button.focus();
        }

        function open() {
            menu.hidden = false;
            button.setAttribute("aria-expanded", "true");
        }

        button.addEventListener("click", () => {
            if (menu.hidden) open();
            else close(false);
        });

        // Escape from anywhere inside the menu, and a click anywhere else,
        // both mean "I am done here".
        wrap.addEventListener("keydown", (event) => {
            if (event.key === "Escape") close(true);
        });
        document.addEventListener("click", (event) => {
            if (!wrap.contains(event.target)) close(false);
        });
        // Tabbing past the last item should close it too, or the menu hangs
        // open behind whatever you moved on to.
        wrap.addEventListener("focusout", (event) => {
            if (!wrap.contains(event.relatedTarget)) close(false);
        });

        wrap.appendChild(button);
        wrap.appendChild(menu);
        return { wrap, button, menu, close };
    }

    const FantasyHeader = {
        mount(options) {
            const root = resolveMount(options && options.mount);
            if (!root) return null;
            const page = (options && options.page) || inferPage(window.location.pathname);

            root.className = "fantasy-header";
            const nav = document.createElement("nav");
            nav.className = "fantasy-header__inner";
            nav.setAttribute("aria-label", "Fantasy sections");

            // A label, not a link: "Home" below it already goes there, and two
            // controls to the same place is one more thing to read past.
            nav.appendChild(el("span", "fantasy-header__brand", BRAND));

            const links = el("div", "fantasy-header__links");
            PRIMARY.forEach((item) => links.appendChild(primarySlot(item)));
            const more = buildMoreMenu("fantasy-tools-menu");
            links.appendChild(more.wrap);
            nav.appendChild(links);
            markCurrent(nav, page);

            root.replaceChildren(nav);
            mounted = { root, nav, more, page };
            return { root, page, closeTools: more.close };
        },

        // The hub is one URL with several views and a team page, and it
        // switches between them without a page load, so it tells the nav
        // which one it is on. `null` marks nothing — someone else's team.
        setPage(page) {
            if (!mounted || mounted.page === page) return;
            mounted.page = page;
            markCurrent(mounted.nav, page);
        },
    };

    window.FantasyHeader = FantasyHeader;
})();
