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
const styleSource = fs.readFileSync(path.join(leagueDir, "style.css"), "utf8");
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
        scoring: "half",
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

function room(position, label, overrides = {}) {
    return {
        position,
        label,
        players: {},
        games: 0,
        points_per_game: null,
        league_average: null,
        rank: null,
        teams: 0,
        ...overrides,
    };
}

function rooms(overrides = {}) {
    return {
        available: true,
        season: 2026,
        espn_team_id: 1,
        as_of: OVERVIEW.as_of,
        scoring: "half",
        rooms: [
            room("WR", "Wide receiver", {
                players: { wr1: { player_id: "wr1", games: 2, points: 30, points_per_game: 15.0 } },
                games: 2,
                points_per_game: 15.0,
                league_average: 12.0,
                rank: 2,
                teams: 10,
            }),
            room("DST", "Defense"),
        ],
        ...overrides,
    };
}

function routes(overrides = {}) {
    return {
        // Longest paths first: the matcher takes the first key the URL contains.
        "/teams/1/roster": ROSTER,
        "/teams/1/lineup": lineup(),
        "/teams/1/rooms": rooms(),
        "/teams/1/overview": { status: "missing" },
        "/teams/1": TEAM,
        "/overview": OVERVIEW,
        "/standings": { season: 2026, divisions: [], teams: [] },
        "/ledger": {
            season: 2026,
            algorithm: "composite",
            algorithms: ["composite"],
            power_week: 2,
            playoff_team_count: 6,
            manager_rating: { available: false, reason: "no_actuals", weeks: [] },
            teams: [],
        },
        "/scoreboard": { season: 2026, week: 2, available_weeks: [1, 2], matchups: [] },
        "/free-agents": { available: false, unavailable_reason: "missing_roster_snapshot", season: 2026, week: 2, entries: [], rostered: 0, roster_as_of: null },
        "/me": { season: 2026, status: "unconfigured", selected_team_id: null, teams: [], snapshot: null },
        ...overrides,
    };
}

function boot(table, url = "/fantasy/league/?season=2026&team=1") {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", url);
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

// Masthead and colophon are both lists of .masthead__fact, so one reader
// serves them all.
const facts = (id) =>
    [...document.querySelectorAll(`#${id} .masthead__fact`)].map((node) => [
        node.querySelector("dt").textContent,
        node.querySelector("dd").firstChild.textContent,
    ]);

const subFor = (label) => {
    const node = [...document.querySelectorAll("#teamColophon .masthead__fact")].find(
        (fact) => fact.querySelector("dt").textContent === label
    );
    const small = node && node.querySelector("small");
    return small ? small.textContent : "";
};

// Which of the team's own endpoints were actually called, in order.
const teamRequests = () =>
    window.fetch.mock.calls
        .map(([url]) => String(url).split("?")[0])
        .filter((url) => url.includes("/teams/1"))
        .map((url) => url.slice(url.indexOf("/teams/1")));

const allPlay = (wins, losses) => ({
    wins,
    losses,
    ties: 0,
    games: wins + losses,
    win_pct: wins / (wins + losses),
});

function ledgerTeam(id, overrides = {}) {
    return {
        espn_team_id: id,
        name: `Team ${id}`,
        owner_name: "Owner",
        wins: 1,
        losses: 0,
        ties: 0,
        points_for: 120,
        all_play: allPlay(1, 0),
        luck: 0,
        lineup: { efficiency: null },
        scoring: null,
        power: { rank: id },
        playoff: { odds: null },
        ...overrides,
    };
}

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
            .toBe("Best legal lineup for week 2, on Half PPR projections");
        const lineupRequests = window.fetch.mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.includes("/lineup?"));
        expect(lineupRequests.length).toBeGreaterThan(0);
        expect(lineupRequests.every((url) => new URL(url, window.location.origin)
            .searchParams.get("scoring") === "half")).toBe(true);
    });

    test("renders roster projections and actuals in the league's Half PPR format", async () => {
        const roster = {
            ...ROSTER,
            entries: [{
                matched: true,
                name: "Catcher One",
                position: "WR",
                pro_team: "SF",
                lineup_slot: "WR",
                projection: { pts_ppr: 20, pts_half_ppr: 18 },
                ranking: { position: "WR", rank: 4 },
                recent_actuals: [{ fantasy_points_ppr: 22.5, fantasy_points_half: 20 }],
                props: [],
                injury_status: null,
            }],
        };
        await openTeam(routes({ "/teams/1/roster": roster }));
        await waitFor(() => document.querySelector(".roster__data") !== null);

        expect(document.querySelector(".roster__data").textContent)
            .toBe("Proj 18.0 · WR #4 · Last 20.0");
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
        await waitFor(() => document.getElementById("leagueName").textContent === "Test Team");

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
        await waitFor(() => document.getElementById("leagueName").textContent === "Test Team");

        expect(card().hidden).toBe(true);
    });

    test("a failed lineup read does not take the team page down with it", async () => {
        await openTeam(routes({ "/teams/1/lineup": response({}, 500) }));
        await waitFor(() => document.getElementById("leagueName").textContent === "Test Team");

        expect(card().hidden).toBe(true);
        expect(document.getElementById("errorBanner").hidden).toBe(true);
    });
});

