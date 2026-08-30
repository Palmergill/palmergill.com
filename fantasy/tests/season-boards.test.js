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
    { player: player("Passer One", "QB"), fantasy_points: 380, yard_points: 300, touchdown_points: 80, markets_used: 4, books: ["kalshi"], pairs_used: ["passing", "rushing"], partial_pairs: [], projected_points: 350, projection_delta: 30 },
    { player: player("Runner One", "RB"), fantasy_points: 250, yard_points: 140, touchdown_points: 110, markets_used: 2, books: [], pairs_used: ["rushing"], partial_pairs: ["receiving"], projected_points: 270, projection_delta: -20 },
    { player: player("Catcher One", "WR"), fantasy_points: 240, yard_points: 130, touchdown_points: 110, markets_used: 2, books: [], projected_points: 240, projection_delta: 0 },
    // Quoted by the market, absent from the projection feed.
    { player: player("Runner Two", "RB"), fantasy_points: 200, yard_points: 120, touchdown_points: 80, markets_used: 2, books: [], projected_points: null, projection_delta: null },
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

function boot(table, { keepUrl = false } = {}) {
    document.body.innerHTML = bodySource;
    // Deep-link tests set the query before booting; everything else wants a
    // clean slate, since the app writes its view state back into the URL.
    if (!keepUrl) window.history.replaceState({}, "", "/fantasy/");
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

    test("names the categories behind each implied total", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const meta = [...document.querySelectorAll("#seasonFantasyLeaders .season-leader__meta")]
            .map((node) => node.textContent);
        expect(meta[0]).toContain("passing + rushing");
        expect(meta[0]).not.toContain("markets");
        expect(meta[1]).toContain("rushing");
    });

    test("flags a category the market only half quoted, set apart from the rest", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const rows = [...document.querySelectorAll("#seasonFantasyLeaders tr")];

        // Passer One has both halves of both pairs, so nothing is flagged.
        expect(rows[0].querySelector(".season-leader__gap")).toBeNull();

        // Runner One's receiving markets are incomplete and were discarded.
        const gap = rows[1].querySelector(".season-leader__gap");
        expect(gap).not.toBeNull();
        expect(gap.textContent).toContain("receiving not fully quoted");
    });

    test("shows the market total against the consensus projection", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const row = [...document.querySelectorAll("#seasonFantasyLeaders tr")[0].children]
            .map((cell) => cell.textContent);

        // ... Yard, TD, Rec, Market, Proj, Delta
        expect(row.slice(-3)).toEqual(["380.0", "350.0", "+30"]);
    });

    test("a quoted player with no projection keeps his rank and blanks the comparison", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const rows = [...document.querySelectorAll("#seasonFantasyLeaders tr")];
        const runnerTwo = rows.find((r) => r.textContent.includes("Runner Two"));

        const cells = [...runnerTwo.children].map((c) => c.textContent);
        expect(cells[cells.length - 2]).toBe("\u2014");   // Proj renders an em dash
        expect(cells[cells.length - 1]).toBe("");          // no delta to show
        // He is 4th on market value and stays there.
        expect(rows.indexOf(runnerTwo)).toBe(3);
        expect(cells[0]).toBe("4");
    });

    test("marks whether the market sits over or under consensus", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const deltas = [...document.querySelectorAll("#seasonFantasyLeaders .season-fantasy__delta")];

        expect(deltas[0].className).toContain("is-over");
        expect(deltas[1].className).toContain("is-under");
        expect(deltas[0].title).toContain("%");
    });

    test("an empty market board explains itself instead of showing a bare table", async () => {
        boot(routes({ "/season-fantasy-points": { scoring: "std", sources: [], leaders: [] } }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const cell = document.querySelector("#seasonFantasyLeaders .table-empty");
        expect(cell).not.toBeNull();
        expect(cell.textContent).toContain("No season markets have been collected");
    });

    test("hides the live-markets zone, and its nav link, when nothing is trading", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        expect(document.getElementById("live-markets").hidden).toBe(true);
        expect(document.querySelector('.dashboard-nav a[href="#live-markets"]').hidden).toBe(true);
    });

    test("compares on market value, and says when a player has no market", async () => {
        boot(routes({
            "/compare": {
                season: 2026, week: 0, scoring: "std", source: "consensus",
                players: [
                    { player_id: "passer one", name: "Passer One", position: "QB", team: "SF", projected_points: 350 },
                    { player_id: "nobody", name: "Nobody", position: "QB", team: "NYG", projected_points: 120 },
                ],
            },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);

        // The tray needs two before it will open.
        const buttons = document.querySelectorAll("#seasonFantasyLeaders .row-compare");
        buttons[0].click();
        buttons[1].click();
        expect(document.getElementById("compareTray").hidden).toBe(false);
        document.getElementById("compareGo").click();
        await waitFor(() => document.querySelectorAll(".compare-col").length);

        const cols = [...document.querySelectorAll(".compare-col")];
        const labels = cols.map((c) => [...c.querySelectorAll(".compare-col__proj-label")].map((l) => l.textContent));

        // Market leads; the weekly projection is the supporting number.
        expect(labels[0]).toEqual(["market pts", "season proj"]);
        expect(cols[0].querySelector(".compare-col__proj-value").textContent).toBe("380.0");
        expect(cols[0].querySelector(".compare-col__market-detail").textContent).toContain("passing + rushing");

        // A player the market never quoted says so rather than showing a zero.
        expect(labels[1]).toEqual(["not quoted", "season proj"]);
        expect(cols[1].querySelector(".compare-col__proj-value").textContent).toBe("\u2014");
    });

    test("names the projection source in the column header", async () => {
        boot(routes({
            "/season-fantasy-points": {
                scoring: "std", sources: [], leaders: FANTASY_LEADERS,
                projection_source: "consensus", projection_providers: ["espn", "sleeper"],
            },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const head = document.getElementById("seasonFantasyProjHead");
        expect(head.textContent).toBe("Consensus");
        expect(head.title).toContain("espn, sleeper");
    });

    test("a single provider is named, not called a consensus", async () => {
        boot(routes({
            "/season-fantasy-points": {
                scoring: "std", sources: [], leaders: FANTASY_LEADERS,
                projection_source: "sleeper", projection_providers: null,
            },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        expect(document.getElementById("seasonFantasyProjHead").textContent).toBe("Sleeper");
    });

    test("says how many players a PPR board had to hide", async () => {
        boot(routes({
            "/season-fantasy-points": {
                scoring: "ppr", sources: [], leaders: FANTASY_LEADERS,
                excluded_without_projection: 3,
            },
        }));
        await waitFor(() => document.getElementById("seasonFantasyNote").textContent);
        expect(document.getElementById("seasonFantasyNote").textContent)
            .toContain("3 quoted players hidden — no reception projection");
    });

    describe("sorting", () => {
        const marketCol = () => [...document.querySelectorAll("#seasonFantasyLeaders tr")]
            .map((r) => r.children[r.children.length - 3].textContent);
        const deltaCol = () => [...document.querySelectorAll("#seasonFantasyLeaders tr")]
            .map((r) => r.children[r.children.length - 1].textContent);
        const names = () => [...document.querySelectorAll("#seasonFantasyLeaders .season-leader__name")]
            .map((n) => n.textContent);
        const head = (key) => document.querySelector(`.col-sort[data-sort="${key}"]`);

        test("opens ranked by market value, with that column marked", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            expect(marketCol()).toEqual(["380.0", "250.0", "240.0", "200.0"]);
            expect(head("fantasy_points").closest("th").getAttribute("aria-sort")).toBe("descending");
        });

        test("sorts by delta, biggest gap over consensus first", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            head("projection_delta").click();

            // +30, 0, -20 — and Runner Two, who has no projection, last.
            expect(deltaCol()).toEqual(["+30", "0", "-20", ""]);
            expect(head("projection_delta").closest("th").getAttribute("aria-sort")).toBe("descending");
            expect(head("fantasy_points").closest("th").getAttribute("aria-sort")).toBe("none");
        });

        test("a second click reverses, and blanks stay at the bottom either way", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            head("projection_delta").click();
            head("projection_delta").click();

            expect(deltaCol()).toEqual(["-20", "0", "+30", ""]);
            expect(head("projection_delta").closest("th").getAttribute("aria-sort")).toBe("ascending");
        });

        test("text sorts A-Z first, numbers biggest-first", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            head("player").click();
            expect(names()).toEqual(["Catcher One", "Passer One", "Runner One", "Runner Two"]);
            head("player").click();
            expect(names()).toEqual(["Runner Two", "Runner One", "Passer One", "Catcher One"]);
        });

        test("keeps the board's own rank visible once the view is reordered", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            // In board order there is nothing to disambiguate.
            expect(document.querySelector("#seasonFantasyLeaders .season-leader__meta").textContent)
                .not.toContain("overall");

            head("projection_delta").click();
            expect(document.querySelector("#seasonFantasyLeaders .season-leader__meta").textContent)
                .toContain("1 overall");
        });

        test("sorting never refetches", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            const before = window.fetch.mock.calls.length;
            head("projection_delta").click();
            head("player").click();
            expect(window.fetch.mock.calls.length).toBe(before);
        });

        test("survives a position filter, and rides in the URL", async () => {
            boot(routes());
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            head("projection_delta").click();
            expect(window.location.search).toContain("sort=projection_delta%3Adesc");

            click("seasonFantasyPositions", "RB");
            // Runner One (-20) still ahead of Runner Two (no projection).
            expect(names()).toEqual(["Runner One", "Runner Two"]);
            expect(head("projection_delta").closest("th").getAttribute("aria-sort")).toBe("descending");
        });

        test("boots from a ?sort deep link, and ignores an unknown column", async () => {
            document.body.innerHTML = bodySource;
            window.history.replaceState({}, "", "/fantasy/?sort=player:asc");
            boot(routes(), { keepUrl: true });
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            expect(names()[0]).toBe("Catcher One");

            window.history.replaceState({}, "", "/fantasy/?sort=nonsense:asc");
            boot(routes(), { keepUrl: true });
            await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
            expect(marketCol()[0]).toBe("380.0");
        });
    });

    test("a board with no leaders builds no position chips", async () => {
        boot(routes({ "/season-props": { market: "passing_yards", markets: [], sources: [], leaders: [] } }));
        await waitFor(() => document.getElementById("seasonPropsNote").textContent);
        expect(chips("seasonPropsPositions").length).toBe(1);
        expect(chipLabels("seasonPropsPositions")).toEqual(["All"]);
        expect(document.getElementById("seasonPropsNote").textContent)
            .toBe("Nothing is quoted in this category yet.");
    });

    test("shows ten market rows initially and expands in place", async () => {
        const leaders = Array.from({ length: 12 }, (_, index) => ({
            ...FANTASY_LEADERS[index % FANTASY_LEADERS.length],
            player: player(`Player ${index + 1}`, index % 2 ? "RB" : "WR"),
            fantasy_points: 300 - index,
        }));
        boot(routes({
            "/season-fantasy-points": { scoring: "std", sources: [], leaders },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);

        expect(rows("seasonFantasyLeaders")).toHaveLength(10);
        const toggle = document.getElementById("showAllMarket");
        expect(toggle.textContent).toBe("Show all 12");
        toggle.click();
        expect(rows("seasonFantasyLeaders")).toHaveLength(12);
        expect(toggle.textContent).toBe("Show less");
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    test("restores a raw-market drawer from category state and Escape clears it", async () => {
        document.body.innerHTML = bodySource;
        window.history.replaceState({}, "", "/fantasy/?category=passing_yards");
        boot(routes(), { keepUrl: true });
        await waitFor(() => !document.getElementById("marketsDrawer").hidden);

        expect(window.location.search).toContain("category=passing_yards");
        expect(document.activeElement).toBe(document.getElementById("marketsClose"));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(document.getElementById("marketsDrawer").hidden).toBe(true);
        expect(window.location.search).not.toContain("category=");
    });

    test("renders an unconfigured member hero without explanatory copy", async () => {
        boot(routes({
            "/state": { default_season: 2026, default_week: 1, season: 2026, week: 1, in_season: true },
            "/league/me": { season: 2026, week: 1, scoring: "std", status: "unconfigured", selected_team_id: null, teams: [{ espn_team_id: 1, name: "Fourth & Twenty" }], snapshot: null },
        }));
        await waitFor(() => document.getElementById("memberTeam").textContent === "Choose your team");

        expect(document.getElementById("chooseTeam").hidden).toBe(false);
        expect(document.getElementById("memberMetrics").textContent).toBe("");
    });
});
