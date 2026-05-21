(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CrapsRules = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const ODDS_MULTIPLIERS = Object.freeze({ 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 });

    const BET_NAMES = Object.freeze({
        passLine: "Pass Line",
        dontPass: "Don't Pass",
        any7: "Any 7",
        anyCraps: "Any Craps",
        field: "Field",
        craps2: "Craps 2",
        craps3: "Craps 3",
        craps12: "Craps 12",
        yo11: "Yo 11",
        hard4: "Hard 4",
        hard6: "Hard 6",
        hard8: "Hard 8",
        hard10: "Hard 10",
        place4: "Place 4",
        place5: "Place 5",
        place6: "Place 6",
        place8: "Place 8",
        place9: "Place 9",
        place10: "Place 10"
    });

    const ONE_ROLL_BETS = Object.freeze({
        any7: {
            wins: (total) => total === 7,
            payout: () => 5,
            message: "Any 7 wins!"
        },
        anyCraps: {
            wins: (total) => [2, 3, 12].includes(total),
            payout: () => 8,
            message: "Any Craps wins!"
        },
        craps2: {
            wins: (total) => total === 2,
            payout: () => 31,
            message: "Craps 2 wins!"
        },
        craps3: {
            wins: (total) => total === 3,
            payout: () => 16,
            message: "Craps 3 wins!"
        },
        craps12: {
            wins: (total) => total === 12,
            payout: () => 31,
            message: "Craps 12 wins!"
        },
        yo11: {
            wins: (total) => total === 11,
            payout: () => 16,
            message: "Yo 11 wins!"
        },
        field: {
            wins: (total) => [2, 3, 4, 9, 10, 11, 12].includes(total),
            payout: (total) => (total === 2 || total === 12 ? 3 : 2),
            message: "Field wins!"
        }
    });

    const HARDWAY_BETS = Object.freeze({
        hard4: { total: 4, payout: 8, message: "Hard 4 wins!" },
        hard6: { total: 6, payout: 10, message: "Hard 6 wins!" },
        hard8: { total: 8, payout: 10, message: "Hard 8 wins!" },
        hard10: { total: 10, payout: 8, message: "Hard 10 wins!" }
    });

    const PLACE_BETS = Object.freeze({
        place4: { total: 4, numerator: 9, denominator: 5, message: "Place 4 wins!" },
        place5: { total: 5, numerator: 7, denominator: 5, message: "Place 5 wins!" },
        place6: { total: 6, numerator: 7, denominator: 6, message: "Place 6 wins!" },
        place8: { total: 8, numerator: 7, denominator: 6, message: "Place 8 wins!" },
        place9: { total: 9, numerator: 7, denominator: 5, message: "Place 9 wins!" },
        place10: { total: 10, numerator: 9, denominator: 5, message: "Place 10 wins!" }
    });

    function getBetUnit(betType) {
        return betType === "place6" || betType === "place8" ? 6 : 5;
    }

    function validateBetAmount(betType, amount, balance) {
        const unit = getBetUnit(betType);
        if (!Number.isInteger(amount) || amount < unit) {
            return `Minimum bet is $${unit}`;
        }
        if (amount % unit !== 0) {
            return `Bet must be in $${unit} increments`;
        }
        if (amount > balance) {
            return "Not enough balance";
        }
        return "";
    }

    function getOddsPayout(point, isPass) {
        if (isPass) {
            if (point === 4 || point === 10) return 2;
            if (point === 5 || point === 9) return 1.5;
            return 1.2;
        }
        if (point === 4 || point === 10) return 0.5;
        if (point === 5 || point === 9) return 2 / 3;
        return 5 / 6;
    }

    function getMaxOddsAmount(amount, point) {
        return amount * (ODDS_MULTIPLIERS[point] || 0);
    }

    function calculateOddsToAdd({ point, amount, odds = 0, balance = 0, multiplier }) {
        if (!point || amount === 0) return 0;
        const maxAmount = getMaxOddsAmount(amount, point);
        const requestedAmount = multiplier === "max" ? maxAmount : amount * multiplier;
        const available = Math.min(requestedAmount, maxAmount - odds, balance);
        return available >= 5 ? available : 0;
    }

    function emptyResolution(bets) {
        return {
            bets: { ...bets },
            winnings: 0,
            resolvedStake: 0,
            messages: []
        };
    }

    function resolveOneRollBets(bets, total) {
        const result = emptyResolution(bets);
        Object.entries(ONE_ROLL_BETS).forEach(([betType, config]) => {
            const amount = Number(bets[betType] || 0);
            if (amount <= 0) return;

            result.resolvedStake += amount;
            if (config.wins(total)) {
                result.winnings += amount * config.payout(total);
                result.messages.push(config.message);
            }
            result.bets[betType] = 0;
        });
        return result;
    }

    function resolveHardwayBets(bets, total, isHard) {
        const result = emptyResolution(bets);
        Object.entries(HARDWAY_BETS).forEach(([betType, config]) => {
            const amount = Number(bets[betType] || 0);
            if (amount <= 0) return;

            if (total === config.total && isHard) {
                result.resolvedStake += amount;
                result.winnings += amount * config.payout;
                result.messages.push(config.message);
                result.bets[betType] = 0;
            } else if (total === config.total || total === 7) {
                result.resolvedStake += amount;
                result.bets[betType] = 0;
            }
        });
        return result;
    }

    function resolvePlaceBetWins(bets, total) {
        const result = emptyResolution(bets);
        Object.entries(PLACE_BETS).forEach(([betType, config]) => {
            const amount = Number(bets[betType] || 0);
            if (amount <= 0 || total !== config.total) return;

            result.winnings += Math.floor(amount * config.numerator / config.denominator) + amount;
            result.messages.push(config.message);
        });
        return result;
    }

    function resolvePlaceBetsOnSeven(bets) {
        const result = emptyResolution(bets);
        Object.keys(PLACE_BETS).forEach((betType) => {
            const amount = Number(bets[betType] || 0);
            if (amount <= 0) return;

            result.resolvedStake += amount;
            result.bets[betType] = 0;
        });
        return result;
    }

    return {
        BET_NAMES,
        ODDS_MULTIPLIERS,
        calculateOddsToAdd,
        getBetUnit,
        getMaxOddsAmount,
        getOddsPayout,
        resolveHardwayBets,
        resolveOneRollBets,
        resolvePlaceBetsOnSeven,
        resolvePlaceBetWins,
        validateBetAmount
    };
});
