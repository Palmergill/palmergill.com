const fs = require("fs");
const path = require("path");

const leagueDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(leagueDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(leagueDir, "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(leagueDir, "style.css"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../format.js");

function response(data, status = 200, headers = {}) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => headers[name] ?? null },
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

const POWER_HISTORY = {
    season: 2026,
    metric: "resume",
    algorithm: "composite",
    algorithms: OVERVIEW.algorithms,
    playoff_start_week: 15,
    last_week: 14,
    available: true,
    unavailable_reason: null,
    weeks: [1, 2],
    teams: [
        {
            espn_team_id: 1,
            name: "Alpha",
            points: [
                { week: 1, rank: 2, value: 0.51 },
                { week: 2, rank: 1, value: 0.72 },
            ],
        },
        {
            espn_team_id: 2,
            name: "Bravo",
            points: [
                { week: 1, rank: 1, value: 0.88 },
                { week: 2, rank: 2, value: 0.64 },
            ],
        },
    ],
};

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
    window.fetch = jest.fn((requested, options) => {
        const target = String(requested);
        if (overrides.fetch) {
            const custom = overrides.fetch(target, options);
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
        if (target.includes("/power-history")) {
            const metric = new URL(target, "https://x").searchParams.get("metric");
            const key = metric === "roster" ? "rosterHistory" : "resumeHistory";
            return response(overrides[key] || POWER_HISTORY);
        }
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
            "2 teams · results through week 2"
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

    test("résumé is always ranked on every factor, with no method to pick", async () => {
        const fetchMock = boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        // The method menu confused more than it answered, so it is gone.
        expect(document.querySelector("#standings select")).toBeNull();
        expect(
            fetchMock.mock.calls.some((call) =>
                String(call[0]).includes("/ledger?algorithm=composite")
            )
        ).toBe(true);
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

    test("your own row is marked", async () => {
        // The only thing /league/me is still read for on this view. The strip
        // it used to feed is gone: "My Team" lives in the section nav, and
        // the start/sit moves are on the team page itself.
        boot({
            me: {
                status: "configured",
                selected_team_id: 2,
                snapshot: {
                    team: { espn_team_id: 2, name: "Bravo" },
                    record: { wins: 5, losses: 0, ties: 0 },
                },
            },
        });
        await waitFor(() => document.querySelector(".ledger-row--mine") !== null);

        expect(document.querySelector(".ledger-row--mine .team-cell__name").textContent).toBe(
            "Bravo"
        );
    });

    test("the lineup is not fetched for a view that no longer shows it", async () => {
        const fetchMock = boot({
            me: {
                status: "configured",
                selected_team_id: 2,
                snapshot: { team: { espn_team_id: 2, name: "Bravo" } },
            },
        });
        await waitFor(() => document.querySelector(".ledger-row--mine") !== null);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const lineupCalls = fetchMock.mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.includes("/lineup"));
        expect(lineupCalls).toEqual([]);
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

        // Switching season is a row in the History board now, not a chip.
        [...document.querySelectorAll("#historyList .history__open")][0].click();

        await waitFor(() => window.location.search.includes("season=2025"));
        await waitFor(() => document.querySelector(".ledger-row--mine") === null);
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

        // Power rankings read rosters, so they lead in every state, with
        // their own chart under them; the table is next, present even while
        // it is all dashes.
        const boards = [...document.querySelectorAll("#leagueSections .board")];
        expect(boards[0].dataset.board).toBe("power");
        expect(boards[1].dataset.board).toBe("power-chart");
        expect(boards[2].dataset.board).toBe("ledger");
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

    const rows = () => [...document.querySelectorAll("#powerList .power-row")];
    const stat = (row, key) =>
        row.querySelector(`.power-row__stat--${key} strong`).textContent;

    test("ranks rosters, and says nothing else about them", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => rows().length === 2);

        expect(rows().map((row) => row.querySelector(".team-cell__name").textContent)).toEqual([
            TEAMS[1].name,
            TEAMS[0].name,
        ]);
        expect(rows().map((row) => row.querySelector(".power-row__rank").textContent)).toEqual([
            "1",
            "2",
        ]);
        expect(stat(rows()[0], "expected")).toBe("134.4");
        expect(stat(rows()[1], "expected")).toBe("120.1");
    });

    test("the prose that used to hang off every row is gone", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => rows().length === 2);

        // The weakest-seat sentence, the surplus list, the foldaway lineup
        // table, the lede and the footnote. A board whose job is an order
        // does not get to be an essay.
        [".power-note", ".power-note--need", ".power-note--surplus", "details.power-detail"]
            .forEach((selector) => {
                expect(document.querySelector(`#powerList ${selector}`)).toBeNull();
            });
        expect(document.querySelector("#power .board__lede")).toBeNull();
        expect(document.getElementById("powerFootnote")).toBeNull();
        expect(pageSource).not.toContain("powerFootnote");
    });

    test("each row is rank, team and two numbers — nothing more", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => rows().length === 2);

        const parts = [...rows()[0].children].map((node) => node.className);
        expect(parts).toEqual([
            "power-row__rank",
            "power-row__team",
            "power-row__stat power-row__stat--expected",
            "power-row__stat power-row__stat--odds",
        ]);
    });

    test("playoff odds join from the ledger, whichever payload lands first", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => rows().length === 2);
        // TEAMS[1] is Bravo at 98%, TEAMS[0] is Alpha at 91%.
        await waitFor(() => stat(rows()[0], "odds") !== "—");

        expect(stat(rows()[0], "odds")).toBe("98%");
        expect(stat(rows()[1], "odds")).toBe("91%");
    });

    test("a team the ledger has no odds for prints a dash, not a zero", async () => {
        boot({
            rosterPower: ROSTER_POWER,
            ledger: ledger({
                teams: TEAMS.map((team) => Object.assign({}, team, { playoff: null })),
            }),
        });
        await waitFor(() => rows().length === 2);

        expect(stat(rows()[0], "odds")).toBe("—");
    });

    test("the method moved onto the two stat labels", async () => {
        boot({ rosterPower: ROSTER_POWER });
        await waitFor(() => rows().length === 2);

        const row = rows()[0];
        ["expected", "odds"].forEach((key) => {
            const hint = row.querySelector(`.power-row__stat--${key} .col-hint`);
            const bubble = hint.querySelector(".col-hint__bubble");
            expect(hint.tabIndex).toBe(0);
            expect(bubble.textContent).toBe(F.POWER_HINTS[key]);
            expect(hint.getAttribute("aria-describedby")).toBe(bubble.id);
        });
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

    test("the pitch describes one private league, not a league of your own", () => {
        document.body.innerHTML = bodySource;
        const lede = document.getElementById("teaserLede").textContent;
        expect(lede).toContain("one private ESPN league");
        expect(lede).not.toContain("open yours");
        expect(document.querySelector('#signedOutView a[href="/signup/"]')).not.toBeNull();
    });
});

