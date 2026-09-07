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
    { player: player("Passer One", "QB"), fantasy_points: 380, yard_points: 300, touchdown_points: 80, rushing_points: 90, markets_used: 4, books: ["kalshi"], pairs_used: ["passing", "rushing"], partial_pairs: [], projected_points: 350, projection_delta: 30 },
    { player: player("Runner One", "RB"), fantasy_points: 250, yard_points: 140, touchdown_points: 110, rushing_points: 250, markets_used: 2, books: [], pairs_used: ["rushing"], partial_pairs: ["receiving"], projected_points: 270, projection_delta: -20 },
    { player: player("Catcher One", "WR"), fantasy_points: 240, yard_points: 130, touchdown_points: 110, rushing_points: null, markets_used: 2, books: [], projected_points: 240, projection_delta: 0 },
    // Quoted by the market, absent from the projection feed.
    { player: player("Runner Two", "RB"), fantasy_points: 200, yard_points: 120, touchdown_points: 80, rushing_points: 200, markets_used: 2, books: [], projected_points: null, projection_delta: null },
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
        const row = document.querySelectorAll("#seasonFantasyLeaders tr")[0];
        const decision = (cls) => row.querySelector(`.${cls}`).textContent;

        expect([decision("col-implied"), decision("col-consensus"), decision("col-diff")])
            .toEqual(["380.0", "350.0", "+30"]);
    });

    test("shows the market-implied rushing contribution for quarterbacks", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);

        const head = document.querySelector('.col-sort[data-sort="rushing_points"]');
        const passer = [...document.querySelectorAll("#seasonFantasyLeaders tr")]
            .find((row) => row.textContent.includes("Passer One"));
        const rushingIndex = [...head.closest("tr").children].indexOf(head.closest("th"));

        expect(head.textContent).toBe("Rush pts");
        expect(passer.children[rushingIndex].textContent).toBe("90.0");
    });

    test("does not report zero rushing points when no complete rushing market exists", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);

        const head = document.querySelector('.col-sort[data-sort="rushing_points"]');
        const receiver = [...document.querySelectorAll("#seasonFantasyLeaders tr")]
            .find((row) => row.textContent.includes("Catcher One"));
        const rushingIndex = [...head.closest("tr").children].indexOf(head.closest("th"));

        expect(receiver.children[rushingIndex].textContent).toBe("—");
    });

    test("a quoted player with no projection keeps his rank and blanks the comparison", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const rows = [...document.querySelectorAll("#seasonFantasyLeaders tr")];
        const runnerTwo = rows.find((r) => r.textContent.includes("Runner Two"));

        expect(runnerTwo.querySelector(".col-consensus").textContent).toBe("\u2014");
        expect(runnerTwo.querySelector(".col-diff").textContent).toBe("");
        // He is 4th on market value and stays there.
        expect(rows.indexOf(runnerTwo)).toBe(3);
        expect(runnerTwo.querySelector(".col-rank").textContent).toBe("4");
    });

    test("labels and marks the difference from the projection", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const deltas = [...document.querySelectorAll("#seasonFantasyLeaders .season-fantasy__delta")];
        const head = document.querySelector('.col-sort[data-sort="projection_delta"]');

        expect(head.textContent).toBe("Diff");
        expect(head.dataset.mobileLabel).toBe("Diff");
        expect(deltas[0].className).toContain("is-over");
        expect(deltas[1].className).toContain("is-under");
        expect(deltas[0].title).toContain("%");
    });

    test("an empty market board explains itself instead of showing a bare table", async () => {
        boot(routes({ "/season-fantasy-points": { scoring: "std", sources: [], leaders: [] } }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const cell = document.querySelector("#seasonFantasyLeaders .table-empty");
        expect(cell).not.toBeNull();
        expect(cell.textContent).toContain("No betting lines have been collected");
    });

    test("hides the live-markets disclosure when nothing is trading", async () => {
        boot(routes());
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        expect(document.getElementById("live-markets").hidden).toBe(true);
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

    test("names every averaged projection source in the column header", async () => {
        boot(routes({
            "/season-fantasy-points": {
                scoring: "std", sources: [], leaders: FANTASY_LEADERS,
                projection_source: "consensus", projection_providers: ["espn", "sleeper"],
            },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const head = document.getElementById("seasonFantasyProjHead");
        expect(head.textContent).toBe("ESPN + Sleeper avg");
        expect(head.dataset.mobileLabel).toBe("ESPN+SLP");
        expect(head.title).toContain("per-player average across available data from ESPN and Sleeper");
    });

    test("a single provider is named, not called a consensus", async () => {
        boot(routes({
            "/season-fantasy-points": {
                scoring: "std", sources: [], leaders: FANTASY_LEADERS,
                projection_source: "sleeper", projection_providers: null,
            },
        }));
        await waitFor(() => document.querySelectorAll("#seasonFantasyLeaders tr").length);
        const head = document.getElementById("seasonFantasyProjHead");
        expect(head.textContent).toBe("Sleeper proj");
        expect(head.dataset.mobileLabel).toBe("SLP proj");
        expect(head.title).toContain("from Sleeper");
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
            .map((r) => r.querySelector(".col-implied").textContent);
        const deltaCol = () => [...document.querySelectorAll("#seasonFantasyLeaders tr")]
            .map((r) => r.querySelector(".col-diff").textContent);
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

    // Half PPR is the default because it is the format the league plays, and
    // because standard scoring makes the Rec column a row of zeros — a
    // scoring rule that reads exactly like missing data.

    test("the board opens on half PPR", async () => {
        boot(routes());
        await waitFor(() => rows("seasonFantasyLeaders").length > 0);

        const pressed = chips("seasonFantasyScoring")
            .find((chip) => chip.getAttribute("aria-pressed") === "true");
        expect(pressed.textContent).toBe("Half PPR");

        const asked = window.fetch.mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.includes("/season-fantasy-points"));
        expect(asked.every((url) => url.includes("scoring=half"))).toBe(true);
        // The default is not worth carrying in the URL; anything else is.
        expect(window.location.search).not.toContain("scoring=");
    });

    test("picking another format refetches and says so in the URL", async () => {
        boot(routes());
        await waitFor(() => rows("seasonFantasyLeaders").length > 0);

        click("seasonFantasyScoring", "Standard");
        await waitFor(() =>
            window.fetch.mock.calls.some(([url]) =>
                String(url).includes("/season-fantasy-points") && String(url).includes("scoring=std")
            )
        );

        expect(window.location.search).toContain("scoring=std");
    });

    test("standard scoring drops the Rec column instead of showing zeros", async () => {
        boot(routes());
        await waitFor(() => rows("seasonFantasyLeaders").length > 0);

        const table = document.querySelector(".season-fantasy__table");
        const header = () => table.querySelector("th.col-rec");
        // Half PPR: receptions are worth something, so the column is there.
        expect(table.classList.contains("hide-rec")).toBe(false);
        expect(header()).not.toBeNull();

        click("seasonFantasyScoring", "Standard");
        await waitFor(() => table.classList.contains("hide-rec"));

        // The cells stay in the DOM (the CSS hides them), so the column count
        // and every nth-child rule the phone layout leans on are unchanged.
        expect(header().className).toContain("col-rec");
        expect(rows("seasonFantasyLeaders")[0].querySelectorAll("td")).toHaveLength(17);

        click("seasonFantasyScoring", "PPR");
        await waitFor(() => !table.classList.contains("hide-rec"));
    });

    test("a board sorted by Rec does not stay sorted by a column it hides", async () => {
        document.body.innerHTML = bodySource;
        window.history.replaceState({}, "", "/fantasy/?sort=reception_points:desc");
        boot(routes(), { keepUrl: true });
        await waitFor(() => rows("seasonFantasyLeaders").length > 0);

        click("seasonFantasyScoring", "Standard");
        await waitFor(() => document.querySelector(".season-fantasy__table").classList.contains("hide-rec"));

        expect(window.location.search).not.toContain("reception_points");
    });

    test("a ?scoring deep link wins over the default", async () => {
        document.body.innerHTML = bodySource;
        window.history.replaceState({}, "", "/fantasy/?scoring=ppr");
        boot(routes(), { keepUrl: true });
        await waitFor(() => rows("seasonFantasyLeaders").length > 0);

        const pressed = chips("seasonFantasyScoring")
            .find((chip) => chip.getAttribute("aria-pressed") === "true");
        expect(pressed.textContent).toBe("PPR");
    });

    // The hero is the only place on the public page that knows which team is
    // yours, and start/sit — advice about that exact roster — lives two pages
    // away. These pin the shortcuts that connect them.

    const CONFIGURED_ME = {
        season: 2026,
        week: 1,
        scoring: "std",
        status: "configured",
        selected_team_id: 7,
        teams: [{ espn_team_id: 7, name: "Fourth & Twenty" }],
        snapshot: {
            team: { espn_team_id: 7, name: "Fourth & Twenty", owner_name: "Palmer" },
            record: { wins: 1, losses: 0, ties: 0 },
            opponent: { abbrev: "RIV" },
            power_rank: 3,
            starter_projection: 118.4,
        },
    };

    test("the hero team name opens your own team in the league hub", async () => {
        boot(routes({
            "/state": { default_season: 2026, default_week: 1, season: 2026, week: 1, in_season: true },
            "/league/me": CONFIGURED_ME,
        }));
        await waitFor(() => document.querySelector("#memberTeam a") !== null);

        const link = document.querySelector("#memberTeam a");
        expect(link.textContent).toBe("Fourth & Twenty");
        expect(link.getAttribute("href")).toBe("/fantasy/league/?season=2026&team=7");
    });

    test("members get a way to the free agents they can actually claim", async () => {
        boot(routes({
            "/state": { default_season: 2026, default_week: 1, season: 2026, week: 1, in_season: true },
            "/league/me": CONFIGURED_ME,
        }));
        await waitFor(() => !document.getElementById("leagueFreeAgentsLink").hidden);

        const link = document.getElementById("leagueFreeAgentsLink");
        expect(link.getAttribute("href")).toBe("/fantasy/league/#free-agents");
    });

    test("a visitor with no league sees no link to a members-only board", async () => {
        // /league/me 403s for anyone outside the league, which is the same
        // path a signed-out visitor takes.
        boot(routes({
            "/state": { default_season: 2026, default_week: 1, season: 2026, week: 1, in_season: true },
        }));
        await waitFor(() => document.getElementById("memberStatus").textContent === "Latest market");

        expect(document.getElementById("leagueFreeAgentsLink").hidden).toBe(true);
        expect(document.querySelector("#memberTeam a")).toBeNull();
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

/**
 * The team offense board. Yardage, touchdowns and the points they imply sit
 * on one row, so the interesting behaviour is that the row keeps the two
 * totals and the points column in agreement with the payload — and that a
 * team whose air number is a receiving fallback says so.
 */
describe("team offense board", () => {
    const OFFENSES = {
        season: 2026,
        sources: [],
        teams: [
            {
                team: "KC",
                yards: { total: 5299, air: 4499.5, ground: 799.5, air_source: "passing", players: 2 },
                touchdowns: { total: 44, air: 34.5, ground: 9.5, air_source: "passing", players: 2 },
                points: 454.9,
            },
            {
                team: "CHI",
                yards: { total: 2099, air: 1199.5, ground: 899.5, air_source: "receiving", players: 2 },
                touchdowns: { total: 13, air: 7.5, ground: 5.5, air_source: "receiving", players: 2 },
                points: 287.9,
            },
        ],
    };

    test("puts yards, touchdowns and implied points on one row per team", async () => {
        boot(routes({ "/season-offenses": OFFENSES }));
        await waitFor(() => rows("seasonOffenses").length === 2);

        const [best] = cells("seasonOffenses");
        expect(best[0]).toBe("1");
        expect(best[1]).toContain("KC");
        expect(best.slice(2)).toEqual(["5,299", "44.0", "454.9"]);
    });

    test("marks the team whose air total is a receiving fallback", async () => {
        boot(routes({ "/season-offenses": OFFENSES }));
        await waitFor(() => rows("seasonOffenses").length === 2);

        const [passing, fallback] = rows("seasonOffenses").map(
            (row) => row.querySelector(".season-offense__detail").textContent
        );
        expect(passing).toBe("4,500 air + 800 rush yards");
        expect(fallback).toContain("receiving fallback");
    });

    test("says so rather than showing an empty table when nothing is quoted", async () => {
        boot(routes({ "/season-offenses": { season: 2026, sources: [], teams: [] } }));
        await waitFor(() => rows("seasonOffenses").length === 1);

        expect(rows("seasonOffenses")[0].textContent).toBe("Not enough quoted markets yet.");
        expect(document.getElementById("seasonOffensesNote").textContent)
            .toBe("0 teams · points at standard scoring");
    });
});

/**
 * The player-context columns: each provider's own rank and projection, plus
 * the roster facts (age, bye, waiver traffic) that were only ever visible
 * one player at a time in the drawer.
 */
describe("player context columns", () => {
    const CONTEXT_LEADERS = [
        {
            ...FANTASY_LEADERS[0],
            provider_boards: {
                espn: { points: 355.2, rank: 2, position_rank: 2 },
                sleeper: { points: 344.0, rank: 1, position_rank: 1 },
            },
            age: 30, years_exp: 8, bye_week: 7, trending_add: 12450, trending_drop: 0,
        },
        {
            ...FANTASY_LEADERS[1],
            // Nobody's projection feed covers him; only the market does.
            provider_boards: {},
            age: 24, years_exp: 2, bye_week: null, trending_add: 0, trending_drop: 310,
        },
    ];

    const contextRoutes = (extra = {}) => routes({
        "/season-fantasy-points": {
            scoring: "std",
            sources: [],
            provider_boards: ["espn", "sleeper"],
            leaders: CONTEXT_LEADERS,
            ...extra,
        },
    });

    const cell = (rowIndex, selector) =>
        rows("seasonFantasyLeaders")[rowIndex].querySelector(selector);

    test("shows each provider's own rank and projection", async () => {
        boot(contextRoutes());
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        const [espnRank, espnPoints] = [...rows("seasonFantasyLeaders")[0].querySelectorAll(".col-espn")];
        expect(espnRank.textContent).toBe("2 · QB2");
        expect(espnRank.title).toContain("2nd");
        expect(espnPoints.textContent).toBe("355.2");
        const [sleeperRank] = [...rows("seasonFantasyLeaders")[0].querySelectorAll(".col-sleeper")];
        expect(sleeperRank.textContent).toBe("1 · QB1");
    });

    test("a player no provider projects gets dashes, not zeros", async () => {
        boot(contextRoutes());
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        [...rows("seasonFantasyLeaders")[1].querySelectorAll(".col-espn, .col-sleeper")]
            .forEach((td) => expect(td.textContent).toBe("—"));
    });

    test("carries the roster facts: age, bye and waiver traffic", async () => {
        boot(contextRoutes());
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        const first = cells("seasonFantasyLeaders")[0];
        expect(first.slice(-4)).toEqual(["30", "7", "12k", "0"]);
        // No bye is a blank, not a zero — week 0 is not a week.
        expect(cells("seasonFantasyLeaders")[1].slice(-4)).toEqual(["24", "—", "0", "310"]);
    });

    test("ranks sort best-first on the first click, unlike a points column", async () => {
        boot(contextRoutes());
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        document.querySelector('.col-sort[data-sort="sleeper_rank"]').click();
        expect(document.querySelector('.col-sort[data-sort="sleeper_rank"]')
            .closest("th").getAttribute("aria-sort")).toBe("ascending");
        // Rank 1 first, and the player with no rank at all sinks rather than
        // sorting ahead of everyone as a blank would.
        expect([...document.querySelectorAll("#seasonFantasyLeaders .season-leader__name")]
            .map((n) => n.textContent)).toEqual(["Passer One", "Runner One"]);
    });

    test("hides a provider's columns when its feed was never collected", async () => {
        boot(contextRoutes({ provider_boards: ["sleeper"] }));
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        const table = document.querySelector(".season-fantasy__table");
        expect(table.classList.contains("hide-espn")).toBe(true);
        expect(table.classList.contains("hide-sleeper")).toBe(false);
    });

    test("a board sorted by a provider that vanishes falls back to market order", async () => {
        document.body.innerHTML = bodySource;
        window.history.replaceState({}, "", "/fantasy/?sort=espn_rank:asc");
        boot(contextRoutes({ provider_boards: ["sleeper"] }), { keepUrl: true });
        await waitFor(() => rows("seasonFantasyLeaders").length === 2);

        // The default order is the absence of a sort param, so the deep link
        // is dropped rather than rewritten.
        expect(window.location.search).not.toContain("espn_rank");
        expect(document.querySelector('.col-sort[data-sort="fantasy_points"]')
            .closest("th").getAttribute("aria-sort")).toBe("descending");
    });
});
