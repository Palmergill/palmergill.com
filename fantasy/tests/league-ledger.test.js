const LeagueFormat = require("../league/format.js");

// A small league whose numbers are chosen so every assertion below can be
// checked by hand.
function row(overrides) {
    return Object.assign(
        {
            espn_team_id: 1,
            name: "Team",
            wins: 3,
            losses: 2,
            ties: 0,
            points_for: 620.5,
            expected_wins: 3.2,
            luck: -0.2,
            all_play: { wins: 29, losses: 16, ties: 0, games: 45, win_pct: 29 / 45 },
            scoring: { low: 100.0, median: 124.0, high: 148.0, mean: 124.1, stdev: 18.2, weeks: 5 },
            playoff: { odds: 0.79, projected_wins: 9.2, projected_losses: 4.8 },
            power: { rank: 3, previous_rank: 4, rank_delta: 1, history: [] },
            lineup: { efficiency: 0.963, points_left: 24.5, weeks: 5 },
        },
        overrides
    );
}

describe("ledger columns", () => {
    test("every column knows how to read, print and draw itself", () => {
        LeagueFormat.LEDGER_COLUMNS.forEach((column) => {
            expect(typeof column.key).toBe("string");
            expect(typeof column.label).toBe("string");
            expect(typeof column.header).toBe("string");
            expect(typeof column.chart).toBe("string");
        });
    });

    test("an unknown column key falls back to the first rather than throwing", () => {
        expect(LeagueFormat.ledgerColumn("vibes")).toBe(LeagueFormat.LEDGER_COLUMNS[0]);
    });

    test("ledgerText prints each measure in its own units", () => {
        const team = row();
        expect(LeagueFormat.ledgerText(team, "record")).toBe("3-2");
        expect(LeagueFormat.ledgerText(team, "all_play")).toBe("29-16");
        expect(LeagueFormat.ledgerText(team, "luck")).toBe("-0.2");
        expect(LeagueFormat.ledgerText(team, "lineup")).toBe("96.3%");
        expect(LeagueFormat.ledgerText(team, "odds")).toBe("79%");
        expect(LeagueFormat.ledgerText(team, "power")).toBe("3");
    });

    test("a positive luck value keeps its sign", () => {
        expect(LeagueFormat.ledgerText(row({ luck: 1.0 }), "luck")).toBe("+1.0");
    });

    test("a measure that could not be computed prints an em dash, not a zero", () => {
        const team = row({
            lineup: { efficiency: null, points_left: null, weeks: 0 },
            playoff: { odds: null, projected_wins: null, projected_losses: null },
            all_play: { wins: 0, losses: 0, ties: 0, games: 0, win_pct: 0 },
        });
        expect(LeagueFormat.ledgerText(team, "lineup")).toBe("—");
        expect(LeagueFormat.ledgerText(team, "odds")).toBe("—");
        expect(LeagueFormat.ledgerText(team, "all_play")).toBe("—");
    });

    test("ledgerMeta gives each column the context its number needs", () => {
        const team = row();
        expect(LeagueFormat.ledgerMeta(team, "luck")).toBe("3-2 · 29-16 all-play");
        expect(LeagueFormat.ledgerMeta(team, "lineup")).toBe("24.5 pts left on the bench");
        expect(LeagueFormat.ledgerMeta(team, "scoring")).toBe("100.0 to 148.0");
        expect(LeagueFormat.ledgerMeta(team, "odds")).toBe("projected 9-5");
    });
});

