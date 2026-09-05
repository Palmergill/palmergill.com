/**
 * The start/sit card on a league team page.
 *
 * The assignment itself is the backend's (and is proven against brute force
 * there); what matters here is that the card states a decision a person can
 * act on, and stays quiet when it has nothing trustworthy to say.
 */
const fs = require("fs");
const path = require("path");

const leagueDir = path.join(__dirname, "..", "league");
const appSource = fs.readFileSync(path.join(leagueDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(leagueDir, "index.html"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../league/format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

const OVERVIEW = {
    season: 2026,
    mode: "regular",
    name: "Test League",
    seasons: [{ season: 2026, status: "ok" }],
    divisions: [],
    algorithms: ["composite", "record"],
    freshness: { league_sync: "2026-09-16T12:00:00Z" },
    as_of: "2026-09-16T12:00:00Z",
};

const TEAM = {
    espn_team_id: 1,
    name: "Test Team",
    owner_name: "Taylor",
    wins: 1,
    losses: 0,
    ties: 0,
    points_for: 120,
    points_against: 99,
    games_played: 1,
    power_history: [],
    results: [],
};

const ROSTER = { season: 2026, espn_team_id: 1, as_of: OVERVIEW.as_of, entries: [], player_data: {} };

function lineup(overrides = {}) {
    return {
        season: 2026,
        espn_team_id: 1,
        scoring: "ppr",
        week: 2,
        as_of: OVERVIEW.as_of,
        projection_as_of: "2026-09-16T11:00:00Z",
        slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"],
        current: { total: 89.5, entries: [] },
        optimal: { total: 98.5, entries: [] },
        gain: 9.0,
        swaps: [
            {
                slot: "RB",
                start: { player_id: "rb3", name: "Runner Three", position: "RB", pro_team: "SF", projected_points: 15.5 },
                sit: { player_id: "rb2", name: "Runner Two", position: "RB", pro_team: "CHI", projected_points: 6.5 },
                gain: 9.0,
            },
        ],
        unprojected_starters: 0,
        unfilled_slots: 0,
        ...overrides,
    };
}

function routes(overrides = {}) {
    return {
        // Longest paths first: the matcher takes the first key the URL contains.
        "/teams/1/roster": ROSTER,
        "/teams/1/lineup": lineup(),
        "/teams/1/overview": { status: "missing" },
        "/teams/1": TEAM,
        "/overview": OVERVIEW,
        "/standings": { season: 2026, divisions: [], teams: [] },
        "/power-rankings": { season: 2026, week: 2, available_weeks: [1, 2], rankings: [] },
        "/scoreboard": { season: 2026, week: 2, available_weeks: [1, 2], matchups: [] },
        ...overrides,
    };
}

function boot(table) {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", "/fantasy/league/?season=2026&team=1");
    window.LeagueFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn((requested) => {
        const match = Object.keys(table).find((key) => String(requested).includes(key));
        if (!match) return response({}, 500);
        const value = table[match];
        return value instanceof Promise ? value : response(value);
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
    throw new Error("Timed out waiting for the start/sit card");
}

const card = () => document.getElementById("lineupCard");
const totals = () =>
    [...document.querySelectorAll("#lineupTotals .lineup__total")].map((node) => [
        node.querySelector("dt").textContent,
        node.querySelector("dd").textContent,
    ]);
const swaps = () => [...document.querySelectorAll("#lineupSwaps .lineup__swap")];

async function openTeam(table = routes()) {
    boot(table);
    await waitFor(() => !document.getElementById("teamView").hidden);
}

describe("start/sit card", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("states the swap, what it is worth, and what is left on the bench", async () => {
        await openTeam();
        await waitFor(() => !card().hidden);

        expect(totals()).toEqual([
            ["Started", "89.5"],
            ["Best possible", "98.5"],
            ["On the bench", "+9.0"],
        ]);
        expect(swaps()).toHaveLength(1);
        expect(swaps()[0].querySelector(".lineup__slot").textContent).toBe("RB");
        expect([...swaps()[0].querySelectorAll(".lineup__name")].map((n) => n.textContent))
            .toEqual(["Runner Three", "Runner Two"]);
        expect([...swaps()[0].querySelectorAll(".lineup__points")].map((n) => n.textContent))
            .toEqual(["RB · SF · 15.5", "RB · CHI · 6.5"]);
        expect(swaps()[0].querySelector(".lineup__gain").textContent).toBe("+9.0");
        expect(document.getElementById("lineupMeta").textContent)
            .toBe("Best legal lineup for week 2, on PPR projections");
    });

    test("says so when the lineup is already the best one", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                gain: 0,
                swaps: [],
                optimal: { total: 89.5, entries: [] },
            }),
        }));
        await waitFor(() => !card().hidden);

        expect(swaps()).toHaveLength(0);
        expect(document.querySelector("#lineupSwaps .lineup__ok").textContent)
            .toBe("This is the best lineup this roster can field.");
        expect(totals()[2]).toEqual(["On the bench", "—"]);
    });

    test("claims no gain over a starter it could not project", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                unprojected_starters: 1,
                swaps: [
                    {
                        slot: "QB",
                        start: { name: "Passer Two", position: "QB", pro_team: "SF", projected_points: 15.0 },
                        sit: { name: "Passer One", position: "QB", pro_team: "KC", projected_points: null },
                        gain: null,
                    },
                ],
            }),
        }));
        await waitFor(() => !card().hidden);

        expect(swaps()[0].querySelector(".lineup__gain").textContent).toBe("?");
        expect([...swaps()[0].querySelectorAll(".lineup__points")].map((n) => n.textContent))
            .toEqual(["QB · SF · 15.0", "QB · KC · no projection"]);
        expect(document.getElementById("lineupNote").textContent)
            .toContain("1 starter has no projection this week, so he is not compared");
    });

    test("stays hidden when the league's lineup settings were never collected", async () => {
        await openTeam(routes({ "/teams/1/lineup": lineup({ slots: [], swaps: [] }) }));
        // The rest of the team page still renders.
        await waitFor(() => document.getElementById("teamName").textContent === "Test Team");

        expect(card().hidden).toBe(true);
    });

    test("a failed lineup read does not take the team page down with it", async () => {
        await openTeam(routes({ "/teams/1/lineup": response({}, 500) }));
        await waitFor(() => document.getElementById("teamName").textContent === "Test Team");

        expect(card().hidden).toBe(true);
        expect(document.getElementById("errorBanner").hidden).toBe(true);
    });
});
