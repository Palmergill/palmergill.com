// Shared fantasy section strip: a way back to the dashboard and across to the
// other tools. Mounts under /fantasy/rankings/, /fantasy/league/, and
// /fantasy/draft-order/ so moving between them feels like one section rather
// than three separate pages.
//
// The dashboard itself does not mount it: /fantasy/ is the lobby and already
// carries the tool grid, exactly as /casino/ does not mount casino-header.
//
// Usage:
//   <link rel="stylesheet" href="/shared/fantasy-header.css?v=1">
//   <div id="fantasy-header-mount"></div>
//   <script src="/shared/fantasy-header.js?v=1"></script>
//   <script>FantasyHeader.mount({ page: 'rankings' });</script>
//
// `page` may be omitted — the current section is inferred from the path — but
// passing it keeps the strip correct if a page ever moves.
(function () {
    if (window.FantasyHeader) return;

    const HOME = { href: "/fantasy/", label: "Fantasy" };
    const ITEMS = [
        { key: "rankings", label: "My Rankings", href: "/fantasy/rankings/" },
        { key: "league", label: "League Hub", href: "/fantasy/league/" },
        { key: "draft-order", label: "Fourth & Fortune", href: "/fantasy/draft-order/" },
    ];

    function resolveMount(target) {
        if (!target) return document.getElementById("fantasy-header-mount");
        return typeof target === "string" ? document.querySelector(target) : target;
    }

    function inferPage(path) {
        const match = ITEMS.find((item) => path.startsWith(item.href));
        return match ? match.key : null;
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

            const home = document.createElement("a");
            home.className = "fantasy-header__home";
            home.href = HOME.href;
            const arrow = document.createElement("span");
            arrow.setAttribute("aria-hidden", "true");
            arrow.textContent = "←";
            home.appendChild(arrow);
            home.append(` ${HOME.label}`);
            nav.appendChild(home);

            const links = document.createElement("div");
            links.className = "fantasy-header__links";
            ITEMS.forEach((item) => {
                // The page you are on is not a link. A link that goes nowhere
                // is the thing that made the global nav unusable from here.
                if (item.key === page) {
                    const current = document.createElement("span");
                    current.className = "fantasy-header__link is-current";
                    current.setAttribute("aria-current", "page");
                    current.textContent = item.label;
                    links.appendChild(current);
                    return;
                }
                const link = document.createElement("a");
                link.className = "fantasy-header__link";
                link.href = item.href;
                link.textContent = item.label;
                links.appendChild(link);
            });
            nav.appendChild(links);

            root.replaceChildren(nav);
            return { root, page };
        },
    };

    window.FantasyHeader = FantasyHeader;
})();
