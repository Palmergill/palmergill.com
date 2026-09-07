/**
 * Draft recap formatting.
 *
 * The page's judgements — reach or value, which grade colour, which ADP board
 * the numbers came from — all live in format.js, so they are tested here
 * rather than through the DOM.
 */
const F = require("../league/draft/format.js");

describe("reach and value", () => {
    test("a pick taken before ADP reads as a reach", () => {
        expect(F.pickVerdict({ adp_ranked: true, adp_sigma: -2.4 })).toBe("reach");
    });

    test("a pick that lasted past ADP reads as value", () => {
        expect(F.pickVerdict({ adp_ranked: true, adp_sigma: 1.9 })).toBe("value");
    });

    test("a pick near ADP is chalk, not a verdict either way", () => {
        expect(F.pickVerdict({ adp_ranked: true, adp_sigma: 0.4 })).toBe("chalk");
    });

    test("a player the ADP board never listed gets no verdict at all", () => {
        // Padding an unlisted player is fine for a team total, but it is not
        // evidence about one selection, so the table must not label it.
        expect(F.pickVerdict({ adp_ranked: false, adp_sigma: -9 })).toBeNull();
        expect(F.pickVerdict(null)).toBeNull();
    });
});

describe("number formatting", () => {
    test("sigma always carries its sign so direction is unmistakable", () => {
        expect(F.formatSigma(1.234)).toBe("+1.23σ");
        expect(F.formatSigma(-1.234)).toBe("-1.23σ");
    });

    test("a delta of essentially nothing says so rather than showing +0.0", () => {
        expect(F.formatDelta(0.01)).toBe("even");
        expect(F.formatDelta(-0.02)).toBe("even");
    });

    test("missing values render as a dash, never as zero", () => {
        expect(F.formatSigma(null)).toBe("—");
        expect(F.formatDelta(null)).toBe("—");
        expect(F.formatPoints(null)).toBe("—");
        expect(F.formatAdp(null)).toBe("—");
    });

    test("a round and pick render as the board position managers use", () => {
        expect(F.roundLabel({ round: 3, round_pick: 4, overall_pick: 24 })).toBe("3.04");
        expect(F.roundLabel({ round: 12, round_pick: 10, overall_pick: 120 })).toBe("12.10");
    });
});

describe("grade presentation", () => {
    test("every letter maps onto a colour tier", () => {
        expect(F.gradeTier("A+")).toBe("great");
        expect(F.gradeTier("B-")).toBe("good");
        expect(F.gradeTier("C")).toBe("fair");
        expect(F.gradeTier("F")).toBe("poor");
    });

    test("a missing grade falls back rather than throwing", () => {
        expect(F.gradeTier(null)).toBe("fair");
    });

    test("the component bar puts league average at the midpoint", () => {
        expect(F.componentBarWidth(0)).toBe(50);
        expect(F.componentBarWidth(3)).toBe(100);
        expect(F.componentBarWidth(-3)).toBe(0);
    });

    test("an extreme z-score is clamped so it cannot flatten the other bars", () => {
        expect(F.componentBarWidth(12)).toBe(100);
        expect(F.componentBarWidth(-12)).toBe(0);
        expect(F.componentBarWidth(undefined)).toBe(50);
    });

    test("every weighted component has a label and a plain-English blurb", () => {
        ["adp_value", "starters", "bench", "construction"].forEach((key) => {
            expect(F.componentLabel(key)).not.toBe(key);
            expect(F.componentBlurb(key).length).toBeGreaterThan(0);
        });
    });
});

