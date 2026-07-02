const Strategy = require("../strategy.js");

describe("validateIntent", () => {
    test("accepts a well-formed intent", () => {
        const res = Strategy.validateIntent({
            name: "Pass",
            bets: [{ type: "passLine", units: 1, when: "comeOut" }],
            odds: { passLine: "max" },
            progression: { appliesTo: ["passLine"], onWin: "press", onLoss: "none", resetOnSevenOut: true }
        });
        expect(res.valid).toBe(true);
        expect(res.errors).toEqual([]);
    });

    test("rejects unknown bet types", () => {
        const res = Strategy.validateIntent({ bets: [{ type: "superBet", units: 1 }] });
        expect(res.valid).toBe(false);
        expect(res.errors.join(" ")).toMatch(/superBet/);
    });

    test("rejects non-positive units", () => {
        const res = Strategy.validateIntent({ bets: [{ type: "passLine", units: 0 }] });
        expect(res.valid).toBe(false);
    });

    test("rejects bad progression enums", () => {
        const res = Strategy.validateIntent({
            bets: [{ type: "passLine", units: 1 }],
            progression: { onWin: "explode" }
        });
        expect(res.valid).toBe(false);
        expect(res.errors.join(" ")).toMatch(/onWin/);
    });

    test("rejects odds on a non-line bet", () => {
        const res = Strategy.validateIntent({
            bets: [{ type: "place6", units: 1 }],
            odds: { place6: "max" }
        });
        expect(res.valid).toBe(false);
    });

    test("rejects empty bet list", () => {
        expect(Strategy.validateIntent({ bets: [] }).valid).toBe(false);
    });

    test("rejects duplicate bet types", () => {
        const res = Strategy.validateIntent({
            bets: [
                { type: "place6", units: 1 },
                { type: "place6", units: 2 }
            ]
        });
        expect(res.valid).toBe(false);
        expect(res.errors.join(" ")).toMatch(/more than once/);
    });

    test("treats null optional fields as absent (LLM/JSON often emits null)", () => {
        const res = Strategy.validateIntent({
            name: "Come strat",
            bets: [
                { type: "passLine", units: 1, when: "comeOut", everyRoll: null, maxActive: null },
                { type: "come", units: 1, when: "pointOn", maxActive: 2 }
            ],
            odds: { passLine: "max", come: "max" },
            progression: null
        });
        expect(res.valid).toBe(true);
        expect(res.errors).toEqual([]);
    });

    test("accepts one cash-out target and rejects ambiguous targets", () => {
        expect(Strategy.validateIntent({
            bets: [{ type: "passLine", units: 1 }],
            cashOut: { multiplier: 2 }
        }).valid).toBe(true);

        const res = Strategy.validateIntent({
            bets: [{ type: "passLine", units: 1 }],
            cashOut: { amount: 600, multiplier: 2 }
        });
        expect(res.valid).toBe(false);
        expect(res.errors.join(" ")).toMatch(/exactly one/);
    });
});