describe("the team masthead", () => {
    test("carries the team, not the league, while a team is open", async () => {
        await openTeam();
        await waitFor(
            () => document.getElementById("leagueName").textContent === "Test Team"
        );

        expect(document.getElementById("leagueSub").textContent).toBe("Taylor");
        expect(document.getElementById("leagueSub").hidden).toBe(false);
        expect(document.getElementById("teamBadge").hidden).toBe(false);
        expect(document.getElementById("modeBadge").hidden).toBe(true);
        expect(facts("teamBadge")).toEqual([
            ["Record", "1-0"],
            ["Points for", "120.0"],
            ["Against", "99.0"],
            ["Per game", "120.0"],
        ]);
    });

    test("gives the league back when you leave the team", async () => {
        await openTeam();
        await waitFor(
            () => document.getElementById("leagueName").textContent === "Test Team"
        );

        document.getElementById("teamBack").click();

        expect(document.getElementById("leagueName").textContent).toBe("Test League");
        expect(document.getElementById("teamBadge").hidden).toBe(true);
        expect(document.getElementById("modeBadge").hidden).toBe(false);
        expect(document.getElementById("leagueSub").hidden).toBe(true);
    });
});

describe("the colophon", () => {
    test("reads the last two facts off the ledger, without a request for them", async () => {
        const table = routes({
            "/ledger": Object.assign({}, routes()["/ledger"], {
                teams: [
                    ledgerTeam(1, { all_play: allPlay(6, 3), luck: 0.7, lineup: { efficiency: 0.948 } }),
                    ledgerTeam(2, { all_play: allPlay(9, 0), luck: -0.2, lineup: { efficiency: 0.9 } }),
                ],
            }),
        });
        await openTeam(table);
        await waitFor(() => facts("teamColophon").length === 6);

        const colophon = Object.fromEntries(facts("teamColophon"));
        expect(colophon["All-play"]).toBe("6-3");
        expect(colophon["Lineup"]).toBe("94.8%");
        // Second of the two rated teams on all-play.
        expect(subFor("All-play")).toBe("2nd of 2");
        expect(subFor("Lineup")).toBe("+0.7 wins on luck");
        // Four team routes and no fifth: the ledger was already in hand.
        expect(teamRequests()).toEqual([
            "/teams/1",
            "/teams/1/roster",
            "/teams/1/lineup",
            "/teams/1/rooms",
            "/teams/1/overview",
        ]);
    });

    test("prints a dash rather than a zero when the ledger failed", async () => {
        await openTeam(routes({ "/ledger": response({}, 500) }));
        await waitFor(() => facts("teamColophon").length === 6);

        const colophon = Object.fromEntries(facts("teamColophon"));
        expect(colophon["All-play"]).toBe("—");
        expect(colophon["Lineup"]).toBe("—");
        // The facts that do not depend on the ledger still report.
        expect(colophon["Record"]).toBe("1-0");
    });
});

describe("the lede", () => {
    test("an empty state is a note, not a lede with a drop cap", async () => {
        // The drop cap keys off the first paragraph, and "No overview written
        // for this team yet." is a paragraph too — it must not get one.
        await openTeam();
        await waitFor(() => document.querySelector("#teamLede .empty-note") !== null);

        const note = document.querySelector("#teamLede .empty-note");
        expect(note.textContent).toContain("No overview written");
        expect(styleSource).toContain(
            '.dossier__lede > p:first-child:not(.empty-note)::first-letter'
        );
    });

    test("a written overview renders as prose", async () => {
        await openTeam(
            routes({
                "/teams/1/overview": {
                    status: "current",
                    overview_md: "First line.\n\nSecond line.",
                    source: "model",
                    week: 14,
                    cache_hit: true,
                },
            })
        );
        await waitFor(() => document.querySelectorAll("#teamLede p").length === 2);

        expect(document.querySelector("#teamLede p").textContent).toBe("First line.");
        expect(document.querySelector("#teamLede .empty-note")).toBeNull();
    });
});