describe("sorting the ledger", () => {
    const teams = [
        row({ espn_team_id: 1, luck: -0.2, points_for: 620.5, power: { rank: 3 } }),
        row({ espn_team_id: 2, luck: 1.0, points_for: 677.0, power: { rank: 1 } }),
        row({ espn_team_id: 3, luck: 0.4, points_for: 655.2, power: { rank: 2 } }),
    ];

    test("a column sorts best-first whichever direction its raw number runs", () => {
        expect(LeagueFormat.sortLedger(teams, "luck").map((t) => t.espn_team_id)).toEqual([
            2, 3, 1,
        ]);
        // Rank 1 is the best power ranking, so it has to lead too.
        expect(LeagueFormat.sortLedger(teams, "power").map((t) => t.espn_team_id)).toEqual([
            2, 3, 1,
        ]);
    });

    test("teams the measure is unknown for sink instead of leading", () => {
        const withGap = teams.concat([
            row({ espn_team_id: 4, lineup: { efficiency: null, points_left: null, weeks: 0 } }),
        ]);
        const order = LeagueFormat.sortLedger(withGap, "lineup").map((t) => t.espn_team_id);
        expect(order[order.length - 1]).toBe(4);
    });

    test("sorting leaves the caller's array alone", () => {
        const original = teams.map((t) => t.espn_team_id);
        LeagueFormat.sortLedger(teams, "luck");
        expect(teams.map((t) => t.espn_team_id)).toEqual(original);
    });

    test("points for breaks a tie", () => {
        const tied = [
            row({ espn_team_id: 1, luck: 0.5, points_for: 600 }),
            row({ espn_team_id: 2, luck: 0.5, points_for: 700 }),
        ];
        expect(LeagueFormat.sortLedger(tied, "luck").map((t) => t.espn_team_id)).toEqual([2, 1]);
    });
});

describe("chart geometry", () => {
    test("a diverging bar takes its side from the sign, not the colour", () => {
        expect(LeagueFormat.divergingBar(1.0, 1.0)).toEqual({ side: "positive", width: 46 });
        expect(LeagueFormat.divergingBar(-0.5, 1.0)).toEqual({ side: "negative", width: 23 });
    });

    test("a zero value draws nothing at all", () => {
        expect(LeagueFormat.divergingBar(0, 1.0)).toEqual({ side: "zero", width: 0 });
        expect(LeagueFormat.divergingBar(null, 1.0)).toEqual({ side: "zero", width: 0 });
    });

    test("a diverging bar can never overflow its half of the track", () => {
        expect(LeagueFormat.divergingBar(9, 1.0).width).toBe(46);
    });

    test("dotPosition maps a value onto its window", () => {
        expect(LeagueFormat.dotPosition(0.9, 0.8, 1.0)).toBeCloseTo(50);
        expect(LeagueFormat.dotPosition(0.8, 0.8, 1.0)).toBe(0);
        expect(LeagueFormat.dotPosition(1.0, 0.8, 1.0)).toBe(100);
    });

    test("dotPosition clamps rather than drawing outside the track", () => {
        expect(LeagueFormat.dotPosition(1.4, 0.8, 1.0)).toBe(100);
        expect(LeagueFormat.dotPosition(0.1, 0.8, 1.0)).toBe(0);
    });

    test("dotPosition reports nothing for a value it cannot place", () => {
        expect(LeagueFormat.dotPosition(null, 0.8, 1.0)).toBeNull();
        expect(LeagueFormat.dotPosition(0.9, null, 1.0)).toBeNull();
    });

    test("a zero-width window centres rather than dividing by zero", () => {
        expect(LeagueFormat.dotPosition(5, 5, 5)).toBe(50);
    });

    test("rangeBand spans low to high inside the window", () => {
        expect(LeagueFormat.rangeBand(100, 150, 75, 175)).toEqual({ left: 25, width: 50 });
    });

    test("rangeBand survives a low and high given the wrong way round", () => {
        expect(LeagueFormat.rangeBand(150, 100, 75, 175)).toEqual({ left: 25, width: 50 });
    });

    test("niceAxis rounds outward to a readable step", () => {
        // 0.823 and 0.963 padded by 12% of their range, then rounded out to
        // the nearest 0.02 in each direction.
        const axis = LeagueFormat.niceAxis([0.823, 0.963], 0.02);
        expect(axis.min).toBeCloseTo(0.8, 6);
        expect(axis.max).toBeCloseTo(0.98, 6);
    });

    test("niceAxis never returns a zero-width axis", () => {
        const axis = LeagueFormat.niceAxis([120, 120], 10);
        expect(axis.max).toBeGreaterThan(axis.min);
    });

    test("niceAxis reports nothing when there is nothing to plot", () => {
        expect(LeagueFormat.niceAxis([], 10)).toBeNull();
        expect(LeagueFormat.niceAxis([null, undefined], 10)).toBeNull();
    });

    test("maxAbs finds the widest swing in either direction", () => {
        expect(LeagueFormat.maxAbs([0.4, -1.0, 0.2])).toBe(1);
        expect(LeagueFormat.maxAbs([])).toBe(0);
    });
});
