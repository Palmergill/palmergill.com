/**
 * The two boards that turn the league hub from a mirror of ESPN into
 * something worth opening on a Sunday: start/sit on a team page, and the
 * free-agent list on the league page.
 *
 * The arithmetic behind both is the backend's (and the lineup assignment is
 * proven against brute force there); what matters here is that each states a
 * decision a person can act on, and stays quiet when it has nothing
 * trustworthy to say.
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
        available: true,
        unavailable_reason: null,
        scoring: "ppr",
        week: 2,
        as_of: OVERVIEW.as_of,
        projection_as_of: "2026-09-16T11:00:00Z",
        slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"],
        current: { total: 89.5, entries: [] },
        optimal: { total: 98.5, entries: [] },
        gain: 9.0,
        starts: [
            { player_id: "rb3", name: "Runner Three", position: "RB", pro_team: "SF", slot: "RB", projected_points: 15.5 },
        ],
        sits: [
            { player_id: "rb2", name: "Runner Two", position: "RB", pro_team: "CHI", slot: "RB", projected_points: 6.5 },
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
        "/free-agents": { available: false, unavailable_reason: "missing_roster_snapshot", season: 2026, week: 2, entries: [], rostered: 0, roster_as_of: null },
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
const changes = () => [...document.querySelectorAll("#lineupChanges .lineup__change")];

async function openTeam(table = routes()) {
    boot(table);
    await waitFor(() => !document.getElementById("teamView").hidden);
}

describe("start/sit card", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("states the independent start and sit actions and what is left on the bench", async () => {
        await openTeam();
        await waitFor(() => !card().hidden);

        expect(totals()).toEqual([
            ["Started", "89.5"],
            ["Best possible", "98.5"],
            ["On the bench", "+9.0"],
        ]);
        expect(changes()).toHaveLength(2);
        expect(changes().map((row) => row.querySelector(".lineup__label").textContent))
            .toEqual(["Start", "Sit"]);
        expect(changes().map((row) => row.querySelector(".lineup__slot").textContent))
            .toEqual(["RB", "RB"]);
        expect(changes().map((row) => row.querySelector(".lineup__name").textContent))
            .toEqual(["Runner Three", "Runner Two"]);
        expect(changes().map((row) => row.querySelector(".lineup__points").textContent))
            .toEqual(["RB · SF · 15.5", "RB · CHI · 6.5"]);
        expect(document.getElementById("lineupMeta").textContent)
            .toBe("Best legal lineup for week 2, on PPR projections");
    });

    test("says so when the lineup is already the best one", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                gain: 0,
                starts: [],
                sits: [],
                optimal: { total: 89.5, entries: [] },
            }),
        }));
        await waitFor(() => !card().hidden);

        expect(changes()).toHaveLength(0);
        expect(document.querySelector("#lineupChanges .lineup__ok").textContent)
            .toBe("This is the best lineup this roster can field.");
        expect(totals()[2]).toEqual(["On the bench", "—"]);
    });

    test("claims no gain over a starter it could not project", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                current: { total: null, entries: [] },
                gain: null,
                unprojected_starters: 1,
                starts: [
                    { name: "Passer Two", position: "QB", pro_team: "SF", slot: "QB", projected_points: 15.0 },
                ],
                sits: [
                    { name: "Passer One", position: "QB", pro_team: "KC", slot: "QB", projected_points: null },
                ],
            }),
        }));
        await waitFor(() => !card().hidden);

        expect(totals()).toEqual([
            ["Started", "—"],
            ["Best possible", "98.5"],
            ["On the bench", "—"],
        ]);
        expect(changes().map((row) => row.querySelector(".lineup__points").textContent))
            .toEqual(["QB · SF · 15.0", "QB · KC · no projection"]);
        expect(document.getElementById("lineupNote").textContent)
            .toContain("1 starter has no projection this week, so the overall gain cannot be calculated");
    });

    test("stays hidden when the league's lineup settings were never collected", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                available: false,
                unavailable_reason: "missing_lineup_settings",
                slots: [],
                starts: [],
                sits: [],
            }),
        }));
        // The rest of the team page still renders.
        await waitFor(() => document.getElementById("teamName").textContent === "Test Team");

        expect(card().hidden).toBe(true);
    });

    test("stays hidden when roster and projection seasons do not match", async () => {
        await openTeam(routes({
            "/teams/1/lineup": lineup({
                available: false,
                unavailable_reason: "projection_season_mismatch",
                season: 2024,
                starts: [],
                sits: [],
            }),
        }));
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

describe("free agents", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const agents = () => [...document.querySelectorAll("#freeAgents .free-agent")];
    const note = () => document.getElementById("freeAgentsNote").textContent;

    const POOL = {
        available: true,
        unavailable_reason: null,
        season: 2026,
        week: 2,
        scoring: "ppr",
        rostered: 154,
        roster_as_of: "2026-09-16T12:00:00Z",
        as_of: "2026-09-16T11:00:00Z",
        entries: [
            { player_id: "200", name: "Free Agent One", position: "WR", team: "SF", rank: 42, projected_points: 11.4, trending_adds: 4200, injury_status: null },
            { player_id: "400", name: "Free Agent Two", position: "TE", team: "NYG", rank: 61, projected_points: 8.5, trending_adds: null, injury_status: null },
        ],
    };

    test("lists who is unrostered, keeping the board's own rank", async () => {
        boot(routes({ "/free-agents": POOL }));
        await waitFor(() => agents().length === 2);

        expect(agents().map((row) => row.querySelector(".free-agent__rank").textContent))
            .toEqual(["#42", "#61"]);
        expect(agents().map((row) => row.querySelector(".free-agent__name").textContent))
            .toEqual(["Free Agent One", "Free Agent Two"]);
        expect(agents().map((row) => row.querySelector(".free-agent__points").textContent))
            .toEqual(["11.4", "8.5"]);
    });

    test("flags a contested pickup with Sleeper's add count, compacted", async () => {
        boot(routes({ "/free-agents": POOL }));
        await waitFor(() => agents().length === 2);

        const trend = agents()[0].querySelector(".free-agent__trend");
        expect(trend.textContent).toBe("+4.2k adds");
        expect(trend.title).toBe("4,200 Sleeper adds in the last day");
        // Nobody is adding the second one, which is a blank rather than a zero.
        expect(agents()[1].querySelector(".free-agent__trend")).toBeNull();
    });

    test("says how stale the exclusion is, because that is the whole claim", async () => {
        boot(routes({ "/free-agents": POOL }));
        await waitFor(() => agents().length === 2);

        expect(note()).toContain("154 players rostered");
        expect(note()).toContain("week 2 PPR projections");
        expect(note()).toContain("rosters ");
    });

    test.each([
        ["no roster snapshot to subtract", "missing_roster_snapshot"],
        ["rankings from another season", "projection_season_mismatch"],
    ])("hides the board with %s rather than implying nobody is rostered", async (_label, reason) => {
        boot(routes({
            "/free-agents": {
                available: false,
                unavailable_reason: reason,
                season: 2026,
                week: 2,
                entries: [],
                rostered: 0,
                roster_as_of: null,
            },
        }));
        await waitFor(() => !document.getElementById("leagueView").hidden);
        await waitFor(() => document.querySelector('[data-board="free-agents"]').hidden);

        expect(document.querySelector('[data-board="free-agents"]').hidden).toBe(true);
        expect(agents()).toHaveLength(0);
    });

    test("a league where everyone is rostered says that, not nothing", async () => {
        boot(routes({
            "/free-agents": {
                available: true,
                unavailable_reason: null,
                season: 2026,
                week: 2,
                entries: [],
                rostered: 300,
                roster_as_of: POOL.roster_as_of,
            },
        }));
        await waitFor(() => document.querySelector("#freeAgents .empty-note") !== null);

        expect(document.querySelector('[data-board="free-agents"]').hidden).toBe(false);
        expect(document.querySelector("#freeAgents .empty-note").textContent)
            .toBe("Every ranked player is on a roster.");
    });

    test("a failed read says so rather than showing an empty waiver wire", async () => {
        boot(routes({ "/free-agents": response({}, 500) }));
        await waitFor(() => note() === "Unavailable right now.");

        expect(agents()).toHaveLength(0);
    });
});