// ── history ─────────────────────────────────────────────────────────────
//
// Every season the league has kept used to be a chip row at the top of the
// page, above the season you came to read. A past year is worth a row
// because of who won it, so it reads as a record at the foot instead.

describe("the history board", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const SEASONS = [
        { season: 2026, status: "ok", available: true },
        {
            season: 2025,
            status: "ok",
            available: true,
            size: 12,
            champion: {
                espn_team_id: 4,
                name: "Bakin Rice",
                owner_name: "Ray",
                wins: 11,
                losses: 3,
                ties: 0,
                runner_up: "Alpha",
                final_score: { winner: 142.6, runner_up: 118.2 },
            },
        },
        { season: 2024, status: "unauthorized", available: false },
        { season: 2023, status: "ok", available: true, size: 10, champion: null },
    ];

    function bootWithSeasons(seasons = SEASONS) {
        return boot({ overview: { ...OVERVIEW, seasons } });
    }

    const rows = () => [...document.querySelectorAll("#historyList .history__row")];
    const years = () =>
        rows().map((row) => row.querySelector(".history__year").textContent);

    test("lists every earlier season and leaves out the one you are reading", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        expect(years()).toEqual(["2025", "2024", "2023"]);
        expect(document.getElementById("historyNote").textContent).toBe("3 earlier seasons");
    });

    test("a season is a row about who won it", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        const row = rows()[0];
        expect(row.querySelector(".history__title").textContent).toContain("Bakin Rice");
        expect(row.querySelector(".history__title").textContent).toContain("Ray");
        expect(row.querySelector(".history__detail").textContent).toBe(
            "11-3 · beat Alpha, 142.6–118.2"
        );
    });

    test("opening a season switches the hub without a page load", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        const open = rows()[0].querySelector(".history__open");
        expect(open.getAttribute("href")).toBe("/fantasy/?season=2025");
        open.click();
        await waitFor(() => window.location.search.includes("season=2025"));
    });

    test("a private season is labelled, not dropped", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        const row = rows()[1];
        expect(row.querySelector(".history__title").textContent).toBe("Private season");
        expect(row.querySelector(".history__open")).toBeNull();
    });

    test("a season with no recorded champion says so rather than inventing one", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        const row = rows()[2];
        expect(row.querySelector(".history__title").textContent).toBe("No champion recorded");
        expect(row.querySelector(".history__detail").textContent).toBe("10 teams");
        // Still openable: the table and scoreboard are there either way.
        expect(row.querySelector(".history__open")).not.toBeNull();
    });

    test("a league in its first season says that instead of showing an empty board", async () => {
        bootWithSeasons([{ season: 2026, status: "ok", available: true }]);
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);

        expect(rows()).toHaveLength(0);
        expect(document.querySelector("#historyList .empty-note").textContent).toContain(
            "first season"
        );
        expect(document.getElementById("historyNote").textContent).toBe("");
    });

    test("the seasons no longer sit at the top of the page", async () => {
        bootWithSeasons();
        await waitFor(() => rows().length > 0);

        expect(document.getElementById("seasonChips")).toBeNull();
        expect(pageSource).not.toContain("seasonChips");
    });

    test("reading a past season says so; reading the live one does not", async () => {
        const viewing = () => document.getElementById("seasonViewing");

        bootWithSeasons();
        await waitFor(() => rows().length > 0);
        expect(viewing().hidden).toBe(true);

        document.body.innerHTML = "";
        boot({ overview: { ...OVERVIEW, season: 2025, seasons: SEASONS } });
        await waitFor(() => !viewing().hidden);
        expect(viewing().textContent).toBe("Viewing the 2025 season");
    });
});