describe("the season, week by week", () => {
    const week = (overrides = {}) => ({
        week: 1,
        is_bye: false,
        is_complete: true,
        outcome: "W",
        points: 120.0,
        opponent_points: 99.0,
        margin: 21.0,
        opponent: { espn_team_id: 2, name: "Rivals", abbrev: "RIV", wins: 4, losses: 8, ties: 0 },
        ...overrides,
    });

    const weeks = async (results) => {
        await openTeam(routes({ "/teams/1": Object.assign({}, TEAM, { results }) }));
        await waitFor(() => document.querySelectorAll("#teamResults .season__wk").length > 0);
        return [...document.querySelectorAll("#teamResults .season__wk")];
    };

    test("names the opponent and the record it carried", async () => {
        const rows = await weeks([week()]);
        expect(rows[0].querySelector(".season__opp").textContent).toBe("Rivals · 4-8");
        expect(rows[0].querySelector(".season__score").textContent).toBe("120.0–99.0");
    });

    test("puts every margin on one scale, so the weeks are comparable", async () => {
        const rows = await weeks([
            week({ week: 1, margin: 20.0 }),
            week({ week: 2, outcome: "L", points: 90.0, opponent_points: 130.0, margin: -40.0 }),
        ]);

        const bars = rows.map((row) => row.querySelector(".dv__bar"));
        expect(bars[0].className).toContain("dv__bar--positive");
        expect(bars[1].className).toContain("dv__bar--negative");
        // Half the reach of the biggest margin in the season.
        expect(parseFloat(bars[0].style.width)).toBeCloseTo(
            parseFloat(bars[1].style.width) / 2
        );
    });

    test("a bye has no opponent, no score and no bar", async () => {
        const rows = await weeks([
            week({ week: 1, is_bye: true, outcome: null, points: null, opponent_points: null, margin: null, opponent: null }),
        ]);

        expect(rows[0].querySelector(".season__outcome").textContent).toBe("BYE");
        expect(rows[0].querySelector(".dv__bar")).toBeNull();
    });

    test("a week not yet played prints a dash, not a result", async () => {
        const rows = await weeks([
            week({ week: 3, is_complete: false, outcome: null, points: null, opponent_points: null, margin: null }),
        ]);

        expect(rows[0].querySelector(".season__outcome").textContent).toBe("—");
        expect(rows[0].querySelector(".season__score").textContent).toBe("—");
        // Not even the axis: a zero rule under an unplayed week reads as a
        // result, and divergingBar cannot tell a missing margin from a tie.
        expect(rows[0].querySelector(".dv__zero")).toBeNull();
    });

    test("a tie keeps the axis it sits on", async () => {
        const rows = await weeks([
            week({ outcome: "T", points: 110.0, opponent_points: 110.0, margin: 0 }),
        ]);

        expect(rows[0].querySelector(".dv__zero")).not.toBeNull();
        expect(rows[0].querySelector(".dv__bar")).toBeNull();
    });
});

