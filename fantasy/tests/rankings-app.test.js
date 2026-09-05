const fs = require("fs");
const path = require("path");

const rankingsDir = path.join(__dirname, "..", "rankings");
const appSource = fs.readFileSync(path.join(rankingsDir, "app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(rankingsDir, "index.html"), "utf8");
const bodySource = pageSource.match(/<body>([\s\S]*)<\/body>/)[1];
const F = require("../rankings/format.js");

function response(data, status = 200) {
    return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(data),
    });
}

function board(overrides = {}) {
    return {
        id: 1,
        season: 2026,
        scoring: "ppr",
        roster: "1qb",
        title: null,
        revision: 1,
        published: false,
        shareUrl: "/fantasy/rankings/?share=one",
        updatedAt: "2026-08-17T12:00:00Z",
        tiers: [],
        entries: [
            {
                player_id: "a", name: "Alpha Runner", team: "SF", position: "RB",
                overallRank: 1, positionRank: 1,
            },
            {
                player_id: "b", name: "Beta Runner", team: "CHI", position: "RB",
                overallRank: 2, positionRank: 2,
            },
        ],
        ...overrides,
    };
}

function trio() {
    return board({
        entries: [
            { player_id: "a", name: "Alpha Runner", team: "SF", position: "RB", overallRank: 1, positionRank: 1 },
            { player_id: "b", name: "Beta Runner", team: "CHI", position: "RB", overallRank: 2, positionRank: 2 },
            { player_id: "c", name: "Gamma Runner", team: "NYG", position: "RB", overallRank: 3, positionRank: 3 },
        ],
    });
}

function quartet() {
    const result = trio();
    result.entries.push({
        player_id: "d", name: "Delta Runner", team: "BUF", position: "RB",
        overallRank: 4, positionRank: 4,
    });
    return result;
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timed out waiting for rankings controller state");
}

function boot(fetchImplementation) {
    document.body.innerHTML = bodySource;
    window.history.replaceState({}, "", "/fantasy/rankings/?board=1");
    window.RankingsFormat = F;
    window.API_ORIGIN = "";
    window.fetch = jest.fn(fetchImplementation);
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
    init();
    return window.fetch;
}

