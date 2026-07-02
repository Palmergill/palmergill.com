const Engine = require("../engine.js");
const Strategy = require("../strategy.js");

function spec(intent, form) {
    return Strategy.normalize(intent, Object.assign({ buyIn: 300, baseUnit: 5 }, form || {}));
}

// Drive one roll: place bets, then resolve the given dice. Mutates state.
function play(state, s, d1, d2) {
    Engine.placeBets(state, s);
    return Engine.resolveRollFor(state, s, d1 + d2, d1 === d2);
}

describe("rollDice", () => {
    test("is deterministic for a fixed seed and stays in 2..12", () => {
        const a = Engine.mulberry32(42);
        const b = Engine.mulberry32(42);
        for (let i = 0; i < 200; i++) {
            const r1 = Engine.rollDice(a);
            const r2 = Engine.rollDice(b);
            expect(r1.total).toBe(r2.total);
            expect(r1.total).toBeGreaterThanOrEqual(2);
            expect(r1.total).toBeLessThanOrEqual(12);
        }
    });
});

describe("pass line EV over fixed sequences", () => {
    const passOnly = () => spec({ bets: [{ type: "passLine", units: 2, when: "comeOut" }] });

    test("come-out 7 wins even money", () => {
        const s = passOnly();
        const st = Engine.createState(s);
        play(st, s, 3, 4); // total 7
        expect(Engine.totalValue(st)).toBe(310); // +$10 on $10 flat
        expect(st.wagered).toBe(10);
    });

    test("come-out craps loses the flat", () => {
        const s = passOnly();
        const st = Engine.createState(s);
        play(st, s, 1, 1); // total 2
        expect(Engine.totalValue(st)).toBe(290);
    });

    test("point established then made wins", () => {
        const s = passOnly();
        const st = Engine.createState(s);
        play(st, s, 1, 3); // point 4
        expect(Engine.totalValue(st)).toBe(300); // flat sits on felt
        play(st, s, 2, 2); // make the 4
        expect(Engine.totalValue(st)).toBe(310);
    });

    test("point established then seven-out loses", () => {
        const s = passOnly();
        const st = Engine.createState(s);
        play(st, s, 1, 4); // point 5
        play(st, s, 3, 4); // seven-out
        expect(Engine.totalValue(st)).toBe(290);
        expect(st.point).toBeNull();
    });
});

describe("place bet pays profit-only and keeps the stake on the felt", () => {
    test("place 6 win", () => {
        const s = spec({
            bets: [
                { type: "passLine", units: 2, when: "comeOut" },
                { type: "place6", units: 2, when: "pointOn" }
            ]
        });
        const st = Engine.createState(s);
        play(st, s, 1, 4);  // point 5, places pass flat
        play(st, s, 2, 4);  // total 6 -> place 6 hits
        // pass flat ($10) + place6 stake ($12) still on felt; +$14 profit to cash
        expect(Engine.totalValue(st)).toBe(314);
        expect(st.place[6]).toBe(12); // stake stayed working
    });
});

describe("hardway hit", () => {
    test("hard 6 pays 9:1", () => {
        const s = spec({ bets: [{ type: "hard6", units: 1 }], workingOnComeOut: true });
        const st = Engine.createState(s);
        play(st, s, 3, 3); // hard 6
        expect(Engine.totalValue(st)).toBe(345); // +$45 on $5
    });

    test("hardway-only strategy resolves with no point established (wagered > 0)", () => {
        // No line bet -> point is never set; hardways must still resolve every roll.
        const s = spec({ bets: [{ type: "hard8", units: 1 }] });
        const trial = Engine.runTrial(s, 0, 200);
        expect(trial.wagered).toBeGreaterThan(0);
        expect(s.workingOnComeOut).toBe(false);
    });

    test("hard 8 resolves on the come-out roll", () => {
        const s = spec({ bets: [{ type: "hard8", units: 1 }] });
        const st = Engine.createState(s);
        play(st, s, 4, 4); // hard 8 on come-out (point still null)
        expect(st.point).toBeNull();
        expect(Engine.totalValue(st)).toBe(345); // +$45 on $5 hard 8
        expect(st.wagered).toBe(5);
    });
});

