const F = require("../rankings/format.js");

// A small board with the positions interleaved the way a real one is, so a
// positional move always has other positions to step over.
function board() {
    return [
        { player_id: "rb1", position: "RB" },
        { player_id: "wr1", position: "WR" },
        { player_id: "rb2", position: "RB" },
        { player_id: "qb1", position: "QB" },
        { player_id: "wr2", position: "WR" },
        { player_id: "rb3", position: "RB" },
        { player_id: "te1", position: "TE" },
        { player_id: "qb2", position: "QB" },
        { player_id: "wr3", position: "WR" },
        { player_id: "qb3", position: "QB" },
    ];
}

const ids = (entries) => entries.map((e) => e.player_id);

describe("denseRanks / positionRanks", () => {
    test("overall ranks are gapless", () => {
        expect(F.denseRanks(board())).toMatchObject({ rb1: 1, wr1: 2, qb3: 10 });
    });

    test("positional labels derive from the overall array alone", () => {
        const labels = F.positionRanks(board());
        expect(labels.rb1).toBe("RB1");
        expect(labels.rb3).toBe("RB3");
        expect(labels.qb3).toBe("QB3");
        expect(labels.te1).toBe("TE1");
    });

    test("an empty board yields no ranks", () => {
        expect(F.denseRanks([])).toEqual({});
        expect(F.positionRanks(undefined)).toEqual({});
    });
});

describe("scopeEntries", () => {
    test("a positional list is the overall list filtered", () => {
        expect(ids(F.scopeEntries(board(), "RB"))).toEqual(["rb1", "rb2", "rb3"]);
    });

    test("OVERALL returns a copy, not the original array", () => {
        const entries = board();
        expect(F.scopeEntries(entries, "OVERALL")).not.toBe(entries);
    });
});

describe("moveWithin", () => {
    const order = ["a", "b", "c", "d", "e"];

    test("moves up", () => {
        expect(F.moveWithin(order, "d", 1)).toEqual(["a", "d", "b", "c", "e"]);
    });

    test("moves down", () => {
        expect(F.moveWithin(order, "b", 3)).toEqual(["a", "c", "d", "b", "e"]);
    });

    test("moves to the top and to the end", () => {
        expect(F.moveWithin(order, "e", 0)).toEqual(["e", "a", "b", "c", "d"]);
        expect(F.moveWithin(order, "a", 4)).toEqual(["b", "c", "d", "e", "a"]);
    });

    test("a no-op move leaves the order alone", () => {
        expect(F.moveWithin(order, "c", 2)).toEqual(order);
    });

    test("out-of-range targets clamp instead of dropping the player", () => {
        expect(F.moveWithin(order, "a", 99)).toEqual(["b", "c", "d", "e", "a"]);
        expect(F.moveWithin(order, "e", -5)).toEqual(["e", "a", "b", "c", "d"]);
    });

    test("an unknown id is ignored", () => {
        expect(F.moveWithin(order, "zz", 0)).toEqual(order);
    });

    test("does not mutate its input", () => {
        const input = order.slice();
        F.moveWithin(input, "a", 4);
        expect(input).toEqual(order);
    });
});

describe("projectOverallMove", () => {
    test("moving to the top of a position lands above the current leader", () => {
        // RB3 sits at overall index 5; RB1 at 0. Becoming RB1 means index 0.
        expect(F.projectOverallMove(board(), "rb3", "RB", 0)).toBe(0);
    });

    test("moving down within a position steps over the other positions", () => {
        // QB1 becoming QB3 lands immediately below qb3, who sits last among
        // the remaining nine — so the slot just past him, index 9.
        expect(F.projectOverallMove(board(), "qb1", "QB", 2)).toBe(9);
    });

    test("landing mid-position lands above the player holding that slot", () => {
        // WR3 becoming WR2 lands immediately above the current WR2.
        const target = F.projectOverallMove(board(), "wr3", "WR", 1);
        const remaining = ids(board()).filter((id) => id !== "wr3");
        expect(remaining[target]).toBe("wr2");
    });

    test("a no-op keeps him in the same relative place", () => {
        const target = F.projectOverallMove(board(), "rb2", "RB", 1);
        const remaining = ids(board()).filter((id) => id !== "rb2");
        expect(remaining[target]).toBe("rb3");
    });

    test("the only player at his position can go anywhere", () => {
        expect(F.projectOverallMove(board(), "te1", "TE", 0)).toBe(9);
    });

    test("the projection always preserves the invariant", () => {
        // Apply every positional move to the overall array and confirm the two
        // orders still agree. This is the jest side of the pytest sweep.
        const entries = board();
        const positions = Object.fromEntries(entries.map((e) => [e.player_id, e.position]));
        entries.forEach((entry) => {
            const scoped = F.scopeEntries(entries, entry.position);
            scoped.forEach((_, targetIndex) => {
                const target = F.projectOverallMove(entries, entry.player_id, entry.position, targetIndex);
                const moved = F.moveWithin(ids(entries), entry.player_id, target);
                const rebuilt = moved.map((id) => ({ player_id: id, position: positions[id] }));
                const scopedAfter = ids(F.scopeEntries(rebuilt, entry.position));
                expect(scopedAfter.indexOf(entry.player_id)).toBe(targetIndex);
            });
        });
    });
});

