const fs = require("fs");
const path = require("path");

const leagueDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(leagueDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(leagueDir, "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(leagueDir, "style.css"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

function team(overrides) {
    return Object.assign(
        {
            espn_team_id: 1,
            name: "Alpha",
            owner_name: "Taylor",
            wins: 4,
            losses: 1,
            ties: 0,
            points_for: 655.2,
            points_against: 600.0,
            win_pct: 0.8,
            games_played: 5,
            expected_wins: 3.6,
            luck: 0.4,
            all_play: { wins: 32, losses: 13, ties: 0, games: 45, win_pct: 32 / 45 },
            scoring: { low: 96.4, median: 131.0, high: 158.7, mean: 131.0, stdev: 24.1, weeks: 5 },
            playoff: { odds: 0.91, projected_wins: 10.2, projected_losses: 3.8 },
            power: {
                rank: 2,
                previous_rank: 2,
                rank_delta: 0,
                history: [
                    { week: 1, rank: 3 },
                    { week: 2, rank: 2 },
                ],
            },
            lineup: { efficiency: 0.916, points_left: 60.1, weeks: 5 },
        },
        overrides
    );
}

const TEAMS = [
    team(),
    team({
        espn_team_id: 2,
        name: "Bravo",
        owner_name: "Ray",
        wins: 5,
        losses: 0,
        win_pct: 1.0,
        points_for: 677.0,
        expected_wins: 4.0,
        luck: 1.0,
        all_play: { wins: 36, losses: 9, ties: 0, games: 45, win_pct: 36 / 45 },
        playoff: { odds: 0.98, projected_wins: 11.4, projected_losses: 2.6 },
        power: { rank: 1, previous_rank: 2, rank_delta: 1, history: [{ week: 1, rank: 2 }, { week: 2, rank: 1 }] },
        lineup: { efficiency: 0.963, points_left: 24.5, weeks: 5 },
    }),
];

const OVERVIEW = {
    season: 2026,
    mode: "live",
    name: "Sunday Money",
    size: 2,
    playoff_team_count: 1,
    divisions: [],
    completed_weeks: [1, 2],
    latest_week: 2,
    algorithms: ["composite", "record", "recent_form"],
    seasons: [{ season: 2026, status: "ok", available: true }],
    freshness: { league_sync: null, league_rosters: null },
};

function ledger(overrides) {
    return Object.assign(
        {
            season: 2026,
            algorithm: "composite",
            algorithms: OVERVIEW.algorithms,
            power_week: 2,
            playoff_team_count: 1,
            manager_rating: {
                available: true,
                reason: null,
                league_average: 0.9395,
                weeks: [1, 2],
            },
            teams: TEAMS,
        },
        overrides
    );
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the league hub controller");
}

function boot(overrides = {}, url = "/fantasy/") {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", url);
    window.LeagueFormat = F;
    window.API_ORIGIN = "";
    window.FantasyHeader = { mount: () => null };
    window.fetch = jest.fn((requested) => {
        const target = String(requested);
        if (overrides.fetch) {
            const custom = overrides.fetch(target);
            if (custom) return custom;
        }
        if (target.includes("/overview")) return response(overrides.overview || OVERVIEW);
        if (target.includes("/standings")) return response({ season: 2026, teams: TEAMS, divisions: [] });
        if (target.includes("/ledger")) return response(overrides.ledger || ledger());
        if (target.includes("/scoreboard")) {
            return response({ season: 2026, week: 2, available_weeks: [1, 2], matchups: [] });
        }
        if (target.includes("/free-agents")) return response({ available: false });
        if (target.includes("/roster-power")) {
            return response(overrides.rosterPower || { available: false, unavailable_reason: "missing_projections" });
        }
        if (target.includes("/lineup")) return response(overrides.lineup || { available: false });
        if (target.includes("/me")) return response(overrides.me || { status: "unconfigured" });
        throw new Error(`Unexpected request: ${target}`);
    });
    window.eval(appSource);
    return window.fetch;
}

function rowNames() {
    return [...document.querySelectorAll("#ledger tbody tr .team-cell__name")].map(
        (node) => node.textContent
    );
}

describe("league hub ledger", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("renders one row per team with every column present", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        const first = document.querySelector("#ledger tbody tr");
        const keys = [...first.querySelectorAll("td[data-key]")].map((td) => td.dataset.key);
        expect(keys).toEqual([
            "team",
            "record",
            "points_for",
            "all_play",
            "expected",
            "luck",
            "lineup",
            "scoring",
            "power",
            "odds",
            "form",
        ]);
        expect(document.getElementById("ledgerNote").textContent).toBe(
            "2 teams · power through week 2"
        );
    });

    test("opens in standings order", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
        expect(rowNames()).toEqual(["Bravo", "Alpha"]);
    });

    test("choosing a column re-sorts the table without refetching", async () => {
        const fetchMock = boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
        const before = fetchMock.mock.calls.length;

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Lineup")
            .click();

        // Bravo manages better; Alpha has the better record.
        expect(rowNames()).toEqual(["Bravo", "Alpha"]);
        expect(fetchMock.mock.calls.length).toBe(before);
        expect(window.location.search).toContain("col=lineup");
    });

    test("the chosen column is the one marked active", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Luck")
            .click();

        const active = [...document.querySelectorAll("#ledger tbody tr:first-child td.is-active")];
        expect(active).toHaveLength(1);
        expect(active[0].dataset.key).toBe("luck");
        expect(active[0].textContent).toBe("+1.0");
    });

    test("the Range choice exposes and activates its scoring column", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Range")
            .click();

        const active = document.querySelector("#ledger tbody tr:first-child td.is-active");
        expect(active.dataset.key).toBe("scoring");
        expect(active.textContent).toBe("131.0");
    });

    test("the row carries the chosen column's context and chart for a phone", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Luck")
            .click();

        const first = document.querySelector("#ledger tbody tr");
        expect(first.querySelector(".ledger__meta").textContent).toBe("5-0 · 36-9 all-play");
        expect(first.querySelector(".ledger__chart .dv__bar--positive")).not.toBeNull();

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Lineup")
            .click();

        const updated = document.querySelector("#ledger tbody tr");
        expect(updated.querySelector(".ledger__meta").textContent).toBe(
            "24.5 pts left on the bench"
        );
        expect(updated.querySelector(".ledger__chart .dot__pt")).not.toBeNull();
    });

    test("changing the power method refetches, because the ranks are server-side", async () => {
        const fetchMock = boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
        const before = fetchMock.mock.calls.length;

        const select = document.getElementById("powerAlgorithm");
        expect([...select.options].map((option) => option.value)).toEqual(OVERVIEW.algorithms);
        select.value = "recent_form";
        select.dispatchEvent(new window.Event("change"));

        await waitFor(() => fetchMock.mock.calls.length > before);
        expect(
            fetchMock.mock.calls.some((call) =>
                String(call[0]).includes("/ledger?algorithm=recent_form")
            )
        ).toBe(true);
    });

    test("an older power-method response cannot overwrite the latest choice", async () => {
        let resolveRecord;
        let resolveRecent;
        const recordResponse = new Promise((resolve) => { resolveRecord = resolve; });
        const recentResponse = new Promise((resolve) => { resolveRecent = resolve; });
        boot({
            fetch: (target) => {
                if (target.includes("/ledger?algorithm=record")) return recordResponse;
                if (target.includes("/ledger?algorithm=recent_form")) return recentResponse;
                return null;
            },
        });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        const select = document.getElementById("powerAlgorithm");
        select.value = "record";
        select.dispatchEvent(new window.Event("change"));
        select.value = "recent_form";
        select.dispatchEvent(new window.Event("change"));

        const withRank = (rank, algorithm) => ledger({
            algorithm,
            teams: TEAMS.map((entry) => Object.assign({}, entry, {
                power: Object.assign({}, entry.power, { rank }),
            })),
        });
        resolveRecent(response(withRank(8, "recent_form")));
        await waitFor(() => document.querySelector('td[data-key="power"]').textContent.startsWith("8"));
        resolveRecord(response(withRank(3, "record")));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.querySelector('td[data-key="power"]').textContent.startsWith("8")).toBe(true);
        expect(document.getElementById("powerAlgorithm").value).toBe("recent_form");
    });

    test("the three charts read across the same teams", async () => {
        boot();
        await waitFor(() => document.querySelectorAll("#charts .chart").length === 3);

        const titles = [...document.querySelectorAll("#charts .chart__title")].map(
            (node) => node.textContent
        );
        expect(titles).toEqual(["Luck index", "Manager rating", "Weekly range"]);
        expect(document.querySelector('[data-board="charts"]').hidden).toBe(false);
    });

    test("a season with no completed games hides the charts instead of drawing empty ones", async () => {
        const blank = TEAMS.map((row) =>
            Object.assign({}, row, {
                all_play: { wins: 0, losses: 0, ties: 0, games: 0, win_pct: 0 },
            })
        );
        boot({ ledger: ledger({ teams: blank }) });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        expect(document.querySelector('[data-board="charts"]').hidden).toBe(true);
    });

    test("an unscorable manager rating explains itself rather than showing a blank column", async () => {
        boot({
            ledger: ledger({
                manager_rating: { available: false, reason: "no_actuals", weeks: [] },
            }),
        });
        await waitFor(() => document.getElementById("ledgerFootnote").textContent !== "");

        expect(document.getElementById("ledgerFootnote").textContent).toContain(
            "actual points"
        );
    });

    test("the manager-rating note discloses excluded aggregate slots", async () => {
        boot({
            ledger: ledger({
                manager_rating: {
                    available: true,
                    reason: null,
                    league_average: 0.9395,
                    weeks: [1, 2],
                    excluded_slots: ["DST"],
                },
            }),
        });
        await waitFor(() => document.getElementById("ledgerFootnote").textContent !== "");

        expect(document.getElementById("ledgerFootnote").textContent).toContain(
            "DST is excluded"
        );
    });

    test("your own row is marked, and your start/sit moves reach the strip", async () => {
        boot({
            me: {
                status: "configured",
                selected_team_id: 2,
                snapshot: {
                    team: { espn_team_id: 2, name: "Bravo" },
                    record: { wins: 5, losses: 0, ties: 0 },
                    opponent: { name: "Alpha" },
                    power_rank: 1,
                },
            },
            lineup: {
                available: true,
                gain: 9.1,
                slots: ["QB"],
                week: 6,
                current: { total: 100 },
                optimal: { total: 109.1 },
                starts: [{ name: "Rome Odunze", slot: "FLEX", projected_points: 14.8 }],
                sits: [{ name: "Zach Charbonnet", slot: "FLEX", projected_points: 9.2 }],
            },
        });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
        await waitFor(() => document.querySelectorAll("#myTeamMoves li").length === 2);

        expect(document.querySelector(".ledger-row--mine .team-cell__name").textContent).toBe(
            "Bravo"
        );
        expect(document.getElementById("myTeamAdvice").textContent).toContain("9.1");
        const moves = [...document.querySelectorAll("#myTeamMoves li")].map(
            (node) => node.textContent
        );
        expect(moves[0]).toContain("Rome Odunze");
        expect(moves[1]).toContain("Zach Charbonnet");
    });

    test("an unconfigured season clears the previous season's team highlight", async () => {
        const seasons = [
            { season: 2026, status: "ok", available: true },
            { season: 2025, status: "ok", available: true },
        ];
        boot({
            fetch: (target) => {
                if (target.includes("/overview")) {
                    const season = target.includes("season=2025") ? 2025 : 2026;
                    return response(Object.assign({}, OVERVIEW, { season, seasons }));
                }
                if (target.includes("/me?")) {
                    if (target.includes("season=2025")) return response({ status: "unconfigured" });
                    return response({
                        status: "configured",
                        selected_team_id: 2,
                        snapshot: {
                            team: { espn_team_id: 2, name: "Bravo" },
                            record: { wins: 5, losses: 0, ties: 0 },
                        },
                    });
                }
                return null;
            },
        });
        await waitFor(() => document.querySelector(".ledger-row--mine") !== null);

        [...document.querySelectorAll("#seasonChips .chip")]
            .find((chip) => chip.textContent === "2025")
            .click();

        await waitFor(() => window.location.search.includes("season=2025"));
        await waitFor(() => document.querySelector(".ledger-row--mine") === null);
        expect(document.getElementById("myTeamStrip").hidden).toBe(true);
    });

    test("the table leads whatever the season's state, preseason included", () => {
        // The hub used to reorder itself before week 1, putting the teams
        // grid above a table with nothing in it. The table leads now in
        // every state, so nothing may reorder the boards at all.
        expect(styleSource).not.toContain("is-preseason");
        expect(styleSource).not.toContain('[data-board="standings"]');
        expect(styleSource).not.toContain('[data-board="power"]');
        expect(appSource).not.toContain("is-preseason");
    });

    test("a preseason season still renders the table, first", async () => {
        const blank = TEAMS.map((row) =>
            Object.assign({}, row, {
                wins: 0,
                losses: 0,
                win_pct: 0,
                points_for: 0,
                luck: null,
                expected_wins: null,
                all_play: { wins: 0, losses: 0, ties: 0, games: 0, win_pct: 0 },
                playoff: { odds: null, projected_wins: null, projected_losses: null },
            })
        );
        boot({
            overview: Object.assign({}, OVERVIEW, {
                mode: "preseason",
                latest_week: null,
                completed_weeks: [],
            }),
            ledger: ledger({ teams: blank, power_week: null }),
        });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        // Power rankings read rosters, so they lead in every state; the
        // table is next, present even while it is all dashes.
        const boards = [...document.querySelectorAll("#leagueSections .board")];
        expect(boards[0].dataset.board).toBe("power");
        expect(boards[1].dataset.board).toBe("ledger");
        expect(document.getElementById("leagueSections").className).toBe("");
        // Empty, but present and explained rather than reordered away.
        expect(document.getElementById("modeBanner").hidden).toBe(false);
        expect(document.querySelector('#ledger td[data-key="luck"]').textContent).toBe("—");
    });

    test("a team without a computable measure sinks and prints a dash", async () => {
        const teams = [
            TEAMS[0],
            Object.assign({}, TEAMS[1], {
                lineup: { efficiency: null, points_left: null, weeks: 0 },
            }),
        ];
        boot({ ledger: ledger({ teams }) });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        [...document.querySelectorAll("#ledgerColumns .chip")]
            .find((chip) => chip.textContent === "Lineup")
            .click();

        expect(rowNames()).toEqual(["Alpha", "Bravo"]);
        const last = document.querySelectorAll("#ledger tbody tr")[1];
        expect(last.querySelector('td[data-key="lineup"]').textContent).toBe("—");
    });
});

