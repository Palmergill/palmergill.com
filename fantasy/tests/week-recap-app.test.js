/**
 * The weekly recap controller.
 *
 * What is worth pinning here is everything the format module cannot see: the
 * two-axis chip bar (season and week), the fact that an unplayed week is
 * unpressable rather than a route to an empty page, and the note lifecycle —
 * a stored note is read without generating, and only the explicit Rewrite
 * forces a new one.
 */
const fs = require("fs");
const path = require("path");

const weekDir = path.join(__dirname, "..", "league", "week");
const appSource = fs.readFileSync(path.join(weekDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(weekDir, "index.html"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../league/week/format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

function grade(teamId, overrides = {}) {
    return {
        espn_team_id: teamId,
        team: `Team ${teamId}`,
        owner: `Owner ${teamId}`,
        grade: "A",
        composite: 1.1,
        components: {
            scoring: { raw: 130, z: 1.2, weight: 0.45 },
            management: { raw: 1, z: 1.0, weight: 0.3 },
            matchup: { raw: 40, z: 1.1, weight: 0.25 },
        },
        points: 130,
        opponent: { espn_team_id: 2, name: "Team 2", points: 90 },
        result: "win",
        margin: 40,
        all_play: { wins: 1, losses: 0, ties: 0, pct: 1 },
        projected: 118,
        vs_projection: 12,
        optimal: 130,
        efficiency: 1,
        points_left: 0,
        unscored_starters: 0,
        best_starter: { name: "Star Back", points: 30, projected: 18 },
        worst_starter: { name: "Quiet End", points: 6, projected: 9 },
        bench_hero: null,
        should_have_started: [],
        power: { rank: 1, previous_rank: 3, rank_delta: 2 },
        ...overrides,
    };
}

function recap(season, week, { played = true } = {}) {
    return {
        season,
        week,
        scoring: "half",
        status: played ? "complete" : "not_played",
        available_weeks: [1, 2],
        played_weeks: played ? [1] : [],
        teams: [
            { espn_team_id: 1, name: "Team 1", owner: "Owner 1" },
            { espn_team_id: 2, name: "Team 2", owner: "Owner 2" },
        ],
        matchups: played
            ? [
                  {
                      espn_matchup_id: 1,
                      is_complete: true,
                      is_bye: false,
                      margin: 40,
                      home: { espn_team_id: 1, name: "Team 1", points: 130 },
                      away: { espn_team_id: 2, name: "Team 2", points: 90 },
                  },
              ]
            : [],
        grades: played ? [grade(1)] : [],
        accolades: played
            ? [
                  {
                      key: "top_score",
                      label: "Team of the week",
                      blurb: "The most points anybody put on the board.",
                      winner: {
                          espn_team_id: 1,
                          team: "Team 1",
                          detail: "beat Team 2 130–90",
                          display: "130.0 pts",
                      },
                      runner_up: null,
                      standings: [],
                  },
              ]
            : [],
        callouts: {},
        lineups: { available: true, reason: null, excluded_slots: ["DST"] },
        method: { weights: {}, components: {} },
    };
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the weekly recap controller");
}

function boot(fetchImplementation, url = "/fantasy/league/week/") {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", url);
    window.WeekFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn(fetchImplementation);
    window.eval(appSource);
    return window.fetch;
}

const SEASONS = {
    seasons: [
        { season: 2026, status: "ok", available: true },
        { season: 2024, status: "ok", available: true },
    ],
};

describe("weekly recap controller", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("renders the slate, the awards and the grades from one read", async () => {
        boot((url) => {
            const requested = String(url);
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("/week")) return response(recap(2026, 1));
            throw new Error(`Unexpected request: ${requested}`);
        });

        await waitFor(() => !document.getElementById("weekView").hidden);
        expect(document.getElementById("statusValue").textContent).toBe("Week 1");
        expect(document.querySelectorAll(".score")).toHaveLength(1);
        expect(document.querySelector(".score__side--won").textContent).toContain("Team 1");
        expect(document.querySelectorAll(".award")).toHaveLength(1);
        expect(document.querySelectorAll(".grade")).toHaveLength(1);
        expect(document.querySelectorAll("#teamRows tr")).toHaveLength(1);
        // The award the team won is repeated on its own card, so a manager
        // does not have to scan the wall to find their own trophy.
        expect(document.querySelector(".grade__trophies").textContent).toContain(
            "Team of the week"
        );
        expect(document.getElementById("lineupNote").textContent).toContain("DST");
    });

    test("a week nobody has played is visible but unpressable", async () => {
        boot((url) => {
            const requested = String(url);
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("/week")) return response(recap(2026, 1));
            throw new Error(`Unexpected request: ${requested}`);
        });

        await waitFor(() => document.querySelectorAll("#weekChips .chip").length === 2);
        const chips = [...document.querySelectorAll("#weekChips .chip")];
        expect(chips.map((chip) => chip.textContent)).toEqual(["Wk 1", "Wk 2"]);
        expect(chips[0].classList.contains("chip--active")).toBe(true);
        expect(chips[1].disabled).toBe(true);
    });

    test("choosing a season asks the API which week to open on", async () => {
        const requests = [];
        boot((url) => {
            const requested = String(url);
            requests.push(requested);
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("season=2024")) return response(recap(2024, 14));
            if (requested.includes("/week")) return response(recap(2026, 1));
            throw new Error(`Unexpected request: ${requested}`);
        }, "/fantasy/league/week/?season=2026&week=1");

        await waitFor(() => !document.getElementById("weekView").hidden);
        [...document.querySelectorAll("#seasonChips .chip")]
            .find((chip) => chip.textContent === "2024")
            .click();

        await waitFor(() => document.getElementById("statusValue").textContent === "Week 14");
        // Week 1 of 2026 has nothing to do with week 1 of 2024, so the week
        // is dropped rather than carried across.
        const switched = requests[requests.length - 1];
        expect(switched).toContain("season=2024");
        expect(switched).not.toContain("week=");
        expect(window.location.search).toBe("?season=2024&week=14");
    });

    test("an unplayed season reports itself instead of rendering an empty week", async () => {
        boot((url) => {
            const requested = String(url);
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("/week")) return response(recap(2026, null, { played: false }));
            throw new Error(`Unexpected request: ${requested}`);
        });

        await waitFor(() => !document.getElementById("emptyView").hidden);
        expect(document.getElementById("weekView").hidden).toBe(true);
        expect(document.getElementById("seasonBar").hidden).toBe(false);
    });

    test("signed-out sends the reader to login and keeps their destination", async () => {
        boot(() => response({ detail: "Sign in to view the league hub." }, 403),
            "/fantasy/league/week/?season=2026&week=3");

        await waitFor(() => !document.getElementById("signedOutView").hidden);
        expect(document.getElementById("signInLink").href).toContain(
            encodeURIComponent("/fantasy/league/week/?season=2026&week=3")
        );
        expect(document.getElementById("seasonBar").hidden).toBe(true);
    });

    test("loads a stored note and forces the Rewrite action", async () => {
        const requests = [];
        boot((url, options = {}) => {
            const requested = String(url);
            requests.push({ url: requested, method: options.method || "GET" });
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("/week/notes/1")) {
                if (options.method === "POST") {
                    return response({ note_md: "A newly written recap." });
                }
                return response({ note_md: "A stored recap." });
            }
            if (requested.includes("/week")) return response(recap(2026, 1));
            throw new Error(`Unexpected request: ${requested}`);
        }, "/fantasy/league/week/?season=2026&week=1");

        await waitFor(() => !document.getElementById("weekView").hidden);
        document.querySelector(".grade__toggle").click();
        await waitFor(() =>
            document.querySelector(".grade__note-body").textContent.includes("stored")
        );

        // A plain expand must never bill for a model call.
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);

        const rewrite = document.querySelector(".grade__note .button");
        expect(rewrite.textContent).toBe("Rewrite");
        rewrite.click();

        await waitFor(() =>
            document.querySelector(".grade__note-body").textContent.includes("newly")
        );
        const post = requests.find((request) => request.method === "POST");
        expect(post.url).toContain("season=2026");
        expect(post.url).toContain("week=1");
        expect(post.url).toContain("force=true");
    });

    test("a lineup that could not be scored says why instead of showing zero", async () => {
        boot((url) => {
            const requested = String(url);
            if (requested.endsWith("/seasons")) return response(SEASONS);
            if (requested.includes("/week")) {
                const payload = recap(2026, 1);
                payload.grades = [
                    grade(1, {
                        efficiency: null,
                        points_left: null,
                        optimal: null,
                        unscored_starters: 2,
                        components: {
                            scoring: { raw: 130, z: 1.2, weight: 0.64 },
                            matchup: { raw: 40, z: 1.1, weight: 0.36 },
                        },
                    }),
                ];
                payload.lineups = {
                    available: false,
                    reason: "no_roster_snapshot",
                    excluded_slots: [],
                };
                return response(payload);
            }
            throw new Error(`Unexpected request: ${requested}`);
        });

        await waitFor(() => !document.getElementById("weekView").hidden);
        expect(document.getElementById("gradesNote").textContent).toContain(
            "1 lineup(s) could not be scored"
        );
        expect(document.getElementById("lineupNote").textContent).toBe(
            F.LINEUP_REASONS.no_roster_snapshot
        );

        document.querySelector(".grade__toggle").click();
        expect(document.querySelector(".grade__body").textContent).toContain(
            "2 starter(s) have no line"
        );
        // Only the components the API actually graded on are drawn.
        expect(document.querySelectorAll(".component")).toHaveLength(2);
    });
});