describe("midpointKey", () => {
    test("splits a normal gap", () => {
        expect(F.midpointKey(1000, 2000)).toBe(1500);
    });

    test("extends past the ends of the board", () => {
        expect(F.midpointKey(null, 1000)).toBe(0);
        expect(F.midpointKey(5000, null)).toBe(6000);
        expect(F.midpointKey(null, null)).toBe(F.KEY_STEP);
    });

    test("returns null once the gap is used up", () => {
        expect(F.midpointKey(1000, 1000 + 1e-9)).toBeNull();
        expect(F.midpointKey(1000, 1000)).toBeNull();
    });

    test("survives ~30 successive insertions into one gap before giving up", () => {
        let low = 1000;
        const high = 2000;
        let steps = 0;
        for (; steps < 200; steps += 1) {
            const key = F.midpointKey(low, high);
            if (key === null) break;
            low = key;
        }
        // A 1000-wide gap halving down to MIN_GAP (1e-6) is log2(1e9) ≈ 30
        // insertions. Past that the server respreads the whole board.
        expect(steps).toBe(30);
    });
});

describe("tierBands", () => {
    const entries = board();

    test("players above the first divider form a leading untiered band", () => {
        const bands = F.tierBands(entries, [{ id: 1, scope: "OVERALL", label: "Two", beforePlayerId: "rb2" }], "OVERALL");
        expect(bands[0].tier).toBeNull();
        expect(ids(bands[0].players)).toEqual(["rb1", "wr1"]);
        expect(bands[1].tier.label).toBe("Two");
        expect(ids(bands[1].players)).toHaveLength(8);
    });

    test("a board with no divider is one untiered band", () => {
        const bands = F.tierBands(entries, [], "OVERALL");
        expect(bands).toHaveLength(1);
        expect(bands[0].tier).toBeNull();
    });

    test("a divider on the first player has no leading band", () => {
        const bands = F.tierBands(entries, [{ id: 1, scope: "OVERALL", label: "Elite", beforePlayerId: "rb1" }], "OVERALL");
        expect(bands).toHaveLength(1);
        expect(bands[0].tier.label).toBe("Elite");
    });

    test("two dividers on the same player leave an empty tier", () => {
        const tiers = [
            { id: 1, scope: "OVERALL", label: "A", beforePlayerId: "rb2" },
            { id: 2, scope: "OVERALL", label: "B", beforePlayerId: "rb2" },
        ];
        const bands = F.tierBands(entries, tiers, "OVERALL");
        expect(bands.map((b) => (b.tier ? b.tier.label : null))).toEqual([null, "A", "B"]);
        expect(bands[1].players).toEqual([]);
    });

    test("a divider past the last player still renders", () => {
        const bands = F.tierBands(entries, [{ id: 1, scope: "OVERALL", label: "Deep", beforePlayerId: null }], "OVERALL");
        expect(bands[bands.length - 1].tier.label).toBe("Deep");
        expect(bands[bands.length - 1].players).toEqual([]);
    });

    test("dividers from another scope are filtered out", () => {
        const tiers = [
            { id: 1, scope: "QB", label: "QB tier", beforePlayerId: "qb2" },
            { id: 2, scope: "RB", label: "RB tier", beforePlayerId: "rb2" },
        ];
        const rbBands = F.tierBands(entries, tiers, "RB");
        expect(rbBands.map((b) => (b.tier ? b.tier.label : null))).toEqual([null, "RB tier"]);
        expect(ids(rbBands[1].players)).toEqual(["rb2", "rb3"]);
    });
});

