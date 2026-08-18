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
