(function () {
    const items = [
        {
            label: "Projects",
            hint: "Site home",
            href: "/",
            icon: "layout-dashboard"
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
            label: "Bitcoin Chat",
            hint: "Node console",
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

    function loadLucide() {
        if (window.lucide?.createIcons) {
            window.lucide.createIcons();
            return;
        }

        const existingScript = document.querySelector("script[data-site-nav-lucide]");
        if (existingScript) {
            existingScript.addEventListener("load", () => window.lucide?.createIcons());
            return;
        }

        const script = document.createElement("script");
        script.src = "https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js";
        script.async = true;
        script.dataset.siteNavLucide = "true";
        script.addEventListener("load", () => window.lucide?.createIcons());
        document.head.appendChild(script);
    }

    function isCurrent(href) {
        const path = window.location.pathname;
        if (href === "/") {
            return path === "/" || path === "/index.html";
        }
        return path === href || path.startsWith(href);
    }

    function close(nav, toggle) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
    }

    function init() {
        if (document.querySelector(".site-nav")) return;

        document.body.classList.add("has-site-nav");

        const nav = document.createElement("nav");
        nav.className = "site-nav";
        nav.setAttribute("aria-label", "Site navigation");

        const links = items.map((item) => {
            const current = isCurrent(item.href) ? ' aria-current="page"' : "";
            return [
                `<a class="site-nav__link" href="${item.href}" title="${item.label}"${current}>`,
                `<span class="site-nav__icon"><i data-lucide="${item.icon}" aria-hidden="true"></i></span>`,
                '<span>',
                `<span class="site-nav__label">${item.label}</span>`,
                `<span class="site-nav__hint">${item.hint}</span>`,
                '</span>',
                '</a>'
            ].join("");
        }).join("");

        nav.innerHTML = [
            '<button class="site-nav__toggle" type="button" aria-label="Open navigation" aria-expanded="false">',
            '<i data-lucide="menu" aria-hidden="true"></i>',
            '</button>',
            '<div class="site-nav__backdrop" aria-hidden="true"></div>',
            '<div class="site-nav__panel">',
            '<a class="site-nav__brand" href="/" title="Palmer Gill"><span>PG</span><span class="site-nav__label">Palmer Gill</span></a>',
            `<div class="site-nav__items">${links}</div>`,
            '</div>'
        ].join("");

        document.body.prepend(nav);
        loadLucide();

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