describe("planCombinedPlayerMove", () => {
    const entries = [
        { player_id: "a", position: "RB" },
        { player_id: "b", position: "RB" },
        { player_id: "c", position: "RB" },
    ];
    const tiers = [
        { id: 7, scope: "OVERALL", label: "Starters", beforePlayerId: "b" },
    ];

    test("can cross a divider without passing another player", () => {
        const above = F.planCombinedPlayerMove(entries, tiers, "OVERALL", "c", 1);
        expect(above.playerIndex).toBe(1);
        expect(above.placement).toEqual({ before_tier_id: 7 });
        expect(above.tierAnchors).toEqual({ 7: "b" });

        const below = F.planCombinedPlayerMove(entries, tiers, "OVERALL", "c", 2);
        expect(below.playerIndex).toBe(1);
        expect(below.placement).toEqual({ after_tier_id: 7 });
        expect(below.tierAnchors).toEqual({ 7: "c" });
    });

    test("uses a dense rank when no divider is adjacent", () => {
        const plan = F.planCombinedPlayerMove(entries, tiers, "OVERALL", "a", 3);
        expect(plan.playerIndex).toBe(2);
        expect(plan.placement).toEqual({ to_rank: 3 });
    });

    test("recognizes no-op and unknown-player drops", () => {
        expect(F.planCombinedPlayerMove(entries, tiers, "OVERALL", "a", 0).unchanged).toBe(true);
        expect(F.planCombinedPlayerMove(entries, tiers, "OVERALL", "missing", 0)).toBeNull();
    });

    test("plans only against tiers visible in the selected scope", () => {
        const scopedTiers = tiers.concat([
            { id: 9, scope: "QB", label: "QB tier", beforePlayerId: null },
        ]);
        const plan = F.planCombinedPlayerMove(entries, scopedTiers, "OVERALL", "c", 2);
        expect(plan.tierAnchors).toEqual({ 7: "c" });
    });
});

describe("labels", () => {
    test("format label pairs scoring and roster", () => {
        expect(F.formatLabel("ppr", "superflex")).toBe("PPR · Superflex");
        expect(F.formatLabel("half", "1qb")).toBe("Half PPR · 1QB");
    });

    test("board label leads with the season", () => {
        expect(F.boardLabel({ season: 2026, scoring: "std", roster: "1qb" })).toBe(
            "2026 · Standard · 1QB"
        );
    });

    test("describeMove names both ranks and the new positional slot", () => {
        expect(F.describeMove("Josh Allen", 12, 3, "QB1")).toBe(
            "Josh Allen moved up from 12 to 3. Now QB1."
        );
        expect(F.describeMove("Bijan", 1, 4, "RB4")).toContain("moved down from 1 to 4");
        expect(F.describeMove("Bijan", 5, 5, "RB5")).toBe("Bijan stayed at 5.");
    });

    test("consensus spread collapses when every board agrees", () => {
        expect(F.consensusSpread({ best: 3, worst: 11 })).toBe("3–11");
        expect(F.consensusSpread({ best: 4, worst: 4 })).toBe("4");
        expect(F.consensusSpread(null)).toBe("—");
    });

    test("saved-at rounds to the nearest human unit", () => {
        const now = new Date("2026-08-17T12:00:00Z");
        expect(F.formatSavedAt(new Date("2026-08-17T11:59:58Z"), now)).toBe("Saved just now");
        expect(F.formatSavedAt(new Date("2026-08-17T11:59:30Z"), now)).toBe("Saved 30s ago");
        expect(F.formatSavedAt(new Date("2026-08-17T11:58:00Z"), now)).toBe("Saved 2m ago");
        expect(F.formatSavedAt(null, now)).toBe("");
    });

    test("seed delta is positive when you rank him higher than the seed did", () => {
        expect(F.seedDelta({ seedOverallRank: 20, overallRank: 6 })).toBe(14);
        expect(F.formatSigned(14)).toBe("+14");
        expect(F.formatSigned(-3)).toBe("-3");
        expect(F.formatSigned(0)).toBe("—");
        expect(F.seedDelta({ overallRank: 6 })).toBeNull();
    });
});

describe("permutation invariant", () => {
    test("500 random moves never lose or duplicate a player", () => {
        // A tiny seeded PRNG so a failure is reproducible.
        let seed = 987654321;
        const next = (n) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };

        const original = ids(board());
        let order = original.slice();
        for (let i = 0; i < 500; i += 1) {
            order = F.moveWithin(order, original[next(original.length)], next(original.length));
            expect(order).toHaveLength(original.length);
            expect(new Set(order).size).toBe(original.length);
        }
        expect(order.slice().sort()).toEqual(original.slice().sort());
    });
});
