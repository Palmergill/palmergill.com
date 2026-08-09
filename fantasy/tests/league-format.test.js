const LeagueFormat = require("../league/format.js");

describe("records and rates", () => {
    test("recordLabel omits ties when there are none", () => {
        expect(LeagueFormat.recordLabel(6, 8, 0)).toBe("6-8");
        expect(LeagueFormat.recordLabel(6, 7, 1)).toBe("6-7-1");
    });

    test("winPct counts a tie as half a win", () => {
        expect(LeagueFormat.winPct(6, 7, 1)).toBeCloseTo(0.4642, 3);
        expect(LeagueFormat.winPct(10, 4, 0)).toBeCloseTo(0.7142, 3);
    });

    test("winPct returns null with no games rather than dividing by zero", () => {
        expect(LeagueFormat.winPct(0, 0, 0)).toBeNull();
    });

    test("formatPct drops the leading zero like a stat sheet", () => {
        expect(LeagueFormat.formatPct(0.4642)).toBe(".464");
        expect(LeagueFormat.formatPct(null)).toBe("—");
    });

    test("pointsPerGame guards against NaN and Infinity", () => {
        expect(LeagueFormat.pointsPerGame(0, 0)).toBeNull();
        expect(LeagueFormat.pointsPerGame(1500, 0)).toBeNull();
        expect(LeagueFormat.pointsPerGame(1400, 14)).toBeCloseTo(100);
    });

    test("streakLabel compresses type and length", () => {
        expect(LeagueFormat.streakLabel(3, "WIN")).toBe("W3");
        expect(LeagueFormat.streakLabel(1, "LOSS")).toBe("L1");
        expect(LeagueFormat.streakLabel(0, "NONE")).toBe("—");
        expect(LeagueFormat.streakLabel(null, null)).toBe("—");
    });
});

describe("rank movement", () => {
    test("renders four distinct states", () => {
        expect(LeagueFormat.rankMovement(2).direction).toBe("up");
        expect(LeagueFormat.rankMovement(-2).direction).toBe("down");
        expect(LeagueFormat.rankMovement(0).direction).toBe("flat");
        // No previous week to compare against is not the same as "no change".
        expect(LeagueFormat.rankMovement(null).direction).toBe("none");
        expect(LeagueFormat.rankMovement(undefined).direction).toBe("none");
    });

    test("labels show magnitude without a sign character", () => {
        expect(LeagueFormat.rankMovement(3).label).toBe("▲ 3");
        expect(LeagueFormat.rankMovement(-3).label).toBe("▼ 3");
    });
});

describe("roster ordering", () => {
    // Deliberately shuffled, and shaped like the real 2026 lineup:
    // QB, 2xRB, 2xWR, TE, 2xFLEX, DST, K, then bench and IR.
    const entries = [
        { name: "Bench WR", lineup_slot: "BENCH" },
        { name: "Kicker", lineup_slot: "K" },
        { name: "Flex B", lineup_slot: "FLEX" },
        { name: "Hurt Guy", lineup_slot: "IR" },
        { name: "RB B", lineup_slot: "RB" },
        { name: "Defense", lineup_slot: "DST" },
        { name: "WR A", lineup_slot: "WR" },
        { name: "Quarterback", lineup_slot: "QB" },
        { name: "Flex A", lineup_slot: "FLEX" },
        { name: "TE", lineup_slot: "TE" },
        { name: "RB A", lineup_slot: "RB" },
        { name: "WR B", lineup_slot: "WR" },
        { name: "Bench RB", lineup_slot: "BENCH" },
    ];

    test("sortRoster puts starters in lineup order, bench and IR last", () => {
        const slots = LeagueFormat.sortRoster(entries).map((e) => e.lineup_slot);
        expect(slots).toEqual([
            "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "DST", "K",
            "BENCH", "BENCH", "IR",
        ]);
    });

    test("splitRoster separates the three groups", () => {
        const { starters, bench, ir } = LeagueFormat.splitRoster(entries);
        expect(starters).toHaveLength(10);
        expect(bench).toHaveLength(2);
        expect(ir).toHaveLength(1);
        expect(ir[0].name).toBe("Hurt Guy");
    });

    test("an unknown slot sorts between starters and the bench", () => {
        const withUnknown = LeagueFormat.sortRoster([
            { name: "Mystery", lineup_slot: "TQB" },
            { name: "Bench", lineup_slot: "BENCH" },
            { name: "QB", lineup_slot: "QB" },
        ]);
        expect(withUnknown.map((e) => e.name)).toEqual(["QB", "Mystery", "Bench"]);
    });

    test("isStarter treats bench and IR as non-starters", () => {
        expect(LeagueFormat.isStarter({ lineup_slot: "FLEX" })).toBe(true);
        expect(LeagueFormat.isStarter({ lineup_slot: "BENCH" })).toBe(false);
        expect(LeagueFormat.isStarter({ lineup_slot: "IR" })).toBe(false);
    });

    test("handles an empty roster", () => {
        expect(LeagueFormat.sortRoster([])).toEqual([]);
        expect(LeagueFormat.splitRoster(undefined).starters).toEqual([]);
    });
});