describe("the roster, by room", () => {
    const ENTRIES = [
        { player_id: "wr1", name: "Split End", position: "WR", lineup_slot: "WR", matched: true, props: [], recent_actuals: [] },
        { player_id: "wr2", name: "Flex Guy", position: "WR", lineup_slot: "FLEX", matched: true, props: [], recent_actuals: [] },
        { player_id: "dst", name: "Broncos D/ST", position: "DEF", lineup_slot: "DST", matched: true, props: [], recent_actuals: [] },
    ];
    const withRoster = (overrides) =>
        routes(Object.assign({ "/teams/1/roster": Object.assign({}, ROSTER, { entries: ENTRIES }) }, overrides));

    const roomEls = () => [...document.querySelectorAll("#teamRoster .room")];

    test("reads a flex receiver with the other receivers", async () => {
        await openTeam(withRoster());
        await waitFor(() => roomEls().length > 0);

        const [first] = roomEls();
        expect(first.querySelector("h3").textContent).toBe("Wide receiver");
        expect([...first.querySelectorAll(".roster__name")].map((n) => n.textContent)).toEqual([
            "Split End",
            "Flex Guy",
        ]);
    });

    test("measures a room against the league and ranks it", async () => {
        await openTeam(withRoster());
        await waitFor(() => roomEls().length > 0);

        const [first] = roomEls();
        expect(first.querySelector(".room__rank").textContent).toBe("2nd of 10");
        expect(first.querySelector(".room__scale").textContent).toBe("15.0 / 12.0 avg");
        expect(first.querySelector(".meter__avg")).not.toBeNull();
    });

    test("a room the weekly feed cannot score carries no bar and no rank", async () => {
        await openTeam(withRoster());
        await waitFor(() => roomEls().length > 1);

        const defense = roomEls().find((el) => el.querySelector("h3").textContent === "Defense");
        expect(defense.querySelector(".room__strength")).toBeNull();
        expect(defense.querySelector(".room__rank")).toBeNull();
        expect(defense.querySelectorAll(".roster__ppg")).toHaveLength(0);
        // Still listed, though — the players are on the roster either way.
        expect(defense.querySelectorAll(".roster__row")).toHaveLength(1);
    });

    test("without the measurement the rooms still group and still list", async () => {
        await openTeam(withRoster({ "/teams/1/rooms": response({}, 500) }));
        await waitFor(() => roomEls().length > 0);

        const [first] = roomEls();
        expect(first.querySelector("h3").textContent).toBe("Wide receiver");
        expect(first.querySelectorAll(".roster__row")).toHaveLength(2);
        expect(first.querySelector(".room__strength")).toBeNull();
        expect(document.getElementById("roomsLede").textContent).toBe("");
        // No column of dashes where there is nothing to measure against.
        expect(first.querySelectorAll(".roster__ppg")).toHaveLength(0);
    });

    test("a player with no games played gets a dash, not a zero", async () => {
        await openTeam(withRoster());
        await waitFor(() => roomEls().length > 0);

        const points = [...roomEls()[0].querySelectorAll(".roster__ppg")].map((n) => n.textContent);
        expect(points).toEqual(["15.0", "—"]);
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
        scoring: "half",
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
        expect(note()).toContain("week 2 Half PPR projections");
        expect(note()).toContain("rosters ");
    });

    test("keeps the free-agent deep link through initial URL normalization", async () => {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: jest.fn(),
        });
        boot(
            routes({ "/free-agents": POOL }),
            "/fantasy/league/#free-agents"
        );
        await waitFor(() => agents().length === 2);

        expect(window.location.hash).toBe("#free-agents");
        expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
        const request = window.fetch.mock.calls
            .map(([url]) => String(url))
            .find((url) => url.includes("/free-agents?"));
        expect(new URL(request, window.location.origin).searchParams.get("scoring"))
            .toBe("half");
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

describe("your team strip", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const strip = () => document.getElementById("myTeamStrip");
    const advice = () => document.getElementById("myTeamAdvice");

    const CONFIGURED_ME = {
        season: 2026,
        status: "configured",
        selected_team_id: 1,
        teams: [{ espn_team_id: 1, name: "Test Team" }],
        snapshot: {
            team: { espn_team_id: 1, name: "Test Team" },
            record: { wins: 1, losses: 0, ties: 0 },
            opponent: { name: "Rivals" },
            power_rank: 3,
        },
    };

    test("names your team, and links into it", async () => {
        boot(routes({ "/me": CONFIGURED_ME }));
        await waitFor(() => !strip().hidden);

        const name = document.getElementById("myTeamName");
        expect(name.textContent).toBe("Test Team");
        expect(name.getAttribute("href")).toBe("/fantasy/league/?season=2026&team=1");
        expect(document.getElementById("myTeamMeta").textContent).toBe("1-0 · vs Rivals · Power #3");
    });

    test("leads with what the lineup is leaving on the bench", async () => {
        boot(routes({ "/me": CONFIGURED_ME }));
        await waitFor(() => !advice().hidden);

        expect(advice().textContent).toBe("Your lineup leaves 9.0 on the bench →");
        expect(advice().getAttribute("href")).toBe("/fantasy/league/?season=2026&team=1");
    });

    test("says so when the lineup is already the best one", async () => {
        boot(routes({
            "/me": CONFIGURED_ME,
            "/teams/1/lineup": lineup({ gain: 0, swaps: [], starts: [], sits: [] }),
        }));
        await waitFor(() => !advice().hidden);

        expect(advice().textContent).toBe("Your lineup is the best one available →");
    });

    test("keeps the shortcut but drops the advice when there is none to give", async () => {
        boot(routes({
            "/me": CONFIGURED_ME,
            "/teams/1/lineup": lineup({ available: false, unavailable_reason: "projection_season_mismatch", gain: null }),
        }));
        await waitFor(() => !strip().hidden);
        await waitFor(() => advice().hidden);

        expect(document.getElementById("myTeamName").textContent).toBe("Test Team");
    });

    test("stays hidden for a member who has not picked a team", async () => {
        boot(routes());
        await waitFor(() => !document.getElementById("leagueView").hidden);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(strip().hidden).toBe(true);
    });
});
