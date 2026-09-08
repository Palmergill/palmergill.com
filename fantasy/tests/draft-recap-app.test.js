const fs = require("fs");
const path = require("path");

const draftDir = path.join(__dirname, "..", "league", "draft");
const appSource = fs.readFileSync(path.join(draftDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(draftDir, "index.html"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../league/draft/format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

function recap(season, withPicks = true) {
    const player = {
        overall_pick: 1,
        round: 1,
        round_pick: 1,
        espn_team_id: 1,
        keeper: false,
        autopicked: false,
        player: {
            player_id: "p1",
            name: "Alpha Runner",
            position: "RB",
            pro_team: "DET",
            bye: 6,
        },
        adp: 2,
        adp_ranked: true,
        adp_sigma: 0.5,
        points: { best: 200 },
    };
    const grade = {
        espn_team_id: 1,
        team: "Alpha",
        owner: "Taylor",
        grade: "A",
        unranked_picks: 0,
        construction_notes: [],
        best_pick: null,
        worst_pick: null,
        components: {
            adp_value: { z: 1, weight: 0.35 },
            starters: { z: 1, weight: 0.30 },
            bench: { z: 0, weight: 0.15 },
            construction: { z: 0, weight: 0.20 },
        },
    };
    return {
        season,
        status: withPicks ? "complete" : "not_drafted",
        teams: [{ espn_team_id: 1, name: "Alpha", owner: "Taylor" }],
        picks: withPicks ? [player] : [],
        grades: withPicks ? [grade] : [],
        accolades: [],
        callouts: {},
        adp_source: null,
        method: { weights: {}, starting_slots: [], replacement_points: null },
    };
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for the draft recap controller");
}

function boot(fetchImplementation, url = "/fantasy/league/draft/") {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", url);
    window.DraftFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn(fetchImplementation);
    window.eval(appSource);
    return window.fetch;
}

describe("draft recap controller", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("season chips remain available from an undrafted current season", async () => {
        const seasons = {
            seasons: [
                { season: 2026, status: "ok", available: true },
                { season: 2025, status: "ok", available: true },
            ],
        };
        boot((url) => {
            const requested = String(url);
            if (requested.endsWith("/seasons")) return response(seasons);
            if (requested.includes("season=2025")) return response(recap(2025));
            if (requested.includes("/draft")) return response(recap(2026, false));
            throw new Error(`Unexpected request: ${requested}`);
        });

        await waitFor(() => !document.getElementById("emptyView").hidden);
        expect(document.getElementById("seasonBar").hidden).toBe(false);
        expect(document.querySelectorAll("#seasonChips .chip")).toHaveLength(2);

        [...document.querySelectorAll("#seasonChips .chip")]
            .find((button) => button.textContent === "2025")
            .click();

        await waitFor(() => document.getElementById("statusSeason").textContent === "2025");
        expect(document.getElementById("draftView").hidden).toBe(false);
        expect(window.location.search).toBe("?season=2025");
        expect(document.querySelector("#seasonChips .chip--active").textContent).toBe("2025");
    });

    test("loads a stored note and forces the Rewrite action", async () => {
        const requests = [];
        const fetchMock = boot((url, options = {}) => {
            const requested = String(url);
            requests.push({ url: requested, method: options.method || "GET" });
            if (requested.endsWith("/seasons")) {
                return response({
                    seasons: [{ season: 2026, status: "ok", available: true }],
                });
            }
            if (requested.includes("/draft/notes/1")) {
                if (options.method === "POST") {
                    return response({ note_md: "A newly written recap." });
                }
                return response({ note_md: "A stored recap." });
            }
            if (requested.includes("/draft")) return response(recap(2026));
            throw new Error(`Unexpected request: ${requested}`);
        }, "/fantasy/league/draft/?season=2026");

        await waitFor(() => !document.getElementById("draftView").hidden);
        document.querySelector(".grade__toggle").click();
        await waitFor(() => document.querySelector(".grade__note-body").textContent.includes("stored"));

        const rewrite = document.querySelector(".grade__note .button");
        expect(rewrite.textContent).toBe("Rewrite");
        rewrite.click();

        await waitFor(() => document.querySelector(".grade__note-body").textContent.includes("newly"));
        const post = requests.find((request) => request.method === "POST");
        expect(post.url).toContain("season=2026");
        expect(post.url).toContain("force=true");
        expect(fetchMock).toHaveBeenCalled();
    });
});
