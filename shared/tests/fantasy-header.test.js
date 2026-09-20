/**
 * The shared fantasy section nav.
 *
 * It carries the section's whole information architecture: the league is
 * home, your own team is one click from anywhere, and the league-agnostic
 * tools are behind a menu instead of competing for the top of the page. The
 * assertions below are about that shape — plus the older reason this file
 * exists, which is that the global nav marks itself aria-current on every
 * fantasy page, so the nav inside the section has to be the one that works.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function loadFresh() {
    jest.resetModules();
    delete window.FantasyHeader;
    require("../fantasy-header.js");
    return window.FantasyHeader;
}

function mountAt(pathname, options) {
    document.body.innerHTML = '<div id="fantasy-header-mount"></div>';
    window.history.replaceState({}, "", pathname);
    return loadFresh().mount(options || {});
}

const primary = () =>
    [...document.querySelectorAll(".fantasy-header__links > .fantasy-header__link")].map(
        (node) => ({
            label: node.textContent,
            href: node.getAttribute("href"),
            current: node.getAttribute("aria-current"),
            tag: node.tagName,
        })
    );

const toolsButton = () => document.querySelector(".fantasy-header__tools-button");
const toolsMenu = () => document.querySelector(".fantasy-header__menu");
const toolLinks = () =>
    [...document.querySelectorAll(".fantasy-header__menu-link")].map((node) => ({
        label: node.querySelector(".fantasy-header__menu-label").textContent,
        href: node.getAttribute("href"),
        current: node.getAttribute("aria-current"),
    }));

describe("fantasy header", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("the primary slots are the league, your team, and the tools menu", () => {
        mountAt("/fantasy/", { page: "home" });
        expect(primary().map((slot) => slot.label)).toEqual(["Home", "My Team"]);
        expect(toolsButton().textContent).toContain("Tools");
    });

    test("your own team is one click away from every page in the section", () => {
        ["/fantasy/", "/fantasy/market/", "/fantasy/rankings/", "/fantasy/week/"].forEach(
            (pathname) => {
                mountAt(pathname);
                const myTeam = primary().find((slot) => slot.label === "My Team");
                expect(myTeam.href).toBe("/fantasy/?team=me");
            }
        );
    });

    test("the league-agnostic tools all live in the menu", () => {
        mountAt("/fantasy/", { page: "home" });
        expect(toolLinks()).toEqual([
            { label: "Implied Value", href: "/fantasy/market/", current: null },
            { label: "My Rankings", href: "/fantasy/rankings/", current: null },
            { label: "Fourth & Fortune", href: "/fantasy/draft-order/", current: null },
        ]);
    });

    test("the menu starts closed and toggles on the button", () => {
        mountAt("/fantasy/", { page: "home" });
        expect(toolsMenu().hidden).toBe(true);
        expect(toolsButton().getAttribute("aria-expanded")).toBe("false");

        toolsButton().click();
        expect(toolsMenu().hidden).toBe(false);
        expect(toolsButton().getAttribute("aria-expanded")).toBe("true");

        toolsButton().click();
        expect(toolsMenu().hidden).toBe(true);
    });

    test("Escape closes the menu and puts focus back on its button", () => {
        mountAt("/fantasy/", { page: "home" });
        toolsButton().click();
        toolsMenu().dispatchEvent(
            new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        expect(toolsMenu().hidden).toBe(true);
        expect(document.activeElement).toBe(toolsButton());
    });

    test("a click outside closes the menu", () => {
        mountAt("/fantasy/", { page: "home" });
        toolsButton().click();
        document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        expect(toolsMenu().hidden).toBe(true);
    });

    test("on a tool page the menu button and that tool are both marked", () => {
        mountAt("/fantasy/rankings/", { page: "rankings" });
        expect(toolsButton().classList.contains("is-current")).toBe(true);
        const current = toolLinks().find((tool) => tool.current === "page");
        expect(current.label).toBe("My Rankings");
    });

    test("on the league home, Home is marked and is not a link", () => {
        mountAt("/fantasy/", { page: "home" });
        const home = primary().find((slot) => slot.label === "Home");
        expect(home.tag).toBe("SPAN");
        expect(home.current).toBe("page");
        expect(home.href).toBeNull();
    });

    test("the league's sub-pages mark nothing, so Home stays a live way back", () => {
        ["/fantasy/week/", "/fantasy/draft-recap/"].forEach((pathname) => {
            mountAt(pathname);
            const home = primary().find((slot) => slot.label === "Home");
            expect(home.tag).toBe("A");
            expect(home.href).toBe("/fantasy/");
            expect(toolsButton().classList.contains("is-current")).toBe(false);
        });
    });

    test("the section is inferred from the path when it is not passed", () => {
        // /fantasy/ prefixes every path here, so this is really a test that
        // the longest route wins rather than the first one.
        mountAt("/fantasy/market/");
        expect(toolLinks().find((tool) => tool.current === "page").label).toBe(
            "Implied Value"
        );
        mountAt("/fantasy/draft-order/");
        expect(toolLinks().find((tool) => tool.current === "page").label).toBe(
            "Fourth & Fortune"
        );
        mountAt("/fantasy/");
        expect(primary().find((slot) => slot.current === "page").label).toBe("Home");
    });

    test("mounting twice replaces the nav rather than stacking two", () => {
        mountAt("/fantasy/rankings/", { page: "rankings" });
        window.FantasyHeader.mount({ page: "rankings" });
        expect(document.querySelectorAll(".fantasy-header__inner")).toHaveLength(1);
    });

    test("a page with no mount point is a no-op, not a crash", () => {
        document.body.innerHTML = "";
        expect(loadFresh().mount({})).toBeNull();
    });

    test("every page in the section loads the nav", () => {
        const pages = [
            "fantasy/index.html",
            "fantasy/market/index.html",
            "fantasy/rankings/index.html",
            "fantasy/draft-order/index.html",
            "fantasy/week/index.html",
            "fantasy/draft-recap/index.html",
        ];
        pages.forEach((page) => {
            const source = fs.readFileSync(path.join(ROOT, page), "utf8");
            expect(source).toContain('id="fantasy-header-mount"');
            expect(source).toContain("/shared/fantasy-header.js");
            expect(source).toContain("/shared/fantasy-header.css");
        });
    });
});
