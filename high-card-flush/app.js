(function () {
    "use strict";

    const game = window.HighCardFlushGame;
    if (!game) return;

    const profile = window.CasinoProfile || null;
    let state = game.createState({ bankroll: profile ? profile.getBankroll() : game.DEFAULTS.bankroll });
    let strategyEnabled = false;
    let isPersistingOwnBankroll = false;
    let lastRecordedRound = 0;
    const session = { hands: 0, wins: 0, folds: 0, net: 0 };

    const els = {
        dealerCards: document.getElementById("dealerCards"),
        playerCards: document.getElementById("playerCards"),
        dealerHandLabel: document.getElementById("dealerHandLabel"),
        playerHandLabel: document.getElementById("playerHandLabel"),
        statusText: document.getElementById("statusText"),
        tableAnte: document.getElementById("tableAnte"),
        tableRaise: document.getElementById("tableRaise"),
        wagerPanel: document.getElementById("wagerPanel"),
        decisionPanel: document.getElementById("decisionPanel"),
        settlementPanel: document.getElementById("settlementPanel"),
        wagerHelp: document.getElementById("wagerHelp"),
        raiseHelp: document.getElementById("raiseHelp"),
        anteAmount: document.getElementById("anteAmount"),
        flushBonusAmount: document.getElementById("flushBonusAmount"),
        straightFlushBonusAmount: document.getElementById("straightFlushBonusAmount"),
        dealButton: document.getElementById("dealButton"),
        foldButton: document.getElementById("foldButton"),
        newRoundButton: document.getElementById("newRoundButton"),
        resetButton: document.getElementById("resetButton"),
        strategyToggle: document.getElementById("strategyToggle"),
        hintPanel: document.getElementById("hintPanel"),
        settlementTitle: document.getElementById("settlementTitle"),
        settlementSummary: document.getElementById("settlementSummary"),
        settlementBreakdown: document.getElementById("settlementBreakdown"),
        statHands: document.getElementById("statHands"),
        statWins: document.getElementById("statWins"),
        statFolds: document.getElementById("statFolds"),
        statNet: document.getElementById("statNet")
    };

    const SUIT_SYMBOLS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
    const SUIT_ORDER = Object.fromEntries(game.SUITS.map((suit, index) => [suit, index]));
    const SUIT_NAMES = { spades: "spades", hearts: "hearts", diamonds: "diamonds", clubs: "clubs" };
    const RANK_NAMES = {
        A: "ace", K: "king", Q: "queen", J: "jack", "10": "ten", "9": "nine",
        "8": "eight", "7": "seven", "6": "six", "5": "five", "4": "four",
        "3": "three", "2": "two"
    };

    function formatSigned(value) {
        const number = Number(value) || 0;
        if (number > 0) return `+${game.formatMoney(number)}`;
        if (number < 0) return game.formatMoney(number);
        return "$0";
    }

    function cardKey(card) {
        return `${card.rank}-${card.suit}`;
    }

    // Deal order hides the flushes, so the hand is grouped by suit with the
    // high card first inside each suit.
    function sortHand(cards) {
        return [...cards].sort((a, b) =>
            SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || game.cardValue(b) - game.cardValue(a));
    }

    function createCardElement(card, options = {}) {
        const element = document.createElement("div");
        element.className = "playing-card";

        if (options.empty) {
            element.classList.add("playing-card--empty");
            element.setAttribute("aria-hidden", "true");
            return element;
        }

        if (options.hidden) {
            element.classList.add("playing-card--back");
            element.setAttribute("aria-label", "Face-down card");
            return element;
        }

        if (card.suit === "hearts" || card.suit === "diamonds") element.classList.add("is-red");
        if (options.bestKeys && options.bestKeys.has(cardKey(card))) element.classList.add("is-best-flush");
        element.dataset.card = cardKey(card);
        element.setAttribute("aria-label", `${RANK_NAMES[card.rank]} of ${SUIT_NAMES[card.suit]}`);

        const corner = document.createElement("span");
        corner.className = "playing-card__corner";
        const rank = document.createElement("span");
        rank.textContent = card.rank;
        const cornerSuit = document.createElement("span");
        cornerSuit.textContent = SUIT_SYMBOLS[card.suit];
        corner.append(rank, cornerSuit);

        const suit = document.createElement("span");
        suit.className = "playing-card__suit";
        suit.setAttribute("aria-hidden", "true");
        suit.textContent = SUIT_SYMBOLS[card.suit];
        element.append(corner, suit);
        return element;
    }

    function renderCards(container, cards, options = {}) {
        if (!container) return;
        const fragment = document.createDocumentFragment();
        const bestKeys = new Set((options.evaluation?.cards || []).map(cardKey));
        if (!cards.length) {
            for (let i = 0; i < 7; i += 1) {
                fragment.appendChild(createCardElement(null, { empty: true }));
            }
        } else {
            cards.forEach((card) => {
                fragment.appendChild(createCardElement(card, {
                    hidden: options.hidden,
                    bestKeys
                }));
            });
        }
        container.replaceChildren(fragment);
    }

    function flushLabel(evaluation) {
        if (!evaluation) return "Waiting for the deal";
        return `${game.describeFlush(evaluation)} ${SUIT_NAMES[evaluation.suit]}`;
    }

    function renderHands() {
        // The dealer is shown after a fold too, so you can see what you dodged.
        const dealerRevealed = state.status === "roundOver";
        renderCards(els.playerCards, sortHand(state.playerCards), { evaluation: state.playerFlush });
        renderCards(els.dealerCards, dealerRevealed ? sortHand(state.dealerCards) : state.dealerCards, {
            hidden: state.dealerCards.length > 0 && !dealerRevealed,
            evaluation: dealerRevealed ? state.dealerFlush : null
        });

        els.playerHandLabel.textContent = state.playerFlush ? flushLabel(state.playerFlush) : "Waiting for the deal";
        if (!state.dealerCards.length) {
            els.dealerHandLabel.textContent = "Seven cards hidden";
        } else if (!dealerRevealed) {
            els.dealerHandLabel.textContent = "Decision pending";
        } else {
            const folded = state.decision === "fold";
            const qualifier = state.dealerQualified
                ? (folded ? "would have qualified" : "qualifies")
                : (folded ? "would not have qualified" : "does not qualify");
            els.dealerHandLabel.textContent = `${flushLabel(state.dealerFlush)} · ${qualifier}`;
        }
    }

    function renderWagers() {
        const validation = game.validateWagers(state);
        els.anteAmount.textContent = game.formatMoney(state.wagers.ante);
        els.flushBonusAmount.textContent = game.formatMoney(state.wagers.flushBonus);
        els.straightFlushBonusAmount.textContent = game.formatMoney(state.wagers.straightFlushBonus);
        els.tableAnte.textContent = game.formatMoney(state.wagers.ante);
        els.tableRaise.textContent = state.wagers.raise ? game.formatMoney(state.wagers.raise) : "—";

        if (state.status === "betting" && validation.valid) {
            els.wagerHelp.textContent = `${game.formatMoney(validation.initialStake)} placed on Deal; ${game.formatMoney(state.wagers.ante)} reserved for Raise.`;
        } else {
            els.wagerHelp.textContent = validation.message;
        }
        els.wagerHelp.classList.toggle("is-error", state.status === "betting" && !validation.valid);
        els.dealButton.disabled = state.status !== "betting" || !validation.valid;

        document.querySelectorAll("[data-wager][data-delta]").forEach((button) => {
            const type = button.dataset.wager;
            const delta = Number(button.dataset.delta);
            const value = state.wagers[type];
            const minimum = type === "ante" ? state.rules.minBet : 0;
            button.disabled = state.status !== "betting" ||
                (delta < 0 && value <= minimum) ||
                (delta > 0 && value >= state.rules.maxBet);
        });
    }

    function renderDecision() {
        const maximum = state.playerFlush ? game.maxRaiseMultiplier(state.playerFlush) : 1;
        els.raiseHelp.textContent = state.playerFlush
            ? `${state.playerFlush.length}-card flush allows up to a ${maximum}× Raise.`
            : "Choose a legal Raise for your flush.";

        document.querySelectorAll("[data-raise]").forEach((button) => {
            const multiplier = Number(button.dataset.raise);
            const amount = state.wagers.ante * multiplier;
            const amountEl = button.querySelector("small");
            if (amountEl) amountEl.textContent = game.formatMoney(amount);
            button.disabled = state.status !== "decision" || multiplier > maximum || state.balance < amount;
        });

        if (strategyEnabled && state.status === "decision") {
            const advice = game.strategyAdvice(state.playerFlush);
            const action = advice.action === "raise" ? `Raise ${advice.multiplier}×.` : "Fold.";
            els.hintPanel.textContent = `${action} ${advice.reason}`;
            els.hintPanel.hidden = false;
        } else {
            els.hintPanel.hidden = true;
        }
    }

    function resultText(profit, notPlayed = false) {
        if (notPlayed) return { text: "Not played", className: "" };
        if (profit > 0) return { text: `Won ${formatSigned(profit)}`, className: "is-win" };
        if (profit < 0) return { text: `Lost ${game.formatMoney(Math.abs(profit))}`, className: "is-loss" };
        return { text: "Push", className: "" };
    }

    function settlementItem(label, result) {
        const item = document.createElement("div");
        item.className = "settlement-item";
        const name = document.createElement("span");
        name.textContent = label;
        const value = document.createElement("strong");
        value.textContent = result.text;
        if (result.className) value.classList.add(result.className);
        item.append(name, value);
        return item;
    }

    function renderSettlement() {
        if (!state.settlement) {
            els.settlementBreakdown.replaceChildren();
            return;
        }
        const { base, bonuses } = state.settlement;
        const titles = {
            fold: "Hand folded",
            dealerNotQualified: "Dealer does not qualify",
            win: "Player wins",
            push: "Exact tie",
            lose: "Dealer wins"
        };
        els.settlementTitle.textContent = titles[base.result] || "Round settled";
        els.settlementSummary.textContent = state.message;

        const anteProfit = base.anteReturn - state.wagers.ante;
        const raiseProfit = state.wagers.raise ? base.raiseReturn - state.wagers.raise : 0;
        const netResult = resultText(state.netProfit);
        els.settlementBreakdown.replaceChildren(
            settlementItem("Ante", resultText(anteProfit)),
            settlementItem("Raise", resultText(raiseProfit, !state.wagers.raise)),
            settlementItem("Flush Bonus", resultText(bonuses.flush.profit, bonuses.flush.result === "notBet")),
            settlementItem("Straight Flush", resultText(bonuses.straightFlush.profit, bonuses.straightFlush.result === "notBet")),
            settlementItem("Round net", netResult)
        );
    }

    function renderStats() {
        els.statHands.textContent = session.hands.toLocaleString();
        els.statWins.textContent = session.wins.toLocaleString();
        els.statFolds.textContent = session.folds.toLocaleString();
        els.statNet.textContent = formatSigned(session.net);
        els.statNet.classList.toggle("is-positive", session.net > 0);
        els.statNet.classList.toggle("is-negative", session.net < 0);
    }

    function render() {
        if (!els.statusText) return;
        document.body.dataset.gameStatus = state.status;
        els.statusText.textContent = state.message;
        els.wagerPanel.hidden = state.status !== "betting";
        els.decisionPanel.hidden = state.status !== "decision";
        els.settlementPanel.hidden = state.status !== "roundOver";
        els.strategyToggle.setAttribute("aria-pressed", strategyEnabled ? "true" : "false");
        renderHands();
        renderWagers();
        renderDecision();
        renderSettlement();
        renderStats();
    }

    function persistBalance() {
        if (!profile) return;
        isPersistingOwnBankroll = true;
        try {
            profile.setBankroll(state.balance);
        } finally {
            isPersistingOwnBankroll = false;
        }
    }

    function recordCompletedRound() {
        if (state.status !== "roundOver" || state.round === lastRecordedRound) return;
        lastRecordedRound = state.round;
        session.hands += 1;
        session.net = Math.round((session.net + state.netProfit) * 100) / 100;
        if (["win", "dealerNotQualified"].includes(state.settlement.base.result)) session.wins += 1;
        if (state.settlement.base.result === "fold") session.folds += 1;

        isPersistingOwnBankroll = true;
        try {
            if (profile) {
                // Persist the final balance before recordSession(), whose
                // synchronous notification would otherwise read stale chips.
                profile.setBankroll(state.balance);
                profile.recordSession("high-card-flush", {
                    handsPlayed: 1,
                    netProfit: state.netProfit,
                    biggestWin: Math.max(0, state.netProfit)
                });
            }
        } finally {
            isPersistingOwnBankroll = false;
        }

        window.pgAnalytics?.track?.("high_card_flush_round_completed", {
            decision: state.decision,
            raise_multiplier: state.wagers.raise ? state.wagers.raise / state.wagers.ante : 0,
            player_flush_length: state.playerFlush.length,
            dealer_qualifies: state.decision === "raise" ? state.dealerQualified : null,
            result: state.settlement.base.result,
            flush_bonus_result: state.settlement.bonuses.flush.result,
            straight_flush_bonus_result: state.settlement.bonuses.straightFlush.result,
            net_profit: state.netProfit,
            balance: state.balance
        });
    }

    function setWager(type, delta) {
        if (state.status !== "betting") return;
        const minimum = type === "ante" ? state.rules.minBet : 0;
        const next = Math.min(state.rules.maxBet, Math.max(minimum, state.wagers[type] + delta));
        game.setWager(state, type, next);
        render();
    }

    function startRound() {
        const before = state.status;
        game.startRound(state);
        if (before === "betting" && state.status === "decision") {
            persistBalance();
            window.pgAnalytics?.track?.("high_card_flush_round_started", {
                ante: state.wagers.ante,
                flush_bonus: state.wagers.flushBonus,
                straight_flush_bonus: state.wagers.straightFlushBonus,
                balance: state.balance
            });
        }
        render();
    }

    function resolveRound(action) {
        if (state.status !== "decision") return;
        action();
        if (state.status === "roundOver") recordCompletedRound();
        render();
    }

    // An outside bankroll change (header Rebuy, another tab) patches the
    // balance in place rather than rebuilding state, so a dealt hand or an
    // unread settlement survives the update.
    function syncBalanceFromProfile() {
        if (!profile || isPersistingOwnBankroll) return;
        const nextBalance = profile.getBankroll();
        if (nextBalance === state.balance) return;

        const delta = nextBalance - state.balance;
        state.balance = nextBalance;
        if (state.roundStartBalance !== null) {
            // Shift the baseline too: the round's net is what the wagers won,
            // not what the outside deposit added.
            state.roundStartBalance = Math.round((state.roundStartBalance + delta) * 100) / 100;
        }
        if (state.status === "betting") {
            const validation = game.validateWagers(state);
            state.message = validation.valid ? "Bankroll updated. Set your wagers and deal." : validation.message;
        }
        render();
    }

    document.querySelectorAll("[data-wager][data-delta]").forEach((button) => {
        button.addEventListener("click", () => setWager(button.dataset.wager, Number(button.dataset.delta)));
    });
    document.querySelectorAll("[data-raise]").forEach((button) => {
        button.addEventListener("click", () => resolveRound(() => game.raise(state, Number(button.dataset.raise))));
    });

    els.dealButton.addEventListener("click", startRound);
    els.foldButton.addEventListener("click", () => resolveRound(() => game.fold(state)));
    els.newRoundButton.addEventListener("click", () => {
        game.newRound(state);
        render();
    });
    els.strategyToggle.addEventListener("click", () => {
        strategyEnabled = !strategyEnabled;
        render();
    });
    els.resetButton.addEventListener("click", () => {
        if (!window.confirm("Reset the shared casino bankroll to $1,000?")) return;
        isPersistingOwnBankroll = true;
        try {
            const balance = profile ? profile.resetBankroll() : game.DEFAULTS.bankroll;
            state = game.createState({ bankroll: balance });
            lastRecordedRound = 0;
        } finally {
            isPersistingOwnBankroll = false;
        }
        window.pgAnalytics?.track?.("high_card_flush_bankroll_reset");
        render();
    });

    let unsubscribe = () => {};
    if (profile) unsubscribe = profile.onChange(syncBalanceFromProfile);
    window.addEventListener("storage", (event) => {
        if (event.key && event.key.startsWith("casino-")) syncBalanceFromProfile();
    });
    window.addEventListener("pagehide", () => unsubscribe(), { once: true });

    render();
})();
