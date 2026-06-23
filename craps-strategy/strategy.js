// Craps strategy contract.
//
// Two stages, deliberately separated so there is exactly one source of truth
// for money and one for randomness:
//
//   1. StrategyIntent  -> what the LLM (or a preset) produces. Bet *types* and
//      relative *units* only. No dollar amounts, no seed.
//   2. StrategySpec    -> what `normalize(intent, form)` produces. Concrete
//      dollar amounts (snapped to legal increments), the buy-in, and a stable
//      `baseSeed`. This frozen object is what engine.js consumes.
//
// Keeping the LLM out of the money/seed business is what makes a run
// reproducible: the same (intent, form) always normalizes to the same spec,
// and the same spec always produces the same 100 lines.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CrapsStrategy = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    // ---- Bet vocabulary + lifecycle ----------------------------------------
    // lifecycle drives how engine.js places/works/resolves the bet; `when` and
    // `everyRoll` are only gating modifiers on top of the lifecycle.
    const LINE_BETS = ["passLine", "dontPass", "come", "dontCome"];

    const BET_META = Object.freeze({
        passLine: { lifecycle: "contract", defaultWhen: "comeOut" },
        dontPass: { lifecycle: "contract", defaultWhen: "comeOut" },
        come: { lifecycle: "travels", defaultWhen: "pointOn" },
        dontCome: { lifecycle: "travels", defaultWhen: "pointOn" },
        place4: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        place5: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        place6: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        place8: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        place9: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        place10: { lifecycle: "persistentUntilSeven", defaultWhen: "pointOn" },
        hard4: { lifecycle: "persistentUntilSeven", defaultWhen: "always" },
        hard6: { lifecycle: "persistentUntilSeven", defaultWhen: "always" },
        hard8: { lifecycle: "persistentUntilSeven", defaultWhen: "always" },
        hard10: { lifecycle: "persistentUntilSeven", defaultWhen: "always" },
        field: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        any7: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        anyCraps: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        yo11: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        craps2: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        craps3: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true },
        craps12: { lifecycle: "oneRoll", defaultWhen: "always", everyRoll: true }
    });

    const BET_TYPES = Object.freeze(Object.keys(BET_META));
    const WHEN_VALUES = Object.freeze(["comeOut", "pointOn", "always"]);
    const ON_WIN_VALUES = Object.freeze(["press", "regress", "none"]);
    const ON_LOSS_VALUES = Object.freeze(["double", "none"]);

    const MAX_BETS = 24;
    const MAX_ODDS_MULTIPLIER = 100;
    const MAX_AMOUNT = 100000;

    function lifecycleOf(type) {
        return BET_META[type] ? BET_META[type].lifecycle : null;
    }

    function isLineBet(type) {
        return LINE_BETS.includes(type);
    }

    // ---- Legal-money increments --------------------------------------------
    // Place 6/8 must be in $6 units and the other place numbers in $5 units so
    // the casino pays whole dollars; everything else snaps to the table base
    // unit. These increments are fixed by payout math, independent of baseUnit.
    function incrementFor(type, baseUnit) {
        if (type === "place6" || type === "place8") return 6;
        if (["place4", "place5", "place9", "place10"].includes(type)) return 5;
        return Math.max(1, baseUnit);
    }

    // Round to the nearest legal increment, never below one increment, so an
    // intent never normalizes a positive bet down to $0.
    function snapAmount(type, raw, baseUnit) {
        const inc = incrementFor(type, baseUnit);
        if (!(raw > 0)) return 0;
        const steps = Math.max(1, Math.round(raw / inc));
        return steps * inc;
    }

    // ---- Validation ---------------------------------------------------------
    function isPlainObject(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    function isPositiveInt(v) {
        return typeof v === "number" && Number.isInteger(v) && v > 0;
    }

    // Returns { valid, errors }. Pure — never throws — so callers can surface a
    // friendly message. The backend mirrors these rules in Pydantic.
    function validateIntent(intent) {
        const errors = [];

        if (!isPlainObject(intent)) {
            return { valid: false, errors: ["Strategy must be an object"] };
        }
        if (!Array.isArray(intent.bets) || intent.bets.length === 0) {
            errors.push("Strategy must include at least one bet");
        } else if (intent.bets.length > MAX_BETS) {
            errors.push(`Too many bets (max ${MAX_BETS})`);
        } else {
            // The engine keys all state (sizes, active bets) by bet type, so a
            // type may appear at most once — duplicates would silently collapse.
            const seenTypes = new Set();
            intent.bets.forEach((bet, i) => {
                if (!isPlainObject(bet)) {
                    errors.push(`bets[${i}] must be an object`);
                    return;
                }
                if (!BET_TYPES.includes(bet.type)) {
                    errors.push(`bets[${i}].type "${bet.type}" is not a known bet`);
                } else if (seenTypes.has(bet.type)) {
                    errors.push(`bets[${i}].type "${bet.type}" is listed more than once`);
                } else {
                    seenTypes.add(bet.type);
                }
                // `!= null` treats both undefined and null as "not provided" —
                // LLM/JSON output routinely carries null for unset fields.
                if (bet.units != null && !isPositiveInt(bet.units)) {
                    errors.push(`bets[${i}].units must be a positive integer`);
                }
                if (bet.when != null && !WHEN_VALUES.includes(bet.when)) {
                    errors.push(`bets[${i}].when "${bet.when}" is invalid`);
                }
                if (bet.maxActive != null && !isPositiveInt(bet.maxActive)) {
                    errors.push(`bets[${i}].maxActive must be a positive integer`);
                }
            });
        }

        if (intent.odds != null) {
            if (!isPlainObject(intent.odds)) {
                errors.push("odds must be an object");
            } else {
                Object.entries(intent.odds).forEach(([line, mult]) => {
                    if (!isLineBet(line)) {
                        errors.push(`odds key "${line}" is not a line bet`);
                    }
                    const okMult = mult === "max" ||
                        (isPositiveInt(mult) && mult <= MAX_ODDS_MULTIPLIER);
                    if (!okMult) {
                        errors.push(`odds.${line} must be "max" or 1..${MAX_ODDS_MULTIPLIER}`);
                    }
                });
            }
        }

        if (intent.progression != null) {
            const p = intent.progression;
            if (!isPlainObject(p)) {
                errors.push("progression must be an object");
            } else {
                if (p.onWin != null && !ON_WIN_VALUES.includes(p.onWin)) {
                    errors.push(`progression.onWin must be one of ${ON_WIN_VALUES.join(", ")}`);
                }
                if (p.onLoss != null && !ON_LOSS_VALUES.includes(p.onLoss)) {
                    errors.push(`progression.onLoss must be one of ${ON_LOSS_VALUES.join(", ")}`);
                }
                if (p.resetOnSevenOut != null && typeof p.resetOnSevenOut !== "boolean") {
                    errors.push("progression.resetOnSevenOut must be a boolean");
                }
                if (p.appliesTo != null) {
                    if (!Array.isArray(p.appliesTo)) {
                        errors.push("progression.appliesTo must be an array");
                    } else {
                        p.appliesTo.forEach((t) => {
                            if (!BET_TYPES.includes(t)) {
                                errors.push(`progression.appliesTo "${t}" is not a known bet`);
                            }
                        });
                    }
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    // ---- Canonical hash (the seed) -----------------------------------------
    // Stable stringify with sorted keys so logically-equal specs hash equally,
    // then FNV-1a 32-bit. The seed therefore changes whenever amounts, buy-in,
    // odds, or progression change — but a re-run of the identical spec repeats.
    function canonicalize(value) {
        if (Array.isArray(value)) {
            return "[" + value.map(canonicalize).join(",") + "]";
        }
        if (isPlainObject(value)) {
            return "{" + Object.keys(value).sort()
                .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]))
                .join(",") + "}";
        }
        return JSON.stringify(value === undefined ? null : value);
    }

    function fnv1a(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return hash >>> 0;
    }

    function hashCanonical(spec) {
        const { baseSeed, ...rest } = spec; // exclude the seed itself
        return fnv1a(canonicalize(rest));
    }

    // ---- Normalization: intent + form -> spec ------------------------------
    // `form` carries the user-controlled inputs: { buyIn, baseUnit, overrides,
    // seed }. Per-bet dollar overrides always beat the LLM's units, so "set
    // your bet sizes" stays under the user's control with one decision point.
    function normalize(intent, form) {
        const check = validateIntent(intent);
        if (!check.valid) {
            const err = new Error("Invalid strategy: " + check.errors.join("; "));
            err.errors = check.errors;
            throw err;
        }

        const baseUnit = isPositiveInt(form && form.baseUnit) ? form.baseUnit : 5;
        const buyIn = isPositiveInt(form && form.buyIn) ? form.buyIn : 300;
        const overrides = (form && isPlainObject(form.overrides)) ? form.overrides : {};

        const bets = [];
        intent.bets.forEach((bet) => {
            const meta = BET_META[bet.type];
            const override = overrides[bet.type];
            const raw = isPositiveInt(override)
                ? override
                : (bet.units || 1) * baseUnit;
            const amount = Math.min(MAX_AMOUNT, snapAmount(bet.type, raw, baseUnit));
            if (amount <= 0) return;
            bets.push({
                type: bet.type,
                amount,
                when: bet.when || meta.defaultWhen,
                everyRoll: bet.everyRoll != null ? !!bet.everyRoll : !!meta.everyRoll,
                lifecycle: meta.lifecycle,
                maxActive: meta.lifecycle === "travels"
                    ? (bet.maxActive || 1)
                    : undefined
            });
        });

        if (bets.length === 0) {
            throw new Error("Strategy has no fundable bets after normalization");
        }

        const odds = {};
        if (isPlainObject(intent.odds)) {
            Object.entries(intent.odds).forEach(([line, mult]) => {
                odds[line] = mult === "max" ? "max" : Math.min(MAX_ODDS_MULTIPLIER, mult);
            });
        }

        // Optional global odds override from the form: take a uniform multiple
        // ("max", 1..N, or "none") on every line bet in the strategy. Lets a user
        // dial 1x..5x odds without re-describing the strategy. When unset, the
        // strategy's own per-bet odds are kept.
        const om = form && form.oddsMultiplier;
        if (om != null && om !== "") {
            Object.keys(odds).forEach((k) => delete odds[k]);
            if (om !== "none" && om !== 0) {
                const mult = om === "max" ? "max" : Math.min(MAX_ODDS_MULTIPLIER, om);
                bets.forEach((b) => { if (isLineBet(b.type)) odds[b.type] = mult; });
            }
        }

        const pIn = isPlainObject(intent.progression) ? intent.progression : {};
        const progression = {
            appliesTo: Array.isArray(pIn.appliesTo) ? pIn.appliesTo.slice() : [],
            onWin: ON_WIN_VALUES.includes(pIn.onWin) ? pIn.onWin : "none",
            onLoss: ON_LOSS_VALUES.includes(pIn.onLoss) ? pIn.onLoss : "none",
            resetOnSevenOut: !!pIn.resetOnSevenOut
        };

        const spec = {
            name: typeof intent.name === "string" ? intent.name : "Custom strategy",
            summary: typeof intent.summary === "string" ? intent.summary : "",
            baseUnit,
            buyIn,
            workingOnComeOut: !!intent.workingOnComeOut,
            bets,
            odds,
            progression
        };

        // Seed: explicit form.seed wins (so a user can reproduce/vary a run);
        // otherwise derive deterministically from the canonical spec.
        spec.baseSeed = isPositiveInt(form && form.seed)
            ? (form.seed >>> 0)
            : hashCanonical(spec);

        return spec;
    }

    // ---- Built-in presets (also the no-LLM fallback) -----------------------
    // Each is a StrategyIntent; the UI normalizes it with the live form.
    const PRESETS = Object.freeze({
        passOdds: {
            name: "Pass Line + Odds",
            summary: "Pass line every come-out, full odds behind the point.",
            bets: [{ type: "passLine", units: 1, when: "comeOut" }],
            odds: { passLine: "max" }
        },
        ironCross: {
            name: "Iron Cross",
            summary: "Pass line plus place 5/6/8 and a field bet, so every number but 7 pays.",
            bets: [
                { type: "passLine", units: 1, when: "comeOut" },
                { type: "place5", units: 1, when: "pointOn" },
                { type: "place6", units: 1, when: "pointOn" },
                { type: "place8", units: 1, when: "pointOn" },
                { type: "field", units: 1, when: "pointOn", everyRoll: true }
            ]
        },
        threePointMolly: {
            name: "3-Point Molly",
            summary: "Pass line with odds, then up to two come bets with odds working a point each.",
            bets: [
                { type: "passLine", units: 1, when: "comeOut" },
                { type: "come", units: 1, when: "pointOn", maxActive: 2 }
            ],
            odds: { passLine: "max", come: "max" }
        },
        dontPassOdds: {
            name: "Don't Pass + Odds",
            summary: "Bet against the shooter on the don't pass with lay odds.",
            bets: [{ type: "dontPass", units: 1, when: "comeOut" }],
            odds: { dontPass: "max" }
        }
    });

    return {
        BET_TYPES,
        BET_META,
        LINE_BETS,
        WHEN_VALUES,
        ON_WIN_VALUES,
        ON_LOSS_VALUES,
        PRESETS,
        lifecycleOf,
        isLineBet,
        incrementFor,
        snapAmount,
        validateIntent,
        canonicalize,
        hashCanonical,
        normalize
    };
});