describe("rankings controller", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("Enter in the rank input does not activate row grab mode", async () => {
        boot((url) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            return response(board());
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        const row = document.querySelector('[data-player-id="a"]');
        const input = row.querySelector(".rank-row__jump");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        expect(row.classList.contains("is-grabbed")).toBe(false);
        expect(document.getElementById("liveRegion").textContent).toBe("");
    });

    test("navigation cancels queued intents and never writes them to another board", async () => {
        let resolveFirstWrite;
        const firstWrite = new Promise((resolve) => { resolveFirstWrite = resolve; });
        let patchCount = 0;
        const fetchMock = boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(board());
            }
            if (url.endsWith("/boards/mine")) return response({ boards: [] });
            if (options.method === "PATCH") {
                patchCount += 1;
                return firstWrite;
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.querySelector('[aria-label="Move Beta Runner up"]').click();
        await waitFor(() => patchCount === 1);
        document.querySelector('[aria-label="Move Beta Runner down"]').click();
        document.getElementById("backButton").click();
        await waitFor(() => !document.getElementById("boardsView").hidden);

        resolveFirstWrite({
            status: 200,
            ok: true,
            json: () => Promise.resolve({ revision: 2, renormalized: false, tiers: [] }),
        });
        await waitFor(() => document.getElementById("savePill").textContent !== "Saving…");

        expect(patchCount).toBe(1);
        expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1);
        expect(window.location.search).not.toContain("board=");
        expect(document.getElementById("boardsView").hidden).toBe(false);
    });

    test("a conflict adopts the server board and cancels later optimistic moves", async () => {
        let resolveWrite;
        const pendingWrite = new Promise((resolve) => { resolveWrite = resolve; });
        let patchCount = 0;
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(board());
            }
            if (options.method === "PATCH") {
                patchCount += 1;
                return pendingWrite;
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.querySelector('[aria-label="Move Beta Runner up"]').click();
        await waitFor(() => patchCount === 1);
        document.querySelector('[aria-label="Move Beta Runner down"]').click();
        const serverBoard = board({
            revision: 4,
            entries: [board().entries[1], board().entries[0]],
        });
        resolveWrite({
            status: 409,
            ok: false,
            json: () => Promise.resolve({
                detail: { message: "Board changed", board: serverBoard },
            }),
        });
        await waitFor(() => document.getElementById("savePill").textContent !== "Saving…");

        expect(patchCount).toBe(1);
        expect(document.querySelector(".rank-row__name").textContent).toBe("Beta Runner");
        expect(document.getElementById("noticeBanner").textContent).toContain("changed somewhere else");
    });

    test("a matchup pick sends the winner to the top slot of the window", async () => {
        const patches = [];
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(trio());
            }
            if (options.method === "PATCH") {
                patches.push({ url, body: JSON.parse(options.body) });
                return response({ revision: 2, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("helperButton").click();
        const cards = document.querySelectorAll(".helper-card");
        expect(cards).toHaveLength(3);
        expect(document.getElementById("helperMeta").textContent).toContain("matchup 1 of 1");

        // The third card is the person's pick, so he leads the window.
        cards[2].click();
        await waitFor(() => patches.length === 1);

        expect(patches[0].url).toContain("/entries/c");
        expect(patches[0].body).toMatchObject({ scope: "OVERALL", to_rank: 1 });
        expect(
            [...document.querySelectorAll(".rank-row__name")].map((node) => node.textContent)
        ).toEqual(["Gamma Runner", "Alpha Runner", "Beta Runner"]);
    });

    test("undo puts the winner back and re-asks the same matchup", async () => {
        const patches = [];
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(trio());
            }
            if (options.method === "PATCH") {
                patches.push(JSON.parse(options.body));
                return response({ revision: patches.length + 1, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("helperButton").click();
        document.querySelectorAll(".helper-card")[1].click();
        await waitFor(() => patches.length === 1);
        expect(document.getElementById("helperUndoButton").hidden).toBe(false);

        document.getElementById("helperUndoButton").click();
        await waitFor(() => patches.length === 2);

        expect(patches[1]).toMatchObject({ to_rank: 2 });
        expect(
            [...document.querySelectorAll(".rank-row__name")].map((node) => node.textContent)
        ).toEqual(["Alpha Runner", "Beta Runner", "Gamma Runner"]);
        expect(document.getElementById("helperUndoButton").hidden).toBe(true);
        expect(document.getElementById("helperMeta").textContent).toContain("matchup 1 of");
    });

    test("a saved pick keeps keyboard focus in the next matchup", async () => {
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(quartet());
            }
            if (options.method === "PATCH") {
                return response({ revision: 2, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("helperButton").click();
        document.querySelectorAll(".helper-card")[2].click();
        await waitFor(() => document.getElementById("savePill").textContent !== "Saving…");

        expect(document.activeElement).toBe(document.querySelector(".helper-card"));
        expect(document.activeElement.dataset.playerId).toBe("a");
    });

    test("an unrelated reorder invalidates the pending helper undo", async () => {
        const patches = [];
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(quartet());
            }
            if (options.method === "PATCH") {
                patches.push(JSON.parse(options.body));
                return response({ revision: patches.length + 1, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("helperButton").click();
        document.querySelectorAll(".helper-card")[1].click();
        await waitFor(() => patches.length === 1);
        expect(document.getElementById("helperUndoButton").hidden).toBe(false);

        const deltaRank = document.querySelector('[data-player-id="d"] .rank-row__jump');
        deltaRank.value = "1";
        deltaRank.dispatchEvent(new Event("change"));
        await waitFor(() => patches.length === 2);

        expect(document.getElementById("helperUndoButton").hidden).toBe(true);
        document.getElementById("helperUndoButton").click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(patches).toHaveLength(2);
        expect(
            [...document.querySelectorAll(".rank-row__name")].map((node) => node.textContent)
        ).toEqual(["Delta Runner", "Beta Runner", "Alpha Runner", "Gamma Runner"]);
    });

    test("picking the leader confirms him without a write, and the sweep ends", async () => {
        let patchCount = 0;
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(trio());
            }
            if (options.method === "PATCH") {
                patchCount += 1;
                return response({ revision: 2, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("helperButton").click();
        document.querySelectorAll(".helper-card")[0].click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(patchCount).toBe(0);
        expect(document.getElementById("liveRegion").textContent)
            .toBe("Alpha Runner stays ahead of Beta Runner and Gamma Runner.");
        // One window fits a three-player list, so that pick ends the pass.
        expect(document.querySelectorAll(".helper-card")).toHaveLength(0);
        expect(document.getElementById("helperEmpty").textContent).toContain("Pass complete");
    });

    test("a new tier lands above the row in hand, not always at the top", async () => {
        let posted = null;
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                return response({ season: 2026, scoring: "ppr", roster: "1qb", entries: [] });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(trio());
            }
            if (options.method === "POST" && url.includes("/tiers")) {
                posted = JSON.parse(options.body);
                return response({ revision: 2, renormalized: false, tiers: [] });
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);
        jest.spyOn(window, "prompt").mockReturnValue("Round 2");

        document.querySelector('[data-player-id="c"]').dispatchEvent(new Event("focus"));
        document.getElementById("addTierButton").click();
        await waitFor(() => posted !== null);

        expect(posted).toMatchObject({ scope: "OVERALL", label: "Round 2", to_rank: 3 });
        await waitFor(
            () => document.getElementById("liveRegion").textContent === "Round 2 added above Gamma Runner."
        );
    });

    test("an older consensus reply cannot overwrite the latest comparison", async () => {
        let resolveOldConsensus;
        const oldConsensus = new Promise((resolve) => { resolveOldConsensus = resolve; });
        let consensusCount = 0;
        boot((url, options = {}) => {
            if (url.includes("/consensus?")) {
                consensusCount += 1;
                if (consensusCount === 1) return oldConsensus;
                return response({
                    season: 2026, scoring: "ppr", roster: "1qb",
                    entries: [{ player_id: "b", overallRank: 1, positionRank: 1 }],
                });
            }
            if (url.endsWith("/boards/1") && (!options.method || options.method === "GET")) {
                return response(board());
            }
            if (options.method === "PATCH") {
                return response(board({ revision: 2, published: true }));
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
        });
        await waitFor(() => !document.getElementById("editorView").hidden);

        document.getElementById("publishButton").click();
        await waitFor(() => consensusCount === 2);
        await waitFor(
            () => document.querySelector('[data-player-id="b"] .rank-row__delta').textContent === "-1"
        );
        resolveOldConsensus({
            status: 200,
            ok: true,
            json: () => Promise.resolve({
                season: 2026, scoring: "ppr", roster: "1qb",
                entries: [{ player_id: "a", overallRank: 2, positionRank: 2 }],
            }),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.querySelector('[data-player-id="b"] .rank-row__delta').textContent).toBe("-1");
        expect(document.querySelector('[data-player-id="a"] .rank-row__delta').textContent).toBe("—");
    });
});