describe("normalize", () => {
    const intent = {
        name: "Iron Cross",
        bets: [
            { type: "passLine", units: 1, when: "comeOut" },
            { type: "place6", units: 2, when: "pointOn" },
            { type: "place8", units: 2, when: "pointOn" },
            { type: "field", units: 1, when: "pointOn", everyRoll: true }
        ],
        odds: { passLine: "max" }
    };

    test("derives dollar amounts from units * baseUnit, snapped to legal increments", () => {
        const spec = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5 });
        const pass = spec.bets.find((b) => b.type === "passLine");
        const place6 = spec.bets.find((b) => b.type === "place6");
        expect(pass.amount).toBe(5);
        // 2 * 5 = 10 -> nearest $6 multiple = 12
        expect(place6.amount).toBe(12);
    });

    test("per-bet overrides beat the LLM units", () => {
        const spec = Strategy.normalize(intent, {
            buyIn: 300, baseUnit: 5, overrides: { passLine: 25 }
        });
        expect(spec.bets.find((b) => b.type === "passLine").amount).toBe(25);
    });

    test("overrides also snap to legal increments", () => {
        const spec = Strategy.normalize(intent, {
            buyIn: 300, baseUnit: 5, overrides: { place6: 10 }
        });
        // 10 -> nearest $6 multiple = 12
        expect(spec.bets.find((b) => b.type === "place6").amount).toBe(12);
    });

    test("is deterministic: same (intent, form) -> identical spec", () => {
        const a = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5 });
        const b = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5 });
        expect(a).toEqual(b);
        expect(a.baseSeed).toBe(b.baseSeed);
    });

    test("baseSeed changes when money changes", () => {
        const a = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5 });
        const b = Strategy.normalize(intent, { buyIn: 500, baseUnit: 5 });
        expect(a.baseSeed).not.toBe(b.baseSeed);
    });

    test("explicit seed overrides the derived seed", () => {
        const spec = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5, seed: 12345 });
        expect(spec.baseSeed).toBe(12345);
    });

    test("normalizes cash-out amount and multiplier targets", () => {
        const byAmount = Strategy.normalize(
            Object.assign({}, intent, { cashOut: { amount: 750 } }),
            { buyIn: 300, baseUnit: 5 }
        );
        const byMultiplier = Strategy.normalize(
            Object.assign({}, intent, { cashOut: { multiplier: 3 } }),
            { buyIn: 300, baseUnit: 5 }
        );
        expect(byAmount.cashOut).toEqual({ mode: "amount", target: 750, amount: 750, multiplier: undefined });
        expect(byMultiplier.cashOut).toEqual({ mode: "multiplier", target: 900, amount: undefined, multiplier: 3 });
    });

    test("form cash-out overrides intent cash-out and changes the derived seed", () => {
        const cashOutIntent = Object.assign({}, intent, { cashOut: { multiplier: 2 } });
        const a = Strategy.normalize(cashOutIntent, { buyIn: 300, baseUnit: 5 });
        const b = Strategy.normalize(cashOutIntent, {
            buyIn: 300,
            baseUnit: 5,
            cashOut: { mode: "amount", amount: 800 }
        });
        expect(a.cashOut.target).toBe(600);
        expect(b.cashOut.target).toBe(800);
        expect(a.baseSeed).not.toBe(b.baseSeed);
    });

    test("form cash-out mode none clears an intent cash-out", () => {
        const spec = Strategy.normalize(
            Object.assign({}, intent, { cashOut: { multiplier: 2 } }),
            { buyIn: 300, baseUnit: 5, cashOut: { mode: "none" } }
        );
        expect(spec.cashOut).toBeNull();
    });

    test("rejects cash-out targets that do not exceed buy-in", () => {
        expect(() => Strategy.normalize(
            Object.assign({}, intent, { cashOut: { amount: 300 } }),
            { buyIn: 300, baseUnit: 5 }
        )).toThrow(/greater than the buy-in/);
    });

    test("attaches lifecycle metadata and maxActive for come bets", () => {
        const spec = Strategy.normalize({
            bets: [{ type: "come", units: 1, maxActive: 2 }]
        }, { buyIn: 300, baseUnit: 5 });
        const come = spec.bets[0];
        expect(come.lifecycle).toBe("travels");
        expect(come.maxActive).toBe(2);
    });

    test("throws on an invalid intent", () => {
        expect(() => Strategy.normalize({ bets: [{ type: "nope" }] }, {})).toThrow();
    });
});

describe("presets", () => {
    test("all presets normalize without error", () => {
        Object.values(Strategy.PRESETS).forEach((intent) => {
            expect(Strategy.validateIntent(intent).valid).toBe(true);
            const spec = Strategy.normalize(intent, { buyIn: 300, baseUnit: 5 });
            expect(spec.bets.length).toBeGreaterThan(0);
        });
    });
});