describe("uniform Nx odds (not capped by the 3-4-5x table)", () => {
    test("5x odds on the point-4 takes 5x the flat and pays true 2:1", () => {
        // $10 pass flat, 5x odds via the global odds override.
        const s = spec({ bets: [{ type: "passLine", units: 1, when: "comeOut" }] },
            { buyIn: 1000, baseUnit: 10, oddsMultiplier: 5 });
        expect(s.odds.passLine).toBe(5);
        const st = Engine.createState(s);
        play(st, s, 1, 3);            // point 4 -> odds go up
        expect(st.passOdds).toBe(50); // 5 x $10, NOT capped at 3x=$30
        play(st, s, 2, 2);            // make the 4
        // flat wins $10, odds $50 pay 2:1 = $100 -> +$110 total
        expect(Engine.totalValue(st)).toBe(1110);
    });

    test('"max" still uses the 3-4-5x table (3x on the 4)', () => {
        const s = spec({ bets: [{ type: "passLine", units: 1, when: "comeOut" }] },
            { buyIn: 1000, baseUnit: 10, oddsMultiplier: "max" });
        const st = Engine.createState(s);
        play(st, s, 1, 3);            // point 4
        expect(st.passOdds).toBe(30); // table max on the 4 is 3x
    });
});

describe("expected (theoretical) house edge", () => {
    test("pass-line-only expected edge is exactly 1.41% (odds dilute it)", () => {
        const passOnly = Strategy.normalize(
            { name: "p", bets: [{ type: "passLine", units: 1, when: "comeOut" }] },
            { buyIn: 1000000, baseUnit: 10 });
        const withOdds = Strategy.normalize(
            { name: "p", bets: [{ type: "passLine", units: 1, when: "comeOut" }] },
            { buyIn: 1000000, baseUnit: 10, oddsMultiplier: 5 });

        const a = Engine.runSimulation(passOnly, { trials: 50, maxRolls: 500 }).stats;
        const b = Engine.runSimulation(withOdds, { trials: 50, maxRolls: 500 }).stats;

        // Only passLine is wagered -> weighted edge equals the passLine edge.
        expect(a.expectedEdge).toBeCloseTo(0.01414, 4);
        // Adding 5x odds (zero edge) pulls the blended edge well down.
        expect(b.expectedEdge).toBeLessThan(a.expectedEdge);
        expect(b.expectedEdge).toBeLessThan(0.006);
    });

    test("expected edge is stable across seeds (low variance)", () => {
        const mk = (seed) => Strategy.normalize(
            { name: "p", bets: [{ type: "passLine", units: 1, when: "comeOut" }] },
            { buyIn: 1000000, baseUnit: 10, oddsMultiplier: 3, seed });
        const e1 = Engine.runSimulation(mk(1), { trials: 50, maxRolls: 500 }).stats.expectedEdge;
        const e2 = Engine.runSimulation(mk(2), { trials: 50, maxRolls: 500 }).stats.expectedEdge;
        expect(Math.abs(e1 - e2)).toBeLessThan(0.001); // far tighter than realized edge
    });
});

describe("come odds are off on the shooter come-out", () => {
    // Pass + come, both max odds. Establish a come point, make the pass point so
    // the next roll is a come-out, then seven on the come-out: the come flat
    // loses but its odds are returned (not lost).
    function setup() {
        const s = spec({
            bets: [
                { type: "passLine", units: 2, when: "comeOut" },
                { type: "come", units: 2, when: "pointOn", maxActive: 1 }
            ],
            odds: { passLine: "max", come: "max" }
        });
        return s;
    }

    test("come-point odds returned on a come-out seven", () => {
        const s = setup();
        const st = Engine.createState(s);
        play(st, s, 2, 2);  // point 4 (pass), pass odds go up
        play(st, s, 3, 3);  // total 6: come flat travels to 6, gets come odds
        const comeOddsOnFelt = st.comePoints[6] ? st.comePoints[6].odds : 0;
        expect(comeOddsOnFelt).toBeGreaterThan(0);
        play(st, s, 2, 2);  // make the 4 -> pass wins, next roll is a come-out
        expect(st.point).toBeNull();
        const before = Engine.totalValue(st);
        play(st, s, 3, 4);  // come-out seven
        const after = Engine.totalValue(st);
        // On this come-out seven: the come flat ($20) loses, the freshly re-armed
        // pass line wins the natural ($20), and the come ODDS ($100) are returned
        // because they're off on the come-out. Net change is exactly $0. If the
        // odds were wrongly lost (the bug), `after` would be `before - 100`.
        expect(after).toBe(before);
    });
});