// ── column definitions ──────────────────────────────────────────────────
//
// Half this table is derived, and the headers carrying the derivation are
// the ones nobody can guess: xW, All-play, Résumé, Luck. The lede under the
// heading could only ever define two before becoming a paragraph nobody
// reads, so the definitions hang off the headers themselves.

describe("column hints", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const headers = () => [...document.querySelectorAll(".ledger-table thead th")];

    async function bootLedger() {
        boot();
        await waitFor(() => document.querySelectorAll("#ledger tbody tr").length === 2);
    }

    test("every column header carries a hint, including # and Team", async () => {
        await bootLedger();

        const keys = headers().map((th) => th.dataset.key);
        expect(keys).toEqual([
            "seed", "team", "record", "points_for", "all_play", "expected",
            "luck", "lineup", "scoring", "power", "odds", "form",
        ]);
        headers().forEach((th) => {
            const bubble = th.querySelector(".col-hint__bubble");
            expect(bubble).not.toBeNull();
            expect(bubble.textContent).toBe(F.LEDGER_HINTS[th.dataset.key]);
            expect(bubble.textContent.length).toBeGreaterThan(0);
        });
    });

    test("a column with no hint would be caught here, not shipped blank", async () => {
        await bootLedger();

        const keys = headers().map((th) => th.dataset.key);
        const missing = keys.filter((key) => !F.LEDGER_HINTS[key]);
        expect(missing).toEqual([]);
        // And the other way: no hint written for a column that is not there.
        const orphans = Object.keys(F.LEDGER_HINTS).filter((key) => !keys.includes(key));
        expect(orphans).toEqual([]);
    });

    test("the hint is wired to its label for a screen reader", async () => {
        await bootLedger();

        headers().forEach((th) => {
            const label = th.querySelector(".col-hint");
            const bubble = th.querySelector(".col-hint__bubble");
            expect(bubble.id).toBe(`ledger-hint-${th.dataset.key}`);
            expect(bubble.getAttribute("role")).toBe("tooltip");
            expect(label.getAttribute("aria-describedby")).toBe(bubble.id);
        });
    });

    test("hover is not the only way in: the label takes focus", async () => {
        await bootLedger();

        headers().forEach((th) => {
            expect(th.querySelector(".col-hint").tabIndex).toBe(0);
        });
    });

    test("the bubble stays in the accessibility tree rather than being hidden", async () => {
        await bootLedger();

        // A display:none bubble is not a description of anything, so the
        // stylesheet hides it with visibility/opacity and nothing sets the
        // hidden attribute. aria-describedby depends on this.
        headers().forEach((th) => {
            expect(th.querySelector(".col-hint__bubble").hidden).toBe(false);
        });
        expect(styleSource).toContain("visibility: hidden");
        expect(appSource).not.toContain("bubble.hidden");
        // focus-within, not just focus-visible: a tap focuses the label but
        // does not match focus-visible, so this is the only path a phone has
        // to a definition it cannot hover.
        expect(styleSource).toContain(".col-hint:focus-within .col-hint__bubble");
    });

    test("the definition is not styled as the small-caps label around it", async () => {
        await bootLedger();

        // The header is uppercase and letter-spaced. A sentence inheriting
        // that arrives shouting and unwrappable.
        expect(styleSource).toMatch(/\.col-hint__bubble[^}]*text-transform:\s*none/s);
        expect(styleSource).toMatch(/\.col-hint__bubble[^}]*letter-spacing:\s*normal/s);
    });

    test("switching column does not lose the hints", async () => {
        await bootLedger();
        const chip = [...document.querySelectorAll("#ledgerColumns .chip")].find(
            (node) => node.textContent === "Luck"
        );
        chip.click();
        await waitFor(() =>
            document.querySelector('.ledger-table th[data-key="luck"]').classList.contains("is-active")
        );

        expect(headers().every((th) => th.querySelector(".col-hint__bubble"))).toBe(true);
    });
});

