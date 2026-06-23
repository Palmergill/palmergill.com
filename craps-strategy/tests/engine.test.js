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

describe("statistical smoke test (wide band, not a convergence gate)", () => {
    test("flat pass-line realized house edge is sane", () => {
        const s = spec({ bets: [{ type: "passLine", units: 2, when: "comeOut" }] }, { buyIn: 100000 });
        const { stats } = Engine.runSimulation(s, { trials: 20, maxRolls: 500 });
        expect(stats.realizedHouseEdge).toBeGreaterThan(-0.1);
        expect(stats.realizedHouseEdge).toBeLessThan(0.1);
        expect(stats.survivalRate).toBeGreaterThan(0.9); // huge bankroll -> rarely busts
    });
});
