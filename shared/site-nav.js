(function () {
    const items = [
        {
            label: "Projects",
            hint: "Site home",
            href: "/",
            icon: "layout-dashboard"
        },
        {
            label: "About",
            hint: "Palmer Gill",
            href: "/about/",
            icon: "user-round"
        },
        {
            label: "Stock Research",
            hint: "Market data",
            href: "/stock-research/",
            icon: "chart-candlestick"
        },
        {
            label: "Poker",
            hint: "Texas Hold'em",
            href: "/poker/",
            icon: "spade"
        },
        {
            label: "Craps",
            hint: "Dice table",
            href: "/craps/",
            icon: "dices"
        },
        {
            label: "Blackjack",
            hint: "Vegas table",
            href: "/blackjack/",
            icon: "badge-dollar-sign"
        },
        {
            label: "Bitcoin",
            hint: "Live dashboard",
            href: "/bitcoin-chat/",
            icon: "bitcoin"
        },
        {
            label: "Docs",
            hint: "Site reference",
            href: "/docs/",
            icon: "book-open"
        }
    ];

    const utilityItems = [
        {
            label: "Login",
            hint: "Protected access",
            href: loginHref,
            icon: "log-in"
        }
    ];

    const icons = {
        "layout-dashboard": '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
        "user-round": '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
        "chart-candlestick": '<path d="M9 5v14"/><path d="M15 5v14"/><rect width="4" height="6" x="7" y="7" rx="1"/><rect width="4" height="8" x="13" y="11" rx="1"/><path d="M3 3v18h18"/>',
        "spade": '<path d="M12 3C8 7 5 10 5 14a5 5 0 0 0 9 3 5 5 0 0 0 5-3c0-4-3-7-7-11Z"/><path d="M10 19c0 2-1 3-2 3h8c-1 0-2-1-2-3"/>',
        "dices": '<rect width="12" height="12" x="3" y="3" rx="2"/><rect width="12" height="12" x="9" y="9" rx="2"/><path d="M7 7h.01M13 13h.01M17 17h.01"/>',
        "badge-dollar-sign": '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.78 4.78 4 4 0 0 1-6.74 0 4 4 0 0 1-4.78-4.78 4 4 0 0 1 0-6.75Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
        "bitcoin": '<path d="M11.77 19.5c4.2.7 6.93-.54 7.45-3.18.35-1.8-.5-3.03-2.05-3.74 1.15-.4 1.9-1.25 2.08-2.51.46-3.22-2.38-4.35-6.53-4.93L11.66 5l-.46 2.6 1 .16-.56 3.17-1-.17-.45 2.6 1 .17-.65 3.7-1.06-.18-.46 2.61 2.75.46Z"/><path d="m13.2 8.04 1.18.2c1.38.24 2.16.7 1.95 1.85-.22 1.17-1.09 1.33-2.47 1.1l-1.18-.2.52-2.95Z"/><path d="m12.25 13.42 1.42.24c1.62.28 2.47.85 2.24 2.12-.24 1.35-1.2 1.53-2.82 1.25l-1.42-.24.58-3.37Z"/><path d="m10.52 4.35.35-2M14.5 5.02l.35-2M9.15 21l.35-2M13.13 21.68l.35-2"/>',
        "book-open": '<path d="M12 7v14"/><path d="M3 18a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13Z"/><path d="M21 18a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v13Z"/>',
        "log-in": '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
        menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'
    };

    function iconSvg(name) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.menu}</svg>`;
    }

    function ensureFavicon() {
        if (document.querySelector("link[rel~='icon']")) return;

        const icon = document.createElement("link");
        icon.rel = "icon";
        icon.type = "image/png";
        icon.href = "/assets/palmer-gill-logo-small.png";
        document.head.appendChild(icon);
    }

    function isCurrent(href) {
        if (typeof href === "function") return false;
        const path = window.location.pathname;
        const itemPath = new URL(href, window.location.origin).pathname;
        if (itemPath === "/") {
            return path === "/" || path === "/index.html";
        }
        return path === itemPath || path.startsWith(itemPath);
    }

    function loginHref() {
        if (window.location.pathname === "/login/" || window.location.pathname === "/login") {
            const params = new URLSearchParams(window.location.search);
            const next = params.get("next") || "/";
            return `/login/?next=${encodeURIComponent(next)}`;
        }

        const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        return `/login/?next=${encodeURIComponent(next || "/")}`;
    }

    function close(nav, toggle) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open navigation");
    }

    function init() {
        if (document.querySelector(".site-nav")) return;

        document.body.classList.add("has-site-nav");

        const nav = document.createElement("nav");
        nav.className = "site-nav";
        nav.setAttribute("aria-label", "Site navigation");

        const renderLinks = (navItems) => navItems.map((item) => {
            const href = typeof item.href === "function" ? item.href() : item.href;
            const current = isCurrent(href) ? ' aria-current="page"' : "";
            return [
                `<a class="site-nav__link" href="${href}" title="${item.label}"${current}>`,
                `<span class="site-nav__icon">${iconSvg(item.icon)}</span>`,
                '<span>',
                `<span class="site-nav__label">${item.label}</span>`,
                `<span class="site-nav__hint">${item.hint}</span>`,
                '</span>',
                '</a>'
            ].join("");
        }).join("");

        const links = renderLinks(items);
        const utilityLinks = renderLinks(utilityItems);

        nav.innerHTML = [
            '<button class="site-nav__toggle" type="button" aria-label="Open navigation" aria-expanded="false">',
            iconSvg("menu"),
            '</button>',
            '<a class="site-nav__mobile-brand" href="/" aria-label="palmergill.com home"><img class="site-nav__mobile-logo" src="/assets/palmer-gill-logo-small.png" alt="" aria-hidden="true"><span><span class="site-nav__mobile-title">Palmergill.com</span><span class="site-nav__mobile-subtitle">Projects and tools</span></span></a>',
            '<div class="site-nav__backdrop" aria-hidden="true"></div>',
            '<div class="site-nav__panel">',
            '<a class="site-nav__brand" href="/" title="palmergill.com home"><img class="site-nav__brand-logo" src="/assets/palmer-gill-logo-small.png" alt="" aria-hidden="true"><span class="site-nav__brand-name">Palmergill.com</span></a>',
            `<div class="site-nav__items">${links}</div>`,
            `<div class="site-nav__utility">${utilityLinks}</div>`,
            '</div>'
        ].join("");

        document.body.prepend(nav);
        ensureFavicon();

        const toggle = nav.querySelector(".site-nav__toggle");
        const backdrop = nav.querySelector(".site-nav__backdrop");
        toggle.addEventListener("click", () => {
            const isOpen = nav.classList.toggle("is-open");
            toggle.setAttribute("aria-expanded", String(isOpen));
            toggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
        });
        backdrop.addEventListener("click", () => close(nav, toggle));
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") close(nav, toggle);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