describe("the ADP board describes itself", () => {
    const source = {
        format: "2qb",
        teams: 10,
        total_drafts: 7208,
        start_date: "2026-08-06",
        end_date: "2026-09-05",
        captured_before_draft: true,
    };

    test("it names the sample the grades were measured against", () => {
        const note = F.adpSourceNote(source);
        expect(note).toContain("2QB");
        expect(note).toContain("7,208 drafts");
        expect(note).toContain("2026-08-06 to 2026-09-05");
        expect(note).toContain("10-team");
    });

    test("a board collected after the draft admits it", () => {
        const note = F.adpSourceNote({ ...source, captured_before_draft: false });
        expect(note).toContain("Collected after the draft");
    });

    test("no board at all is stated rather than implied", () => {
        expect(F.adpSourceNote(null)).toContain("No ADP board");
    });
});

describe("sorting the board", () => {
    const picks = [
        { overall_pick: 1, adp: 5, adp_sigma: 2, player: { name: "Beta", position: "RB" }, points: { best: 100 } },
        { overall_pick: 2, adp: 1, adp_sigma: -3, player: { name: "Alpha", position: "QB" }, points: { best: 300 } },
        { overall_pick: 3, adp: null, adp_sigma: null, player: { name: "Gamma", position: "WR" }, points: { best: null } },
    ];

    test("it defaults to board order", () => {
        expect(F.sortPicks(picks, "pick", "asc").map((p) => p.overall_pick)).toEqual([1, 2, 3]);
    });

    test("sorting by reach puts the biggest steal first", () => {
        expect(F.sortPicks(picks, "sigma", "desc")[0].overall_pick).toBe(1);
    });

    test("picks with no value sink rather than sorting as zero", () => {
        // A missing projection is not a projection of nothing; it must not
        // outrank a real one.
        const sorted = F.sortPicks(picks, "points", "desc");
        expect(sorted[sorted.length - 1].overall_pick).toBe(3);
    });

    test("unlisted ADP sorts to the end, not to the front", () => {
        const sorted = F.sortPicks(picks, "adp", "asc");
        expect(sorted[sorted.length - 1].overall_pick).toBe(3);
    });

    test("sorting by name is alphabetical and stable", () => {
        expect(F.sortPicks(picks, "player", "asc").map((p) => p.player.name)).toEqual([
            "Alpha",
            "Beta",
            "Gamma",
        ]);
    });

    test("sorting never mutates the list it was given", () => {
        const before = picks.map((p) => p.overall_pick);
        F.sortPicks(picks, "sigma", "desc");
        expect(picks.map((p) => p.overall_pick)).toEqual(before);
    });
});

describe("attributing awards to teams", () => {
    const accolades = [
        { key: "rookie_fever", label: "Rookie fever", winner: { espn_team_id: 1 } },
        { key: "homer", label: "Homer award", winner: { espn_team_id: 2 } },
        { key: "autopick", label: "Asleep at the wheel", winner: { espn_team_id: 1 } },
    ];

    test("a grade card can find its own trophies", () => {
        expect(F.awardsForTeam(accolades, 1).map((a) => a.key)).toEqual([
            "rookie_fever",
            "autopick",
        ]);
    });

    test("a team that won nothing gets an empty list, not undefined", () => {
        expect(F.awardsForTeam(accolades, 9)).toEqual([]);
        expect(F.awardsForTeam(null, 1)).toEqual([]);
    });

    test("picks can be narrowed to one team", () => {
        const picks = [
            { overall_pick: 1, espn_team_id: 1 },
            { overall_pick: 2, espn_team_id: 2 },
        ];
        expect(F.teamPicks(picks, 2).map((p) => p.overall_pick)).toEqual([2]);
    });
});

describe("draft status", () => {
    test("each state has wording a reader can act on", () => {
        expect(F.statusLabel("not_drafted")).toBe("Not drafted yet");
        expect(F.statusLabel("in_progress")).toBe("Draft in progress");
        expect(F.statusLabel("complete")).toBe("Draft complete");
    });

    test("an unknown state does not render as undefined", () => {
        expect(F.statusLabel("something-else")).toBe("Draft status unknown");
        expect(F.statusLabel(undefined)).toBe("Draft status unknown");
    });
});