// ── power over time ─────────────────────────────────────────────────────
//
// The board that answers "how did we get here". Two series behind one
// toggle: "Power rankings" is the board above, week by week; résumé ranks
// what a team has earned.
// They come from different places and only one of them can reach back, so
// most of what is worth pinning here is how the chart behaves when the
// series it is asked for does not exist yet.

describe("the power chart", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    const lines = () => [...document.querySelectorAll(".rank-chart__line")];
    const legend = () => [...document.querySelectorAll(".rank-chart__legend-item")];
    const chips = () => [...document.querySelectorAll("#powerChartMetric .chip")];
    const empty = () => document.getElementById("powerChartEmpty");

    async function bootChart(overrides = {}) {
        boot(overrides);
        await waitFor(() => lines().length > 0 || !empty().hidden);
    }

    test("draws one line per team, with a legend to match", async () => {
        await bootChart();

        expect(lines()).toHaveLength(2);
        expect(legend().map((item) => item.textContent)).toEqual(["Alpha", "Bravo"]);
        expect(document.getElementById("powerChartNote").textContent).toBe(
            "2 weeks played · playoffs after week 14"
        );
    });

    const NOT_RECORDED = {
        ...POWER_HISTORY,
        available: false,
        metric: "roster",
        unavailable_reason: "roster_power_not_recorded",
        weeks: [],
        teams: [],
    };

    test("the toggle is named after the board above and starts on it", async () => {
        const fetchMock = boot();
        await waitFor(() => lines().length > 0);

        // Both metrics use the same names as their corresponding boards.
        expect(chips().map((chip) => chip.textContent)).toEqual(["Roster power", "Results rank"]);
        expect(chips()[0].classList.contains("chip--active")).toBe(true);
        expect(
            fetchMock.mock.calls.some(([url]) => String(url).includes("metric=roster"))
        ).toBe(true);
    });

    test("switching to résumé asks for the résumé series", async () => {
        const fetchMock = boot();
        await waitFor(() => lines().length > 0);

        chips()[1].click();
        await waitFor(() =>
            fetchMock.mock.calls.some(([url]) => String(url).includes("metric=resume"))
        );
        expect(chips()[1].classList.contains("chip--active")).toBe(true);
    });

    test("a season that never recorded power rankings opens on résumé instead", async () => {
        await bootChart({ rosterHistory: NOT_RECORDED });
        await waitFor(() => chips()[1].classList.contains("chip--active"));
        await waitFor(() => lines().length > 0);

        expect(empty().hidden).toBe(true);
    });

    test("asking for power rankings on such a season explains itself", async () => {
        await bootChart({ rosterHistory: NOT_RECORDED });
        await waitFor(() => chips()[1].classList.contains("chip--active"));
        chips()[0].click();
        await waitFor(() => !empty().hidden);

        // Not a blank frame: the reader is told why the line stops.
        expect(empty().textContent).toContain("September 2026");
        expect(document.querySelector(".rank-chart__svg")).toBeNull();
        expect(legend()).toHaveLength(0);
    });

    test("the chart has the toggle and nothing else to set", async () => {
        const fetchMock = boot();
        await waitFor(() => lines().length > 0);
        expect(document.querySelector("#power-chart select")).toBeNull();

        chips()[1].click();
        await waitFor(() =>
            fetchMock.mock.calls.some(([url]) =>
                String(url).includes("metric=resume") && String(url).includes("algorithm=composite")
            )
        );
    });

    test("hovering a legend entry lifts its line out of the tangle", async () => {
        await bootChart();

        legend()[0].dispatchEvent(new window.MouseEvent("mouseenter"));
        const dimmed = lines().filter((line) => line.classList.contains("is-dimmed"));
        // The others stay as context rather than disappearing — where a team
        // sits among them is the whole point.
        expect(dimmed).toHaveLength(1);
        expect(dimmed[0].dataset.teamId).toBe("2");

        legend()[0].dispatchEvent(new window.MouseEvent("mouseleave"));
        expect(lines().filter((l) => l.classList.contains("is-dimmed"))).toHaveLength(0);
    });

    test("every point carries what it was, in the units on screen", async () => {
        await bootChart();
        const tips = () =>
            [...lines()[0].querySelectorAll("title")].map((t) => t.textContent);

        // Power rankings read in the board's own unit…
        expect(tips()).toEqual([
            "Alpha · week 1 · 0.5 pts/wk",
            "Alpha · week 2 · 0.7 pts/wk",
        ]);

        // …and résumé in ranks.
        chips()[1].click();
        await waitFor(() => tips()[0] === "Alpha · week 1 · #2");
        expect(tips()).toEqual([
            "Alpha · week 1 · #2",
            "Alpha · week 2 · #1",
        ]);
    });

    test("a failed read says so rather than leaving the last chart up", async () => {
        await bootChart();
        expect(lines().length).toBeGreaterThan(0);

        document.body.innerHTML = "";
        boot({
            fetch: (target) =>
                target.includes("/power-history") ? response({}, 500) : null,
        });
        await waitFor(() => !empty().hidden);
        expect(empty().textContent).toContain("unavailable");
        expect(document.querySelector(".rank-chart__svg")).toBeNull();
    });

    test("the chart sits directly under the board it charts", async () => {
        await bootChart();

        const boards = [...document.querySelectorAll("#leagueSections .board")]
            .map((board) => board.dataset.board);
        expect(boards.indexOf("power-chart")).toBe(boards.indexOf("power") + 1);
        expect(boards.indexOf("ledger")).toBeGreaterThan(boards.indexOf("power-chart"));
    });
});