describe("league hub power rankings", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const player = (overrides) =>
        Object.assign(
            {
                player_id: "p",
                name: "Player",
                position: "QB",
                pro_team: "KC",
                slot: null,
                ppg: 10,
                out: false,
                marginal: 0,
            },
            overrides
        );

    const ROSTER_POWER = {
        available: true,
        season: 2026,
        week: 2,
        scoring: "half",
        absence_rate: 0.15,
        replacements: { QB: { name: "Waiver QB", ppg: 11.6 } },
        teams: [
            Object.assign({}, TEAMS[1], {
                rank: 1,
                standings_rank: 2,
                expected: 134.4,
                players: [player({ player_id: "a", name: "Starter QB", slot: "QB", ppg: 20, marginal: 4.2 })],
                waiver_starters: [],
                surplus: [],
                need: null,
            }),
            Object.assign({}, TEAMS[0], {
                rank: 2,
                standings_rank: 1,
                expected: 120.1,
                players: [
                    player({ player_id: "b", name: "Only QB", slot: "QB", ppg: 19, marginal: 3.1 }),
                    player({ player_id: "c", name: "Spare RB", position: "RB", ppg: 9.8, marginal: 0 }),
                ],
                waiver_starters: [player({ player_id: "w", name: "Waiver QB", slot: "OP", ppg: 11.6 })],
                surplus: [player({ player_id: "c", name: "Spare RB", position: "RB", ppg: 9.8 })],
                need: {
                    slot: "OP",
                    seat: "OP",
                    position: "QB",
                    name: "Waiver QB",
                    ppg: 11.6,
                    league_average: 16.8,
                    gap: -5.2,
                    from_waivers: true,
                },
            }),
        ],
    };

    test("ranks rosters with the reasons under each team", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => document.querySelectorAll("#powerList .power-row").length === 2);

        const rows = [...document.querySelectorAll("#powerList .power-row")];
        expect(rows.map((row) => row.querySelector(".team-cell__name").textContent)).toEqual([
            TEAMS[1].name,
            TEAMS[0].name,
        ]);
        expect(rows[0].querySelector(".power-row__value strong").textContent).toBe("134.4");
        const need = rows[1].querySelector(".power-note--need").textContent;
        expect(need).toContain("Weakest spot: OP");
        expect(need).toContain("Nobody on the roster can fill it — the best free agent, Waiver QB (QB)");
        expect(need).toContain("16.8 for other teams' OP starters");
        expect(rows[1].querySelector(".power-note--surplus").textContent).toContain("Spare RB (RB)");
        // The lineup behind the number folds away, waiver seat included.
        const detail = rows[1].querySelector("details.power-detail");
        expect(detail.open).toBe(false);
        expect(detail.querySelector(".power-detail__row--waiver").textContent).toContain("waivers");
        expect(document.getElementById("powerFootnote").textContent).toContain("15% of weeks");
    });

    test("says why it is empty for a season without projections", async () => {
        boot({
            rosterPower: { available: false, unavailable_reason: "projection_season_mismatch", teams: [] },
        });
        await waitFor(() => document.querySelector("#powerList .empty-note"));
        expect(document.querySelector("#powerList .empty-note").textContent).toContain(
            "only cover the current season"
        );
    });
});

