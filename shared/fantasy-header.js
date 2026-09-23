// Shared fantasy section nav.
//
// The section has one home now — the league overview at /fantasy/ — and the
// nav says so in three slots: where the league is, where your own team is,
// and a menu for the tools that have nothing to do with any league.
//
// That split is the whole point. Standings, rosters, the scoreboard and the
// weekly recap are facts about one league. Implied value, your ranking board
// and the draft-order game are the same for everybody, so they sit behind
// "Tools" rather than competing with the league for the top of the page.
//
// Usage:
//   <link rel="stylesheet" href="/shared/fantasy-header.css?v=2">
//   <div id="fantasy-header-mount"></div>
//   <script src="/shared/fantasy-header.js?v=5"></script>
//   <script>FantasyHeader.mount({ page: 'home' });</script>
//
// `page` may be omitted — the current section is inferred from the path — but
// passing it keeps the nav correct if a page ever moves.
(function () {
    if (window.FantasyHeader) return;

    const BRAND = "Fantasy";

    let mounted = null;

    // The league's own pages. Home is the only one with a slot; week and
    // draft-recap are reached from the hub, so they mark nothing current and
    // leave Home a live link back.
    const PRIMARY = [
        { key: "home", label: "Home", href: "/fantasy/" },
        // `team=me` rather than a team id: the header has no idea which team
        // is yours and should not have to fetch to find out. The hub already
        // reads /league/me for the ledger highlight, so it resolves this.
        { key: "my-team", label: "My Team", href: "/fantasy/?team=me" },
    ];

    const TOOLS = [
        {
            key: "market",
            label: "Implied Value",
            href: "/fantasy/market/",
            note: "What a player is worth, priced off the betting markets",
        },
        {
            key: "rankings",
            label: "My Rankings",
            href: "/fantasy/rankings/",
            note: "Your own board, kept all season",
        },
        {
            key: "draft-order",
            label: "Fourth & Fortune",
            href: "/fantasy/draft-order/",
            note: "Draft-order game for draft night",
        },
    ];

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

    // A primary slot: a link, unless you are already there, in which case it
    // is text. A link that goes nowhere is what made the global nav unusable
    // from inside this section in the first place.
    function primarySlot(item, page) {
        if (item.key === page) {
            const current = el("span", "fantasy-header__link is-current", item.label);
            current.setAttribute("aria-current", "page");
            return current;
        }
        const link = el("a", "fantasy-header__link", item.label);
        link.href = item.href;
        return link;
    }

    function buildToolsMenu(page, menuId) {
        const wrap = el("div", "fantasy-header__tools");
        const onTool = TOOLS.some((tool) => tool.key === page);

        const button = el("button", "fantasy-header__link fantasy-header__tools-button");
        button.type = "button";
        button.id = `${menuId}-button`;
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-controls", menuId);
        if (onTool) button.classList.add("is-current");
        button.append("Tools");
        const caret = el("span", "fantasy-header__caret", "▾");
        caret.setAttribute("aria-hidden", "true");
        button.appendChild(caret);

        const menu = el("ul", "fantasy-header__menu");
        menu.id = menuId;
        menu.hidden = true;
        menu.setAttribute("aria-labelledby", button.id);

        TOOLS.forEach((tool) => {
            const item = el("li", "fantasy-header__menu-item");
            const link = el("a", "fantasy-header__menu-link");
            link.href = tool.href;
            if (tool.key === page) {
                link.classList.add("is-current");
                link.setAttribute("aria-current", "page");
            }
            link.appendChild(el("strong", "fantasy-header__menu-label", tool.label));
            link.appendChild(el("span", "fantasy-header__menu-note", tool.note));
            item.appendChild(link);
            menu.appendChild(item);
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
            PRIMARY.forEach((item) => links.appendChild(primarySlot(item, page)));
            const tools = buildToolsMenu(page, "fantasy-tools-menu");
            links.appendChild(tools.wrap);
            nav.appendChild(links);

            root.replaceChildren(nav);
            mounted = { root, links, tools, page };
            return { root, page, closeTools: tools.close };
        },

        // The hub is one URL showing either the league or a team, and it
        // switches between them without a page load, so it tells the nav
        // which one it is on. `null` means neither slot is current — someone
        // else's team — which leaves both Home and My Team live links.
        setPage(page) {
            if (!mounted || mounted.page === page) return;
            mounted.page = page;
            const slots = PRIMARY.map((item) => primarySlot(item, page));
            mounted.links
                .querySelectorAll(":scope > .fantasy-header__link")
                .forEach((node) => node.remove());
            mounted.links.prepend(...slots);
        },
    };

    window.FantasyHeader = FantasyHeader;
})();
