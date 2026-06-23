// Craps simulation engine.
//
// Pure and deterministic: no DOM, no Math.random. Given a normalized
// StrategySpec (from strategy.js) it runs Monte-Carlo trials reproducibly.
//
// Money model (the invariant everything else depends on):
//   * `balance` is CASH IN HAND only.
//   * `onFelt` tracks every dollar resting on the table. A placement does
//     `balance -= a; onFelt += a`; a resolution does `onFelt -= stake` and, on
//     a win, `balance += stakeReturnedPlusProfit`.
//   * Ending value (what we plot and bust-check) = `balance + onFelt`, so a
//     player isn't punished for stakes that simply hadn't resolved by roll N.
//
// crapsRules helpers report different things (some return stake+profit, some
// leave the bet on the felt), so each is wrapped to the model above.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("../craps/crapsRules.js"));
    } else {
        root.CrapsEngine = factory(root.CrapsRules);
    }
})(typeof self !== "undefined" ? self : this, function (CrapsRules) {
    const {
        getOddsPayout,
        calculateOddsToAdd,
        resolveOneRollBets,
        resolveHardwayBets,
        resolvePlaceBetWins,
        resolvePlaceBetsOnSeven
    } = CrapsRules;

    const PLACE_NUMBERS = [4, 5, 6, 8, 9, 10];

    // ---- RNG ----------------------------------------------------------------
    // mulberry32: tiny, fast, good enough for dice. Seeded per trial.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Deterministically fold the trial index into the base seed so trial i of a
    // given spec is always identical.
    function mix(baseSeed, i) {
        let h = (baseSeed ^ Math.imul(i + 1, 0x9E3779B9)) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        return (h ^ (h >>> 16)) >>> 0;
    }

    function rollDice(rng) {
        const d1 = Math.floor(rng() * 6) + 1;
        const d2 = Math.floor(rng() * 6) + 1;
        return { d1, d2, total: d1 + d2, isHard: d1 === d2 };
    }

    // ---- State --------------------------------------------------------------
    function createState(spec) {
        // current size per bet type (mutated by progressions); starts at the
        // normalized amount.
        const sizes = {};
        spec.bets.forEach((b) => { sizes[b.type] = b.amount; });
        return {
            balance: spec.buyIn,
            onFelt: 0,
            point: null,            // null = come-out
            sizes,
            place: {},              // number -> amount on felt
            hard: {},               // type -> amount on felt
            oneRoll: {},            // type -> amount on felt (resolves each roll)
            pass: 0,
            passOdds: 0,
            dontPass: 0,
            dontPassOdds: 0,
            comeFlat: 0,
            dontComeFlat: 0,
            comePoints: {},         // number -> { amount, odds }
            dontComePoints: {},     // number -> { amount, odds }
            wagered: 0
        };
    }

    function totalValue(state) {
        return state.balance + state.onFelt;
    }

    function smallestBet(spec) {
        return spec.bets.reduce((m, b) => Math.min(m, b.amount), Infinity);
    }

    // Place `amount` on the felt if affordable. Returns the amount actually
    // placed (0 if it couldn't be funded).
    function fund(state, amount) {
        if (amount <= 0 || state.balance < amount) return 0;
        state.balance -= amount;
        state.onFelt += amount;
        return amount;
    }

    // A stake leaves the felt (resolved). `payout` is the gross returned to cash
    // (stake + profit on a win, 0 on a loss).
    function settle(state, stake, payout) {
        state.onFelt -= stake;
        state.balance += payout;
        state.wagered += stake;
    }

    // ---- Placement ----------------------------------------------------------
    function whenAllows(when, isComeOut) {
        if (when === "comeOut") return isComeOut;
        if (when === "pointOn") return !isComeOut;
        return true; // always
    }

    function oddsToAdd(state, flat, point, multiplier, isPass) {
        if (!multiplier || !point) return 0;
        return calculateOddsToAdd({
            point,
            amount: flat,
            odds: 0,
            balance: state.balance,
            multiplier,
            isPass
        });
    }

    // Lay down / refresh bets for the upcoming roll per lifecycle + gating.
    function placeBets(state, spec) {
        const isComeOut = state.point === null;

        spec.bets.forEach((bet) => {
            const size = state.sizes[bet.type];
            if (!whenAllows(bet.when, isComeOut)) return;

            switch (bet.lifecycle) {
                case "contract":
                    if (bet.type === "passLine" && isComeOut && state.pass === 0) {
                        state.pass = fund(state, size);
                    } else if (bet.type === "dontPass" && isComeOut && state.dontPass === 0) {
                        state.dontPass = fund(state, size);
                    }
                    break;
                case "travels": {
                    const active = Object.keys(
                        bet.type === "come" ? state.comePoints : state.dontComePoints
                    ).length + ((bet.type === "come" ? state.comeFlat : state.dontComeFlat) > 0 ? 1 : 0);
                    if (active >= (bet.maxActive || 1)) break;
                    if (bet.type === "come" && state.comeFlat === 0) {
                        state.comeFlat = fund(state, size);
                    } else if (bet.type === "dontCome" && state.dontComeFlat === 0) {
                        state.dontComeFlat = fund(state, size);
                    }
                    break;
                }
                case "persistentUntilSeven":
                    if (bet.type.startsWith("place")) {
                        const n = Number(bet.type.slice(5));
                        if (!state.place[n]) state.place[n] = fund(state, size);
                    } else { // hard*
                        if (!state.hard[bet.type]) state.hard[bet.type] = fund(state, size);
                    }
                    break;
                case "oneRoll":
                    if (bet.everyRoll || !state.oneRoll[bet.type]) {
                        if (!state.oneRoll[bet.type]) state.oneRoll[bet.type] = fund(state, size);
                    }
                    break;
                default:
                    break;
            }
        });
    }

    // ---- Resolution ---------------------------------------------------------
    // outcomes accumulates per-type results so progressions can react:
    //   wins[type] = profit gained, losses[type] = stake lost.
    function newOutcomes() { return { wins: {}, losses: {} }; }
    function recordWin(o, type, profit) { o.wins[type] = (o.wins[type] || 0) + profit; }
    function recordLoss(o, type, stake) { o.losses[type] = (o.losses[type] || 0) + stake; }

    // crapsRules.resolveOneRollBets aggregates winnings across all one-roll
    // bets, so resolve each type singly to attribute the payout precisely.
    function resolveOneRoll(state, total, o) {
        Object.keys(state.oneRoll).forEach((type) => {
            const stake = state.oneRoll[type];
            if (!stake) return;
            const single = resolveOneRollBets({ [type]: stake }, total);
            const won = single.winnings > 0;
            settle(state, stake, won ? single.winnings : 0); // winnings include stake
            if (won) recordWin(o, type, single.winnings - stake); else recordLoss(o, type, stake);
            state.oneRoll[type] = 0;
        });
    }

    function resolvePlaceAndHard(state, total, isHard, o) {
        // place wins (bet stays on felt -> add PROFIT only)
        const winRes = resolvePlaceBetWins({ ...placeAsBets(state) }, total);
        if (winRes.winnings > 0 && PLACE_NUMBERS.includes(total) && state.place[total]) {
            const stake = state.place[total];
            const profit = winRes.winnings - stake; // helper returns stake+profit
            state.balance += profit;                // stake stays working on felt
            state.wagered += stake;
            recordWin(o, "place" + total, profit);
        }
        // hardways (helper takes a winner down; we re-arm next placement)
        const hardRes = resolveHardwayBets({ ...state.hard }, total, isHard);
        Object.keys(state.hard).forEach((type) => {
            const stake = state.hard[type];
            if (!stake) return;
            if (hardRes.bets[type] === 0) { // resolved (won or lost)
                const won = wonHard(type, total, isHard);
                const payout = won ? hardPayout(type, stake) : 0;
                settle(state, stake, payout);
                if (won) recordWin(o, type, payout - stake); else recordLoss(o, type, stake);
                state.hard[type] = 0;
            }
        });
    }

    function placeAsBets(state) {
        const b = {};
        PLACE_NUMBERS.forEach((n) => { if (state.place[n]) b["place" + n] = state.place[n]; });
        return b;
    }

    function wonHard(type, total, isHard) {
        const single = resolveHardwayBets({ [type]: 1 }, total, isHard);
        return single.winnings > 0;
    }
    function hardPayout(type, stake) {
        const single = resolveHardwayBets({ [type]: stake }, Number(type.slice(4)), true);
        return single.winnings; // stake + profit
    }

    function sevenOutPlaceHard(state, o) {
        const placeRes = resolvePlaceBetsOnSeven({ ...placeAsBets(state) });
        PLACE_NUMBERS.forEach((n) => {
            if (state.place[n]) {
                recordLoss(o, "place" + n, state.place[n]);
                settle(state, state.place[n], 0);
                state.place[n] = 0;
            }
        });
        void placeRes;
        // hardways all lose on a 7
        Object.keys(state.hard).forEach((type) => {
            if (state.hard[type]) {
                recordLoss(o, type, state.hard[type]);
                settle(state, state.hard[type], 0);
                state.hard[type] = 0;
            }
        });
    }

    // Line bets (pass / don't pass) + their odds, plus come/don't-come.
    // Returns true if this roll was a seven-out (point phase 7).
    function resolveLine(state, spec, total, o) {
        const isComeOut = state.point === null;
        let sevenOut = false;

        // --- established come / don't-come points (resolve before line) ------
        resolveComePoints(state, total, o);

        if (isComeOut) {
            // pass line
            if (state.pass > 0) {
                if (total === 7 || total === 11) {
                    settle(state, state.pass, state.pass * 2);
                    recordWin(o, "passLine", state.pass);
                    state.pass = 0;
                } else if (total === 2 || total === 3 || total === 12) {
                    recordLoss(o, "passLine", state.pass);
                    settle(state, state.pass, 0);
                    state.pass = 0;
                } else {
                    state.point = total; // point established; flat stays
                }
            }
            // don't pass
            if (state.dontPass > 0) {
                if (total === 2 || total === 3) {
                    settle(state, state.dontPass, state.dontPass * 2);
                    recordWin(o, "dontPass", state.dontPass);
                    state.dontPass = 0;
                } else if (total === 7 || total === 11) {
                    recordLoss(o, "dontPass", state.dontPass);
                    settle(state, state.dontPass, 0);
                    state.dontPass = 0;
                } else if (total === 12) {
                    // push (bar 12): bet stays for the next come-out
                } else if (state.point === null) {
                    state.point = total;
                }
            }
            // a point may have just been set; add odds behind line bets
            if (state.point !== null) addLineOdds(state, spec);
        } else {
            const point = state.point;
            if (total === point) {
                // pass wins, don't loses
                if (state.pass > 0) {
                    settle(state, state.pass, state.pass * 2);
                    recordWin(o, "passLine", state.pass);
                    if (state.passOdds > 0) {
                        const profit = Math.floor(state.passOdds * getOddsPayout(point, true));
                        settle(state, state.passOdds, state.passOdds + profit);
                        state.passOdds = 0;
                    }
                    state.pass = 0;
                }
                if (state.dontPass > 0) {
                    recordLoss(o, "dontPass", state.dontPass);
                    settle(state, state.dontPass, 0);
                    if (state.dontPassOdds > 0) { settle(state, state.dontPassOdds, 0); state.dontPassOdds = 0; }
                    state.dontPass = 0;
                }
                state.point = null;
            } else if (total === 7) {
                sevenOut = true;
                if (state.pass > 0) {
                    recordLoss(o, "passLine", state.pass);
                    settle(state, state.pass, 0);
                    if (state.passOdds > 0) { settle(state, state.passOdds, 0); state.passOdds = 0; }
                    state.pass = 0;
                }
                if (state.dontPass > 0) {
                    settle(state, state.dontPass, state.dontPass * 2);
                    recordWin(o, "dontPass", state.dontPass);
                    if (state.dontPassOdds > 0) {
                        const profit = Math.floor(state.dontPassOdds * getOddsPayout(point, false));
                        settle(state, state.dontPassOdds, state.dontPassOdds + profit);
                        state.dontPassOdds = 0;
                    }
                    state.dontPass = 0;
                }
                state.point = null;
            }
        }

        // --- come / don't-come flats (act like a come-out on this roll) ------
        resolveComeFlats(state, spec, total, o);

        return sevenOut;
    }

    function addLineOdds(state, spec) {
        if (state.pass > 0 && spec.odds.passLine && state.passOdds === 0) {
            const add = oddsToAdd(state, state.pass, state.point, spec.odds.passLine, true);
            state.passOdds = fund(state, add);
        }
        if (state.dontPass > 0 && spec.odds.dontPass && state.dontPassOdds === 0) {
            const add = oddsToAdd(state, state.dontPass, state.point, spec.odds.dontPass, false);
            state.dontPassOdds = fund(state, add);
        }
    }

    function resolveComePoints(state, total, o) {
        if (total === 7) {
            // all come points lose, all don't-come points win
            Object.keys(state.comePoints).forEach((n) => {
                const cp = state.comePoints[n];
                recordLoss(o, "come", cp.amount);
                settle(state, cp.amount + cp.odds, 0);
                delete state.comePoints[n];
            });
            Object.keys(state.dontComePoints).forEach((n) => {
                const dp = state.dontComePoints[n];
                const num = Number(n);
                settle(state, dp.amount, dp.amount * 2);
                if (dp.odds > 0) {
                    const profit = Math.floor(dp.odds * getOddsPayout(num, false));
                    settle(state, dp.odds, dp.odds + profit);
                }
                recordWin(o, "dontCome", dp.amount);
                delete state.dontComePoints[n];
            });
            return;
        }
        if (state.comePoints[total]) {
            const cp = state.comePoints[total];
            settle(state, cp.amount, cp.amount * 2);
            if (cp.odds > 0) {
                const profit = Math.floor(cp.odds * getOddsPayout(total, true));
                settle(state, cp.odds, cp.odds + profit);
            }
            recordWin(o, "come", cp.amount);
            delete state.comePoints[total];
        }
        if (state.dontComePoints[total]) {
            const dp = state.dontComePoints[total];
            recordLoss(o, "dontCome", dp.amount);
            settle(state, dp.amount + dp.odds, 0);
            delete state.dontComePoints[total];
        }
    }

    function resolveComeFlats(state, spec, total, o) {
        if (state.comeFlat > 0) {
            if (total === 7 || total === 11) {
                settle(state, state.comeFlat, state.comeFlat * 2);
                recordWin(o, "come", state.comeFlat);
                state.comeFlat = 0;
            } else if (total === 2 || total === 3 || total === 12) {
                recordLoss(o, "come", state.comeFlat);
                settle(state, state.comeFlat, 0);
                state.comeFlat = 0;
            } else {
                const odds = spec.odds.come
                    ? fund(state, oddsToAdd(state, state.comeFlat, total, spec.odds.come, true))
                    : 0;
                state.comePoints[total] = { amount: state.comeFlat, odds };
                state.comeFlat = 0;
            }
        }
        if (state.dontComeFlat > 0) {
            if (total === 2 || total === 3) {
                settle(state, state.dontComeFlat, state.dontComeFlat * 2);
                recordWin(o, "dontCome", state.dontComeFlat);
                state.dontComeFlat = 0;
            } else if (total === 7 || total === 11) {
                recordLoss(o, "dontCome", state.dontComeFlat);
                settle(state, state.dontComeFlat, 0);
                state.dontComeFlat = 0;
            } else if (total === 12) {
                // bar 12 push: stays as a flat for next roll
            } else {
                const odds = spec.odds.dontCome
                    ? fund(state, oddsToAdd(state, state.dontComeFlat, total, spec.odds.dontCome, false))
                    : 0;
                state.dontComePoints[total] = { amount: state.dontComeFlat, odds };
                state.dontComeFlat = 0;
            }
        }
    }

    // ---- Progressions -------------------------------------------------------
    function applyProgressions(state, spec, o, sevenOut) {
        const prog = spec.progression;
        const applies = new Set(prog.appliesTo);

        applies.forEach((type) => {
            const base = baseSizeFor(spec, type);
            if (o.wins[type]) {
                if (prog.onWin === "press") {
                    state.sizes[type] = state.sizes[type] + Math.max(base, Math.round(o.wins[type]));
                } else if (prog.onWin === "regress") {
                    state.sizes[type] = base;
                }
            } else if (o.losses[type]) {
                if (prog.onLoss === "double") {
                    state.sizes[type] = state.sizes[type] * 2;
                }
            }
        });

        if (sevenOut && prog.resetOnSevenOut) {
            applies.forEach((type) => { state.sizes[type] = baseSizeFor(spec, type); });
        }
    }

    function baseSizeFor(spec, type) {
        const b = spec.bets.find((x) => x.type === type);
        return b ? b.amount : 0;
    }

    // ---- One trial ----------------------------------------------------------
    function runTrial(spec, trialIndex, maxRolls) {
        const state = createState(spec);
        const rng = mulberry32(mix(spec.baseSeed >>> 0, trialIndex >>> 0));
        const balances = [];
        const minBet = smallestBet(spec);
        let rolls = 0;
        let busted = false;

        for (let r = 0; r < maxRolls; r++) {
            placeBets(state, spec);

            // If nothing is on the felt and the smallest bet is unaffordable,
            // the player can't act -> treat as busted.
            if (state.onFelt === 0 && state.balance < minBet) {
                busted = true;
                rolls = r;
                break;
            }

            const { total, isHard } = rollDice(rng);
            resolveRollFor(state, spec, total, isHard);

            rolls = r + 1;
            const value = totalValue(state);
            balances.push(value);

            if (value <= 0) { busted = true; break; }
        }

        return {
            balances,
            busted,
            rolls,
            wagered: state.wagered,
            endValue: balances.length ? balances[balances.length - 1] : spec.buyIn
        };
    }

    // place/hard resolution wrapper that also handles the seven-out clear.
    function resolvePlaceAndHardForRoll(state, total, isHard, o) {
        if (total === 7 && state.point !== null) {
            sevenOutPlaceHard(state, o);
        } else {
            resolvePlaceAndHard(state, total, isHard, o);
        }
    }

    // Resolve a single roll against an existing state (placement already done).
    // Order: one-roll bets, place/hard (only while working), line, progressions.
    // Returns { sevenOut, outcomes }. Exported for deterministic EV tests.
    function resolveRollFor(state, spec, total, isHard) {
        const o = newOutcomes();
        resolveOneRoll(state, total, o);
        const working = state.point !== null || spec.workingOnComeOut;
        if (working) resolvePlaceAndHardForRoll(state, total, isHard, o);
        const sevenOut = resolveLine(state, spec, total, o);
        applyProgressions(state, spec, o, sevenOut);
        return { sevenOut, outcomes: o };
    }

    // ---- Simulation + stats -------------------------------------------------
    function runSimulation(spec, opts) {
        const options = opts || {};
        const trials = options.trials || 100;
        const maxRolls = options.maxRolls || 1000;
        const results = [];
        for (let i = 0; i < trials; i++) {
            results.push(runTrial(spec, i, maxRolls));
        }
        return { trials: results, stats: computeStats(results, spec) };
    }

    function median(nums) {
        if (nums.length === 0) return 0;
        const s = nums.slice().sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    function computeStats(results, spec) {
        const ends = results.map((t) => t.endValue);
        const survived = results.filter((t) => !t.busted).length;
        const totalWagered = results.reduce((s, t) => s + t.wagered, 0);
        const netProfit = results.reduce((s, t) => s + (t.endValue - spec.buyIn), 0);
        const bustedRolls = results.filter((t) => t.busted).map((t) => t.rolls);

        return {
            trials: results.length,
            buyIn: spec.buyIn,
            survivalRate: results.length ? survived / results.length : 0,
            survivors: survived,
            meanEnd: ends.length ? ends.reduce((s, v) => s + v, 0) / ends.length : 0,
            medianEnd: median(ends),
            bestEnd: ends.length ? Math.max(...ends) : 0,
            worstEnd: ends.length ? Math.min(...ends) : 0,
            meanRollsBeforeBust: bustedRolls.length
                ? bustedRolls.reduce((s, v) => s + v, 0) / bustedRolls.length
                : null,
            totalWagered,
            netProfit,
            // Realized house edge: how much of every wagered dollar the house
            // kept, on average. Positive = house ahead.
            realizedHouseEdge: totalWagered ? -netProfit / totalWagered : 0
        };
    }

    return {
        mulberry32,
        mix,
        rollDice,
        createState,
        placeBets,
        resolveRollFor,
        totalValue,
        runTrial,
        runSimulation,
        computeStats
    };
});
