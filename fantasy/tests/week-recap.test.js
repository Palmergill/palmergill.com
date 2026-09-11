/**
 * Weekly recap formatting.
 *
 * The page's judgements — how a result reads, which grade colour, what to say
 * when a lineup could not be scored — all live in format.js, so they are
 * tested here rather than through the DOM.
 */
const F = require("../league/week/format.js");

describe("results", () => {
    test("a result names the verb, both scores and the opponent", () => {
        expect(
            F.resultLine({
                result: "win",
                points: 130,
                opponent: { name: "Team 2", points: 90 },
            })
        ).toBe("Won 130.0–90.0 vs Team 2");
    });

    test("a loss reads as a loss rather than a negative margin", () => {
        expect(
            F.resultLine({
                result: "loss",
                points: 90,
                opponent: { name: "Team 1", points: 130 },
            })
        ).toBe("Lost 90.0–130.0 vs Team 1");
    });

    test("a bye has no opponent to name and does not invent one", () => {
        expect(F.resultLine({ result: "bye", points: 101 })).toBe("Bye");
        expect(F.resultLine({ result: "win", points: 101, opponent: null })).toBe("Won");
        expect(F.resultLine(null)).toBe("");
    });

    test("an all-play record reads as a record, ties only when there are some", () => {
        expect(F.formatAllPlay({ wins: 7, losses: 2, ties: 0 })).toBe("7–2");
        expect(F.formatAllPlay({ wins: 6, losses: 2, ties: 1 })).toBe("6–2–1");
        expect(F.formatAllPlay(null)).toBe("—");
    });
});

describe("number formatting", () => {
    test("points always carry one decimal, the way a scoreboard does", () => {
        expect(F.formatPoints(130)).toBe("130.0");
        expect(F.formatPoints(99.56)).toBe("99.6");
    });

    test("a delta of essentially nothing says so rather than showing +0.0", () => {
        expect(F.formatSigned(0.01)).toBe("even");
        expect(F.formatSigned(12.3)).toBe("+12.3");
        expect(F.formatSigned(-12.3)).toBe("-12.3");
    });

    test("missing values render as a dash, never as zero", () => {
        expect(F.formatPoints(null)).toBe("—");
        expect(F.formatSigned(null)).toBe("—");
        expect(F.formatPercent(null)).toBe("—");
        expect(F.weekLabel(null)).toBe("—");
    });

    test("efficiency is a whole percent, because tenths are not decidable", () => {
        expect(F.formatPercent(0.8642)).toBe("86%");
        expect(F.formatPercent(1)).toBe("100%");
    });
});

describe("grade presentation", () => {
    test("every letter maps onto a colour tier", () => {
        expect(F.gradeTier("A+")).toBe("great");
        expect(F.gradeTier("B-")).toBe("good");
        expect(F.gradeTier("C")).toBe("fair");
        expect(F.gradeTier("F")).toBe("poor");
        expect(F.gradeTier(null)).toBe("fair");
    });

    test("a component bar is centred on league average, not on zero", () => {
        expect(F.componentBarWidth(0)).toBe(50);
        expect(F.componentBarWidth(3)).toBe(100);
        expect(F.componentBarWidth(-3)).toBe(0);
    });

    test("an extreme z-score is clamped so one outlier cannot flatten the rest", () => {
        expect(F.componentBarWidth(40)).toBe(100);
        expect(F.componentBarWidth(-40)).toBe(0);
    });

    test("every component the API grades on has a label and a blurb", () => {
        Object.keys(F.COMPONENT_LABELS).forEach((key) => {
            expect(F.componentLabel(key)).not.toBe(key);
            expect(F.componentBlurb(key).length).toBeGreaterThan(10);
        });
    });
});

describe("power movement", () => {
    test("movement is an arrow, and standing still is not an arrow", () => {
        expect(F.movementLabel({ rank: 2, rank_delta: 3 })).toBe("Power 2 ▲3");
        expect(F.movementLabel({ rank: 5, rank_delta: -1 })).toBe("Power 5 ▼1");
        expect(F.movementLabel({ rank: 5, rank_delta: 0 })).toBe("Power 5");
        expect(F.movementLabel(null)).toBe("");
    });
});

describe("what the page says when it cannot say anything", () => {
    test("each reason the lineup could not be scored has its own sentence", () => {
        Object.keys(F.LINEUP_REASONS).forEach((reason) => {
            expect(F.lineupNote({ available: false, reason })).toBe(
                F.LINEUP_REASONS[reason]
            );
        });
    });

    test("a scored week discloses the seats it had to leave out", () => {
        expect(
            F.lineupNote({ available: true, excluded_slots: ["DST"] })
        ).toContain("DST");
        expect(F.lineupNote({ available: true, excluded_slots: [] })).toContain(
            "actually scored"
        );
    });

    test("an unrecognised reason produces silence, not a reason code", () => {
        expect(F.lineupNote({ available: false, reason: "something_new" })).toBe("");
        expect(F.lineupNote(null)).toBe("");
    });
});

describe("sorting the team table", () => {
    const rows = [
        {
            team: "Bravo",
            composite: 0.2,
            points: 100,
            efficiency: 0.9,
            points_left: 10,
            all_play: { pct: 0.5 },
        },
        {
            team: "Alpha",
            composite: 1.1,
            points: 130,
            efficiency: 1,
            points_left: 0,
            all_play: { pct: 1 },
        },
        {
            team: "Charlie",
            composite: -1,
            points: 90,
            efficiency: null,
            points_left: null,
            all_play: { pct: 0 },
        },
    ];

    test("the default order is the grade itself, best first", () => {
        expect(F.sortTeams(rows, "grade", "desc").map((row) => row.team)).toEqual([
            "Alpha",
            "Bravo",
            "Charlie",
        ]);
    });

    test("a value column sorts by its number", () => {
        expect(F.sortTeams(rows, "points", "desc")[0].team).toBe("Alpha");
        expect(F.sortTeams(rows, "bench", "desc")[0].team).toBe("Bravo");
    });

    test("a team with nothing to sort on sinks rather than leading", () => {
        // Charlie has no efficiency; an unscored lineup must not be read as
        // the best-managed one just because its cell is empty.
        expect(F.sortTeams(rows, "efficiency", "desc").pop().team).toBe("Charlie");
    });

    test("a name column sorts alphabetically in the direction asked for", () => {
        expect(F.sortTeams(rows, "team", "asc").map((row) => row.team)).toEqual([
            "Alpha",
            "Bravo",
            "Charlie",
        ]);
    });

    test("sorting never mutates the array it was handed", () => {
        const original = rows.map((row) => row.team);
        F.sortTeams(rows, "points", "asc");
        expect(rows.map((row) => row.team)).toEqual(original);
    });
});