describe("field bet", () => {
    test("even money on 4, triple on 2", () => {
        let s = spec({ bets: [{ type: "field", units: 1 }] });
        let st = Engine.createState(s);
        play(st, s, 1, 3); // total 4 -> even money
        expect(Engine.totalValue(st)).toBe(305);

        st = Engine.createState(s);
        play(st, s, 1, 1); // total 2 -> 2:1
        expect(Engine.totalValue(st)).toBe(310);
    });

    test("loses on 5", () => {
        const s = spec({ bets: [{ type: "field", units: 1 }] });
        const st = Engine.createState(s);
        play(st, s, 2, 3); // total 5
        expect(Engine.totalValue(st)).toBe(295);
    });
});

describe("progressions", () => {
    const pressSpec = () => spec({
        bets: [
            { type: "passLine", units: 2, when: "comeOut" },
            { type: "place6", units: 2, when: "pointOn" }
        ],
        progression: { appliesTo: ["place6"], onWin: "press", onLoss: "none", resetOnSevenOut: true }
    });

    test("press increases the bet size after a win", () => {
        const s = pressSpec();
        const st = Engine.createState(s);
        play(st, s, 1, 4); // point 5
        play(st, s, 2, 4); // place 6 hits
        expect(st.sizes.place6).toBeGreaterThan(12);
    });

    test("resetOnSevenOut restores the base size", () => {
        const s = pressSpec();
        const st = Engine.createState(s);
        play(st, s, 1, 4); // point 5
        play(st, s, 2, 4); // place 6 hits -> pressed
        expect(st.sizes.place6).toBeGreaterThan(12);
        play(st, s, 3, 4); // seven-out -> reset
        expect(st.sizes.place6).toBe(12);
    });
});

describe("bust path", () => {
    test("value never goes negative and the trial stops", () => {
        const s = spec({ bets: [{ type: "passLine", units: 2, when: "comeOut" }] }, { buyIn: 20 });
        const trial = Engine.runTrial(s, 0, 1000);
        trial.balances.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
        expect(trial.rolls).toBeLessThanOrEqual(1000);
    });
});

describe("cash-out target", () => {
    test("stops a trial once total value reaches the target", () => {
        const s = spec({
            bets: [{ type: "hard6", units: 1 }],
            cashOut: { amount: 340 }
        }, { seed: 26 });
        const trial = Engine.runTrial(s, 0, 1000);
        expect(trial.cashedOut).toBe(true);
        expect(trial.busted).toBe(false);
        expect(trial.rolls).toBe(1);
        expect(trial.endValue).toBeGreaterThanOrEqual(340);
    });

    test("stats report cash-out rate and rolls to target", () => {
        const s = spec({
            bets: [{ type: "hard6", units: 1 }],
            cashOut: { amount: 340 }
        }, { seed: 26 });
        const { stats } = Engine.runSimulation(s, { trials: 1, maxRolls: 1000 });
        expect(stats.cashOutRate).toBe(1);
        expect(stats.cashOuts).toBe(1);
        expect(stats.meanRollsToCashOut).toBe(1);
    });
});

describe("statistical smoke test (wide band, not a convergence gate)", () => {
    test("flat pass-line realized house edge is sane", () => {
        const s = spec({ bets: [{ type: "passLine", units: 2, when: "comeOut" }] }, { buyIn: 100000 });
        const { stats } = Engine.runSimulation(s, { trials: 20, maxRolls: 500 });
        expect(stats.realizedHouseEdge).toBeGreaterThan(-0.1);
        expect(stats.realizedHouseEdge).toBeLessThan(0.1);
        expect(stats.survivalRate).toBeGreaterThan(0.9); // huge bankroll -> rarely busts
    });
});