describe("league hub regression coverage", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test.each([200, 500])("ignores an older scoreboard response (%s)", async (status) => {
        let finishFirst;
        boot({ fetch: (target) => {
            if (target.includes("/scoreboard?") && target.includes("week=1")) {
                return new Promise(resolve => { finishFirst = resolve; });
            }
        }});
        const select = document.getElementById("scoreboardWeek");
        await waitFor(() => select.value === "2");
        select.value = "1";
        select.dispatchEvent(new Event("change"));
        select.value = "2";
        select.dispatchEvent(new Event("change"));
        await new Promise(resolve => setTimeout(resolve, 0));
        finishFirst(await response({ season: 2026, week: 1, available_weeks: [1, 2], matchups: [], detail: "Old failure" }, status));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(select.value).toBe("2");
        expect(document.getElementById("errorBanner").hidden).toBe(true);
    });

    test("saves a team from the hub and resolves My Team on the next visit", async () => {
        let savedId = null;
        const fetchMock = boot({ fetch: (target, options = {}) => {
            if (!target.includes("/me")) return;
            if (options.method === "PUT") savedId = JSON.parse(options.body).espn_team_id;
            return response({
                status: savedId ? "configured" : "unconfigured", teams: TEAMS,
                selected_team_id: savedId,
                snapshot: savedId ? { team: TEAMS.find(t => t.espn_team_id === savedId) } : null,
            });
        }}, "/fantasy/?team=me");
        await waitFor(() => !document.getElementById("myTeamForm").hidden);
        document.getElementById("myTeamSelect").value = "2";
        document.getElementById("myTeamForm").dispatchEvent(new Event("submit", { cancelable: true }));
        await waitFor(() => !document.getElementById("teamView").hidden);
        const put = fetchMock.mock.calls.find(([, options]) => options.method === "PUT");
        expect(JSON.parse(put[1].body)).toEqual({ season: 2026, espn_team_id: 2 });
        expect(put[1].credentials).toBe("include");
        expect(document.getElementById("myTeamSelect").value).toBe("2");
        expect(new URLSearchParams(window.location.search).get("team")).toBe("2");
        window.history.replaceState({}, "", "/fantasy/?team=me");
        window.dispatchEvent(new PopStateEvent("popstate"));
        await waitFor(() => new URLSearchParams(window.location.search).get("team") === "2");
    });

    test("a failed save leaves the picker available for retry", async () => {
        boot({ me: { status: "unconfigured", teams: TEAMS }, fetch: (target, options = {}) => {
            if (options.method === "PUT") return response({ detail: "Save failed" }, 500);
        }});
        await waitFor(() => !document.getElementById("myTeamForm").hidden);
        document.getElementById("myTeamSelect").value = "1";
        document.getElementById("myTeamForm").dispatchEvent(new Event("submit", { cancelable: true }));
        await waitFor(() => document.getElementById("myTeamStatus").textContent === "Save failed");
        expect(document.getElementById("myTeamSave").disabled).toBe(false);
        expect(document.getElementById("myTeamSelect").disabled).toBe(false);
        expect(new URLSearchParams(window.location.search).get("team")).toBeNull();
    });
});


describe("accessible power chart", () => {
    afterEach(() => { document.body.innerHTML = ""; jest.restoreAllMocks(); });
    test("legend selection persists, exposes exact ranks, and supports full-season context", async () => {
        boot();
        await waitFor(() => document.querySelectorAll(".chart-legend-button").length === 2);
        const button = document.querySelector(".chart-legend-button");
        const compactPath = document.querySelector(".rank-chart__line path").getAttribute("d");
        button.click();
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(document.getElementById("chartSelection").textContent).toContain("week 1 — #2");
        expect(document.querySelectorAll(".rank-chart__line.is-dimmed")).toHaveLength(1);
        button.parentElement.dispatchEvent(new Event("mouseleave"));
        expect(document.querySelectorAll(".rank-chart__line.is-dimmed")).toHaveLength(1);
        expect(document.querySelectorAll("#chartTable tbody tr")).toHaveLength(2);
        const full = document.getElementById("chartFullSeason");
        full.checked = true; full.dispatchEvent(new Event("change"));
        expect(document.querySelector(".rank-chart__line path").getAttribute("d")).not.toBe(compactPath);
        expect(document.getElementById("chartSelection").textContent).toBe("");
    });
});