// ── the section's front door ────────────────────────────────────────────
//
// /fantasy/ used to be the market dashboard and the league hub lived a click
// in. The hub is home now, so it owns two jobs it did not have before: it is
// the first page a signed-out visitor sees, and it is where "My Team" in the
// section nav lands from anywhere else in the section.

describe("importing a league", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const status = () => document.getElementById("importStatus");
    const field = () => document.getElementById("importLeagueId");

    function submit(value) {
        field().value = value;
        document
            .getElementById("importForm")
            .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    }

    test("the field does not truncate a pasted ESPN URL before parsing it", () => {
        document.body.innerHTML = bodySource;
        expect(field().getAttribute("maxlength")).toBeNull();
    });

    test("a typo is called a typo, not a failed import", async () => {
        boot({ overview: { ...OVERVIEW, league_id: "225965" } });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        submit("my league");
        expect(status().dataset.status).toBe("invalid");
        expect(status().textContent).toContain("all digits");
        expect(field().getAttribute("aria-invalid")).toBe("true");
    });

    test("the league already on screen says so", async () => {
        boot({ overview: { ...OVERVIEW, league_id: "225965" } });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        submit("225965");
        expect(status().dataset.status).toBe("current");
        expect(status().textContent).toContain("the one you are looking at");
    });

    test("a valid ID for another league gets a straight answer, not a spinner", async () => {
        const fetchMock = boot({ overview: { ...OVERVIEW, league_id: "225965" } });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
        const before = fetchMock.mock.calls.length;

        submit("998877");
        expect(status().dataset.status).toBe("unsupported");
        expect(status().textContent).toContain("cannot collect a second one yet");
        // Nothing was requested: the form is honest about being a front end
        // for work that has not landed.
        expect(fetchMock.mock.calls.length).toBe(before);
    });

    test("pasting the whole ESPN URL reads the ID out of it", async () => {
        boot({ overview: { ...OVERVIEW, league_id: "225965" } });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        submit("https://fantasy.espn.com/football/league?leagueId=225965&seasonId=2026");
        expect(status().dataset.status).toBe("current");
        expect(field().value).toBe("225965");
    });

    test("typing again clears the last answer", async () => {
        boot({ overview: { ...OVERVIEW, league_id: "225965" } });
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        submit("nope");
        field().dispatchEvent(new window.Event("input", { bubbles: true }));
        expect(status().textContent).toBe("");
        expect(field().getAttribute("aria-invalid")).toBeNull();
    });
});

