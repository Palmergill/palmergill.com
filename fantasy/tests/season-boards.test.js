/**
 * Position filtering on the two season market boards.
 *
 * Both boards rank the same market payload and filter it in the browser, so
 * the interesting behaviour is all client side: which chips get built, what
 * the table shows once one is pressed, and what happens when the player set
 * changes underneath a filter that the new set cannot satisfy.
 */
const fs = require("fs");
const path = require("path");

const fantasyDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(fantasyDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(fantasyDir, "index.html"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

function player(name, position, team = "SF") {
    return { player_id: name.toLowerCase(), name, position, team };
}

/** Leaders for the "player market boards" panel, best first. */
const PROP_LEADERS = [
    { player: player("Passer One", "QB"), implied_value: 4800, books: ["kalshi"], book_values: {} },
    { player: player("Runner One", "RB"), implied_value: 1400, books: ["kalshi"], book_values: {} },
    { player: player("Catcher One", "WR"), implied_value: 1300, books: [], book_values: {} },
    { player: player("Runner Two", "RB"), implied_value: 1100, books: [], book_values: {} },
    { player: player("Tight One", "TE"), implied_value: 900, books: [], book_values: {} },
];

/** Leaders for the "implied fantasy points" panel, best first. */
const FANTASY_LEADERS = [
    { player: player("Passer One", "QB"), fantasy_points: 380, yard_points: 300, touchdown_points: 80, markets_used: 2, books: ["kalshi"] },
    { player: player("Runner One", "RB"), fantasy_points: 250, yard_points: 140, touchdown_points: 110, markets_used: 2, books: [] },
    { player: player("Catcher One", "WR"), fantasy_points: 240, yard_points: 130, touchdown_points: 110, markets_used: 2, books: [] },
    { player: player("Runner Two", "RB"), fantasy_points: 200, yard_points: 120, touchdown_points: 80, markets_used: 2, books: [] },
];

function routes(overrides = {}) {
    return {
        "/season-props": {
            market: "passing_yards",
            markets: [{ market: "passing_yards", label: "Passing yards", players: 5 }],
            sources: [],
            leaders: PROP_LEADERS,
        },
        "/season-fantasy-points": {
            scoring: "std",
            sources: [],
            leaders: FANTASY_LEADERS,
        },
        ...overrides,
    };
}

function boot(table) {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", "/fantasy/");
    window.FantasyFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn((url) => {
        const match = Object.keys(table).find((key) => String(url).includes(key));
        // Everything else on the page (state, rankings, trending, betting) is
        // irrelevant here and is allowed to fail into its own empty state.
        if (!match) return response({}, 500);
        return response(table[match]);
    });

    let init;
    const nativeAddEventListener = document.addEventListener.bind(document);
    const listenerSpy = jest.spyOn(document, "addEventListener").mockImplementation(
        (type, listener, options) => {
            if (type === "DOMContentLoaded") init = listener;
            else nativeAddEventListener(type, listener, options);
        }
    );
    window.eval(appSource);
    listenerSpy.mockRestore();
    // jsdom reports readyState "complete", so app.js boots itself on eval and
    // only hands back an init to call when the document is still loading.
    if (init) init();
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the season boards to render");
}

const chips = (id) => [...document.querySelectorAll(`#${id} .chip`)];
const chipLabels = (id) => chips(id).map((chip) => chip.textContent);
const pressed = (id) => (chips(id).find((chip) => chip.getAttribute("aria-pressed") === "true") || {}).textContent;
const rows = (id) => [...document.querySelectorAll(`#${id} tr`)];
const cells = (id) => rows(id).map((row) => [...row.children].map((cell) => cell.textContent));

function click(id, label) {
    chips(id).find((chip) => chip.textContent === label).click();
}

describe("season board position filter", () => {
    describe.each([
        ["player market boards", "seasonPropsPositions", "seasonPropsLeaders", "seasonPropsNote"],
        ["implied fantasy points", "seasonFantasyPositions", "seasonFantasyLeaders", "seasonFantasyNote"],
    ])("%s", (_label, chipsId, bodyId, noteId) => {
        test("offers one chip per position present, All first and pressed", async () => {
            boot(routes());
            await waitFor(() => chips(chipsId).length);
            expect(chipLabels(chipsId)[0]).toBe("All");
            expect(chipLabels(chipsId)).toEqual(expect.arrayContaining(["QB", "RB", "WR"]));
            // Depth-chart order, not the order the leaders happen to arrive in.
            const positions = chipLabels(chipsId).slice(1);
            expect(positions).toEqual([...positions].sort(
                (a, b) => ["QB", "RB", "WR", "TE"].indexOf(a) - ["QB", "RB", "WR", "TE"].indexOf(b)
            ));
            expect(pressed(chipsId)).toBe("All");
        });

        test("counts each position in the chip tooltip", async () => {
            boot(routes());
            await waitFor(() => chips(chipsId).length);
            const rb = chips(chipsId).find((chip) => chip.textContent === "RB");
            expect(rb.title).toBe("2 players");
        });

        test("pressing a chip narrows the table to that position", async () => {
            boot(routes());
            await waitFor(() => rows(bodyId).length);
            const total = rows(bodyId).length;

            click(chipsId, "RB");
            expect(pressed(chipsId)).toBe("RB");
            expect(rows(bodyId).length).toBe(2);
            expect(rows(bodyId).length).toBeLessThan(total);
            cells(bodyId).forEach((row) => expect(row[1]).toContain("RB"));
        });

        test("ranks within the position and keeps the board-wide rank", async () => {
            boot(routes());
            await waitFor(() => rows(bodyId).length);
            click(chipsId, "RB");

            // Runner One is RB1 but 2nd on the whole board; Runner Two is RB2, 4th.
            expect(cells(bodyId).map((row) => row[0])).toEqual(["1", "2"]);
            expect(cells(bodyId)[0][1]).toContain("2 overall");
            expect(cells(bodyId)[1][1]).toContain("4 overall");
        });

        test("drops the overall rank again when the filter clears", async () => {
            boot(routes());
            await waitFor(() => rows(bodyId).length);
            click(chipsId, "RB");
            click(chipsId, "All");

            expect(pressed(chipsId)).toBe("All");
            expect(cells(bodyId).map((row) => row[0])).toEqual(
                rows(bodyId).map((_row, index) => String(index + 1))
            );
            cells(bodyId).forEach((row) => expect(row[1]).not.toContain("overall"));
        });

        test("says how much of the board the filter is showing", async () => {
            boot(routes());
            await waitFor(() => document.getElementById(noteId).textContent);
            click(chipsId, "RB");
            expect(document.getElementById(noteId).textContent).toContain("2 of");
            expect(document.getElementById(noteId).textContent).toContain("RB");
        });

        test("filters without refetching — the rows are already loaded", async () => {
            boot(routes());
            await waitFor(() => rows(bodyId).length);
            const before = window.fetch.mock.calls.length;
            click(chipsId, "RB");
            click(chipsId, "All");
            expect(window.fetch.mock.calls.length).toBe(before);
        });
    });

    test("a filter the next payload cannot satisfy falls back to All", async () => {
        boot(routes());
        await waitFor(() => chips("seasonFantasyPositions").length);
        click("seasonFantasyPositions", "QB");
        expect(pressed("seasonFantasyPositions")).toBe("QB");

        // Switching scoring refetches; this payload has no quarterbacks.
        window.fetch.mockImplementation((url) => {
            if (String(url).includes("/season-fantasy-points")) {
                return response({
                    scoring: "ppr",
                    sources: [],
                    leaders: FANTASY_LEADERS.filter((entry) => entry.player.position !== "QB"),
                });
            }
            return response({}, 500);
        });
        chips("seasonFantasyScoring").find((chip) => chip.textContent === "PPR").click();

        await waitFor(() => !chipLabels("seasonFantasyPositions").includes("QB"));
        expect(pressed("seasonFantasyPositions")).toBe("All");
        expect(rows("seasonFantasyLeaders").length).toBe(3);
    });

    test("a board with no leaders builds no position chips", async () => {
        boot(routes({ "/season-props": { market: "passing_yards", markets: [], sources: [], leaders: [] } }));
        await waitFor(() => document.getElementById("seasonPropsNote").textContent);
        expect(chips("seasonPropsPositions").length).toBe(1);
        expect(chipLabels("seasonPropsPositions")).toEqual(["All"]);
        expect(document.getElementById("seasonPropsNote").textContent)
            .toBe("Nothing is quoted in this category yet.");
    });
});
