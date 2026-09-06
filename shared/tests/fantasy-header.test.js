/**
 * The shared fantasy section strip.
 *
 * It exists because the three fantasy sub-pages had no link back to the
 * dashboard and none to each other, and the global nav marks itself
 * aria-current on all of them — so the only route back announced itself as
 * somewhere you already were. The assertions below are about that: every
 * sibling is reachable, and the page you are on is not a link.
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

const links = () =>
    [...document.querySelectorAll(".fantasy-header__link")].map((node) => ({
        label: node.textContent,
        href: node.getAttribute("href"),
        current: node.getAttribute("aria-current"),
        tag: node.tagName,
    }));

describe("fantasy header", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("every sibling section is one click away, from any of them", () => {
        mountAt("/fantasy/rankings/", { page: "rankings" });
        expect(links().map((link) => link.label)).toEqual([
            "My Rankings",
            "League Hub",
            "Fourth & Fortune",
        ]);
        expect(links().filter((link) => link.href).map((link) => link.href)).toEqual([
            "/fantasy/league/",
            "/fantasy/draft-order/",
        ]);
    });

    test("the way back to the dashboard is a real link on every page", () => {
        ["rankings", "league", "draft-order"].forEach((page) => {
            mountAt(`/fantasy/${page}/`, { page });
            const home = document.querySelector(".fantasy-header__home");
            expect(home.tagName).toBe("A");
            expect(home.getAttribute("href")).toBe("/fantasy/");
            expect(home.textContent).toContain("Fantasy");
        });
    });

    test("the current section is marked, and is not a link", () => {
        mountAt("/fantasy/league/", { page: "league" });
        const current = links().find((link) => link.label === "League Hub");
        expect(current.tag).toBe("SPAN");
        expect(current.current).toBe("page");
        expect(current.href).toBeNull();
    });

    test("the section is inferred from the path when it is not passed", () => {
        mountAt("/fantasy/draft-order/");
        const current = links().find((link) => link.current === "page");
        expect(current.label).toBe("Fourth & Fortune");
    });

    test("mounting twice replaces the strip rather than stacking two", () => {
        mountAt("/fantasy/rankings/", { page: "rankings" });
        window.FantasyHeader.mount({ page: "rankings" });
        expect(document.querySelectorAll(".fantasy-header__inner")).toHaveLength(1);
    });

    test("a page with no mount point is a no-op, not a crash", () => {
        document.body.innerHTML = "";
        expect(loadFresh().mount({})).toBeNull();
    });

    test("each spoke loads the strip and the dashboard does not", () => {
        const spokes = [
            "fantasy/rankings/index.html",
            "fantasy/league/index.html",
            "fantasy/draft-order/index.html",
        ];
        spokes.forEach((page) => {
            const source = fs.readFileSync(path.join(ROOT, page), "utf8");
            expect(source).toContain('id="fantasy-header-mount"');
            expect(source).toContain("/shared/fantasy-header.js");
            expect(source).toContain("/shared/fantasy-header.css");
        });
        // /fantasy/ is the lobby: it carries the tool grid instead, exactly as
        // /casino/ does not mount the casino header.
        const dashboard = fs.readFileSync(path.join(ROOT, "fantasy/index.html"), "utf8");
        expect(dashboard).not.toContain("fantasy-header");
    });
});