describe("divisions", () => {
    const divisions = [{ id: 0, name: "East" }, { id: 1, name: "West" }];

    test("groups teams and keeps division names", () => {
        const groups = LeagueFormat.groupByDivision(
            [
                { name: "A", division_id: 1, division_name: "West" },
                { name: "B", division_id: 0, division_name: "East" },
                { name: "C", division_id: 1, division_name: "West" },
            ],
            divisions
        );
        expect(groups).toHaveLength(2);
        expect(groups[0].division_name).toBe("West");
        expect(groups[0].teams).toHaveLength(2);
    });

    test("falls back to the settings name, then a generic label", () => {
        const groups = LeagueFormat.groupByDivision(
            [{ name: "A", division_id: 1 }, { name: "B", division_id: 7 }],
            divisions
        );
        expect(groups[0].division_name).toBe("West");
        expect(groups[1].division_name).toBe("Division");
    });

    test("teams with no division still group", () => {
        const groups = LeagueFormat.groupByDivision([{ name: "A" }], []);
        expect(groups).toHaveLength(1);
        expect(groups[0].teams).toHaveLength(1);
    });
});

describe("matchupResult", () => {
    const game = {
        is_complete: true,
        is_bye: false,
        winner: "HOME",
        home: { espn_team_id: 1, points: 110 },
        away: { espn_team_id: 2, points: 90 },
    };

    test("reads the result from the home side", () => {
        const result = LeagueFormat.matchupResult(game, 1);
        expect(result.outcome).toBe("W");
        expect(result.points).toBe(110);
        expect(result.margin).toBe(20);
    });

    test("reads the same game from the away side", () => {
        const result = LeagueFormat.matchupResult(game, 2);
        expect(result.outcome).toBe("L");
        expect(result.margin).toBe(-20);
    });

    test("a tie is neither a win nor a loss", () => {
        const tied = { ...game, winner: "TIE", away: { espn_team_id: 2, points: 110 } };
        expect(LeagueFormat.matchupResult(tied, 1).outcome).toBe("T");
    });

    test("an undecided game has no outcome yet", () => {
        const pending = { ...game, is_complete: false, winner: "UNDECIDED" };
        expect(LeagueFormat.matchupResult(pending, 1).outcome).toBeNull();
    });

    test("a bye is its own state with no opponent", () => {
        const bye = {
            is_complete: false,
            is_bye: true,
            winner: "UNDECIDED",
            home: { espn_team_id: 1, points: 0 },
            away: null,
        };
        const result = LeagueFormat.matchupResult(bye, 1);
        expect(result.outcome).toBe("BYE");
        expect(result.opponent).toBeNull();
    });
});

describe("labels and chrome", () => {
    test("seasonLabel marks a private season", () => {
        expect(LeagueFormat.seasonLabel(2025, "unauthorized")).toBe("2025 · private");
        expect(LeagueFormat.seasonLabel(2024, "ok")).toBe("2024");
    });

    test("modeLabel names the two season states", () => {
        expect(LeagueFormat.modeLabel("preseason")).toBe("Preseason");
        expect(LeagueFormat.modeLabel("live")).toBe("In season");
        expect(LeagueFormat.modeLabel("empty")).toBe("");
    });

    test("algorithmLabel falls back to the raw key", () => {
        expect(LeagueFormat.algorithmLabel("points_differential")).toBe("Point diff");
        expect(LeagueFormat.algorithmLabel("unknown_thing")).toBe("unknown_thing");
    });

    test("powerBar clamps to the track", () => {
        expect(LeagueFormat.powerBar(0.5)).toBe(50);
        expect(LeagueFormat.powerBar(1.4)).toBe(100);
        expect(LeagueFormat.powerBar(-1)).toBe(0);
        expect(LeagueFormat.powerBar(null)).toBe(0);
    });

    test("injuryBadge stays quiet for healthy players", () => {
        expect(LeagueFormat.injuryBadge("ACTIVE")).toBe("");
        expect(LeagueFormat.injuryBadge(null)).toBe("");
        expect(LeagueFormat.injuryBadge("QUESTIONABLE")).toBe("Q");
        expect(LeagueFormat.injuryBadge("OUT")).toBe("O");
    });

    test("formatSigned keeps the direction visible", () => {
        expect(LeagueFormat.formatSigned(12.34)).toBe("+12.3");
        expect(LeagueFormat.formatSigned(-12.34)).toBe("-12.3");
        expect(LeagueFormat.formatSigned(null)).toBe("—");
    });
});

describe("sparkline", () => {
    test("needs at least two points to draw", () => {
        expect(LeagueFormat.sparkline([], 80, 24)).toBe("");
        expect(LeagueFormat.sparkline([3], 80, 24)).toBe("");
    });

    test("inverts ranks so improving reads as going up", () => {
        // Rank 1 is best, so it should sit at the TOP (smallest y).
        const path = LeagueFormat.sparkline([4, 1], 80, 24, 2);
        const ys = path.match(/,([\d.]+)/g).map((m) => parseFloat(m.slice(1)));
        expect(ys[1]).toBeLessThan(ys[0]);
    });

    test("a flat line does not divide by zero", () => {
        const path = LeagueFormat.sparkline([5, 5, 5], 80, 24, 2);
        expect(path).toContain("M");
        expect(path).not.toContain("NaN");
    });
});
