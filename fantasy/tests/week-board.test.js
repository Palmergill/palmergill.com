/**
 * The week board on the fantasy dashboard.
 *
 * The collector has snapshotted weekly projections and rebuilt the derived
 * rankings every week since spec 16 P1; the page only ever rendered the
 * season-long market board. These tests pin the switch between the two: when
 * the week board is offered at all, what it shows, and that the two boards
 * never paint each other's shared controls.
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

const IN_SEASON = {
    season: 2026,
    week: 2,
    season_type: "regular",
    in_season: true,
    default_season: 2026,
    default_week: 2,
    is_fallback: false,
    jobs: [],
};

const OFFSEASON = {
    season: 2026,
    week: 0,
    season_type: "off",
    in_season: false,
    default_season: 2026,
    default_week: 0,
    is_fallback: false,
    jobs: [],
};

function ranked(name, position, overrides = {}) {
    return {
        player_id: name.toLowerCase().replace(/ /g, "-"),
        name,
        team: "SF",
        position,
        injury_status: null,
        rank: 1,
        projected_points: 20,
        prev_rank: null,
        opponent: "SEA",
        home: true,
        bye: false,
        ...overrides,
    };
}

const WEEK_RANKINGS = {
    season: 2026,
    week: 2,
    position: "ALL",
    scoring: "std",
    source: "consensus",
    as_of: "2026-09-16T12:00:00Z",
    rankings: [
        ranked("Passer One", "QB", { rank: 1, projected_points: 24.5, prev_rank: 3 }),
        ranked("Runner One", "RB", { rank: 2, projected_points: 18.2, prev_rank: 2, home: false, opponent: "ARI" }),
        // On bye: the schedule is loaded, his team is not in it.
        ranked("Catcher One", "WR", { rank: 3, projected_points: 15.9, prev_rank: 1, opponent: null, bye: true }),
        ranked("Runner Two", "RB", { rank: 4, projected_points: 11.4 }),
    ],
};

function played(name, position, overrides = {}) {
    return {
        player_id: name.toLowerCase().replace(/ /g, "-"),
        name,
        team: "SF",
        position,
        injury_status: null,
        rank: 1,
        actual_points: 20,
        projected_points: 18,
        projection_delta: 2,
        projected_rank: 4,
        opponent: "SEA",
        home: true,
        bye: false,
        ...overrides,
    };
}

const WEEK_ONE_RESULTS = {
    season: 2026,
    week: 1,
    scoring: "std",
    as_of: "2026-09-09T12:00:00Z",
    played: 4,
    projected: 3,
    mean_absolute_error: 6.4,
    entries: [
        played("Catcher One", "WR", { rank: 1, actual_points: 31.2, projected_points: 15.9, projection_delta: 15.3, projected_rank: 3 }),
        played("Passer One", "QB", { rank: 2, actual_points: 22.0, projected_points: 24.5, projection_delta: -2.5, projected_rank: 1 }),
        played("Runner One", "RB", { rank: 3, actual_points: 9.4, projected_points: 18.2, projection_delta: -8.8, projected_rank: 2, home: false, opponent: "ARI" }),
        // Nobody projected him; he still scored the points.
        played("Runner Two", "RB", { rank: 4, actual_points: 8.1, projected_points: null, projection_delta: null, projected_rank: null }),
    ],
};

const SEASON_LEADERS = [
    {
        player: { player_id: "passer-one", name: "Passer One", position: "QB", team: "SF" },
        fantasy_points: 380, yard_points: 300, touchdown_points: 80, markets_used: 4,
        books: [], projected_points: 350, projection_delta: 30,
    },
];

function routes(overrides = {}) {
    return {
        "/state": IN_SEASON,
        "/week-results": WEEK_ONE_RESULTS,
        "/rankings": WEEK_RANKINGS,
        "/season-fantasy-points": { scoring: "std", sources: [], leaders: SEASON_LEADERS },
        ...overrides,
    };
}

function boot(table, { url = "/fantasy/" } = {}) {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", url);
    window.FantasyFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn((requested) => {
        const match = Object.keys(table).find((key) => String(requested).includes(key));
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
    if (init) init();
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the week board");
}

const modeChips = () => [...document.querySelectorAll("#boardMode .chip")];
const headCells = () => [...document.querySelectorAll("#weekBoardHead th")].map((th) => th.textContent);
const modeLabels = () => modeChips().map((chip) => chip.textContent);
const pressedMode = () =>
    (modeChips().find((chip) => chip.getAttribute("aria-pressed") === "true") || {}).textContent;
const weekRows = () => [...document.querySelectorAll("#weekLeaders tr")];
const weekCells = () => weekRows().map((row) => [...row.children].map((cell) => cell.textContent));

async function openWeekBoard(table = routes()) {
    boot(table);
    await waitFor(() => modeChips().length === 2);
    modeChips()[1].click();
    await waitFor(() => weekRows().length > 0);
}

describe("week board", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("the toggle names the current week and starts on the season board", async () => {
        boot(routes());
        await waitFor(() => modeChips().length === 2);

        expect(modeLabels()).toEqual(["Season", "Week 2"]);
        expect(pressedMode()).toBe("Season");
        expect(document.getElementById("weekBoardWrap").hidden).toBe(true);
        expect(document.getElementById("marketTableWrap").hidden).toBe(false);
    });

    test("there is no week to offer in the offseason", async () => {
        boot(routes({ "/state": OFFSEASON }));
        await waitFor(() => document.getElementById("weekValue").textContent === "2026");

        expect(document.getElementById("boardMode").hidden).toBe(true);
        expect(modeChips()).toHaveLength(0);
        expect(document.getElementById("weekBoardWrap").hidden).toBe(true);
    });

    test("an offseason ?board=week link falls back to the season board", async () => {
        boot(routes({ "/state": OFFSEASON }), { url: "/fantasy/?board=week" });
        await waitFor(() => document.getElementById("weekValue").textContent === "2026");

        expect(document.getElementById("weekBoardWrap").hidden).toBe(true);
        expect(document.getElementById("marketBoardTitle").textContent).toBe("Market Value");
        expect(window.location.search).not.toContain("board=week");
    });

    test("switching boards swaps the table, the title and the URL", async () => {
        await openWeekBoard();

        expect(pressedMode()).toBe("Week 2");
        expect(document.getElementById("marketTableWrap").hidden).toBe(true);
        expect(document.getElementById("marketBoardTitle").textContent).toBe("Week Board");
        expect(document.getElementById("marketBoardEyebrow").textContent).toBe("Week 2");
        expect(window.location.search).toContain("board=week");

        modeChips()[0].click();
        expect(document.getElementById("weekBoardWrap").hidden).toBe(true);
        expect(document.getElementById("marketBoardTitle").textContent).toBe("Market Value");
        expect(window.location.search).not.toContain("board=week");
    });

    test("a deep link opens the week board once the week resolves", async () => {
        boot(routes(), { url: "/fantasy/?board=week" });
        await waitFor(() => weekRows().length > 0);

        expect(pressedMode()).toBe("Week 2");
        expect(document.getElementById("weekBoardWrap").hidden).toBe(false);
    });

    test("rows carry the opponent, the projection and the move since last week", async () => {
        await openWeekBoard();

        expect(weekCells()).toEqual([
            ["1", "Passer One" + "QB SF · vs SEA" + "+", "24.5", "+2"],
            ["2", "Runner One" + "RB SF · @ ARI" + "+", "18.2", "—"],
            ["3", "Catcher One" + "WR SF · BYE" + "+", "15.9", "-2"],
            ["4", "Runner Two" + "RB SF · vs SEA" + "+", "11.4", "—"],
        ]);
        // Rank 2 held its slot; rank 4 was not on last week's board at all.
        expect(weekRows()[1].children[3].title).toBe("Was 2 last week");
        expect(weekRows()[3].children[3].title).toBe("Not on last week's board");
    });

    test("the position chips filter the week board and keep the board-wide rank", async () => {
        await openWeekBoard();
        const chips = [...document.querySelectorAll("#seasonFantasyPositions .chip")];
        expect(chips.map((chip) => chip.textContent)).toEqual(["All", "QB", "RB", "WR"]);

        chips.find((chip) => chip.textContent === "RB").click();
        expect(weekCells()).toEqual([
            ["1", "Runner One" + "RB SF · 2 overall" + " · @ ARI" + "+", "18.2", "—"],
            ["2", "Runner Two" + "RB SF · 4 overall" + " · vs SEA" + "+", "11.4", "—"],
        ]);
        expect(document.getElementById("seasonFantasyNote").textContent)
            .toContain("2 of 2 · 2 of 4 RB · Week 2");
    });

    test("a week with no projections says so instead of showing a bare table", async () => {
        await openWeekBoard(routes({ "/rankings": { season: 2026, week: 2, rankings: [] } }));

        expect(weekRows()).toHaveLength(1);
        expect(weekRows()[0].textContent).toBe("Week 2 projections have not been collected yet.");
    });

    test("stepping back to a played week grades the projections it showed", async () => {
        await openWeekBoard();
        expect(headCells()).toEqual(["#", "Player", "Proj", "Move"]);

        document.getElementById("weekStepBack").click();
        await waitFor(() => headCells().length === 5);

        expect(headCells()).toEqual(["#", "Player", "Proj", "Actual", "+/-"]);
        expect(document.getElementById("marketBoardTitle").textContent).toBe("Week Results");
        expect(document.getElementById("marketBoardEyebrow").textContent).toBe("Week 1");
        expect(document.getElementById("weekStepLabel").textContent).toBe("Week 1");
        expect(weekCells()).toEqual([
            ["1", "Catcher One" + "WR SF · vs SEA" + "+", "15.9", "31.2", "+15.3"],
            ["2", "Passer One" + "QB SF · vs SEA" + "+", "24.5", "22.0", "-2.5"],
            ["3", "Runner One" + "RB SF · @ ARI" + "+", "18.2", "9.4", "-8.8"],
            // Never projected, so there is nothing to have been wrong about.
            ["4", "Runner Two" + "RB SF · vs SEA" + "+", "—", "8.1", "—"],
        ]);
        expect(weekRows()[0].children[4].title).toBe("31.2 scored against 15.9 projected");
        expect(weekRows()[0].children[2].title).toBe("Ranked 3 that week");
        expect(weekRows()[3].children[4].title).toBe("Not projected that week");
    });

    test("the results note publishes how far off the board was", async () => {
        await openWeekBoard();
        document.getElementById("weekStepBack").click();
        await waitFor(() => headCells().length === 5);

        expect(document.getElementById("seasonFantasyNote").textContent)
            .toContain("Week 1 results · projections missed by 6.4 on average across 3 players");
    });

    test("the stepper stops at week one and at the live week", async () => {
        await openWeekBoard();
        const back = document.getElementById("weekStepBack");
        const next = document.getElementById("weekStepNext");
        expect(document.getElementById("weekStep").hidden).toBe(false);
        expect(back.disabled).toBe(false);
        expect(next.disabled).toBe(true); // week 2 is the live week

        back.click();
        await waitFor(() => headCells().length === 5);
        expect(back.disabled).toBe(true);
        expect(next.disabled).toBe(false);

        next.click();
        await waitFor(() => headCells().length === 4);
        expect(document.getElementById("marketBoardTitle").textContent).toBe("Week Board");
        expect(document.getElementById("weekStepLabel").textContent).toBe("Week 2");
    });

    test("the stepper is hidden while the season board is showing", async () => {
        await openWeekBoard();
        expect(document.getElementById("weekStep").hidden).toBe(false);

        modeChips()[0].click();
        expect(document.getElementById("weekStep").hidden).toBe(true);
    });

    test("a played week with nothing collected says so", async () => {
        await openWeekBoard(routes({
            "/week-results": { season: 2026, week: 1, entries: [], played: 0, mean_absolute_error: null },
        }));
        document.getElementById("weekStepBack").click();
        await waitFor(() => weekRows().length === 1);

        expect(weekRows()[0].textContent).toBe("Week 1 results have not been collected yet.");
    });

    test("a season payload landing under the week board does not repaint its controls", async () => {
        // The two boards share the position chips, the note and "show all".
        let releaseSeason;
        const seasonReply = new Promise((resolve) => { releaseSeason = resolve; });
        boot({
            "/state": IN_SEASON,
            "/rankings": WEEK_RANKINGS,
            "/season-fantasy-points": seasonReply,
        });
        await waitFor(() => modeChips().length === 2);
        modeChips()[1].click();
        await waitFor(() => weekRows().length > 0);

        releaseSeason({
            status: 200,
            ok: true,
            json: () => Promise.resolve({
                scoring: "std",
                sources: [{ bookmaker: "kalshi", quoted_at: "2026-09-16T12:00:00Z" }],
                leaders: SEASON_LEADERS,
            }),
        });
        await waitFor(
            () => document.querySelectorAll("#marketFreshness li").length === 1
        );

        // The freshness card is its own card and still fills; the shared
        // controls still describe the week board.
        expect(weekRows()).toHaveLength(4);
        expect([...document.querySelectorAll("#seasonFantasyPositions .chip")]
            .map((chip) => chip.textContent)).toEqual(["All", "QB", "RB", "WR"]);
        expect(document.getElementById("seasonFantasyNote").textContent).toContain("Week 2");
    });
});