describe("?team=me", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const CONFIGURED = {
        status: "configured",
        selected_team_id: 2,
        snapshot: { team: { espn_team_id: 2, name: "Bravo", owner_name: "Ray" } },
    };

    test("resolves to your team and rewrites the URL to a real id", async () => {
        boot({ me: CONFIGURED }, "/fantasy/?team=me");
        await waitFor(() => !document.getElementById("teamView").hidden);

        expect(new URLSearchParams(window.location.search).get("team")).toBe("2");
        expect(document.getElementById("leagueSections").hidden).toBe(true);
    });

    test("with no team chosen it lands on the league and says why", async () => {
        boot({ me: { status: "unconfigured" } }, "/fantasy/?team=me");
        await waitFor(
            () => !document.getElementById("routeBanner").hidden
        );

        expect(document.getElementById("routeBanner").textContent).toContain(
            "Pick your team below"
        );
        // Not a blank team view: the league is what you get instead.
        expect(document.getElementById("teamView").hidden).toBe(true);
        expect(new URLSearchParams(window.location.search).get("team")).toBeNull();
    });
});

describe("the signed-out front door", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("a 403 shows the teaser, not a bare members-only box", async () => {
        boot({ fetch: (target) => (target.includes("/overview") ? response({}, 403) : null) });
        await waitFor(() => !document.getElementById("signedOutView").hidden);

        const teaser = document.getElementById("signedOutView");
        expect(teaser.classList.contains("teaser")).toBe(true);
        expect(teaser.querySelectorAll(".teaser__list li").length).toBeGreaterThan(0);
        expect(document.getElementById("leagueView").hidden).toBe(true);
    });

    test("it offers the one page that works without an account", async () => {
        boot({ fetch: (target) => (target.includes("/overview") ? response({}, 403) : null) });
        await waitFor(() => !document.getElementById("signedOutView").hidden);

        const escape = document.querySelector(".teaser__escape a");
        expect(escape.getAttribute("href")).toBe("/fantasy/market/");
    });

    test("signing in is still the primary action", async () => {
        boot({ fetch: (target) => (target.includes("/overview") ? response({}, 403) : null) });
        await waitFor(() => !document.getElementById("signedOutView").hidden);

        expect(document.getElementById("signInLink").getAttribute("href")).toContain("/login/");
    });
});
