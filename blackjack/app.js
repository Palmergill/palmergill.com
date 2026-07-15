(function () {
    const game = window.BlackjackGame;
    const profile = window.CasinoProfile || null;
    const initialBankroll = profile ? profile.getBankroll() : undefined;
    let state = game.createState(
        initialBankroll !== undefined ? { bankroll: initialBankroll } : {}
    );
    let balanceBeforeRound = state.balance;
    // True while this page is writing its own bankroll/session update to
    // CasinoProfile. Profile writes notify listeners synchronously
    // (including this page's own syncBalanceFromProfile), and without this
    // guard that re-entrant call would read back the write-in-flight value
    // and stomp the balance/message this same applyAction() just computed.
    let isPersistingOwnBankroll = false;
    const shoeStats = { wins: 0, losses: 0, pushes: 0, dealerBusts: 0, rounds: 0 };
    let previousUi = {
        balance: null,
        bet: null,
        shoe: null,
        status: null
    };
    let previousCardSlots = new Map();
    let currentCardSlots = new Map();
    let fallbackDealIndex = 0;
    let dealerAnimation = null;
    let dealerAnimationToken = 0;

    const DEALER_REVEAL_PAUSE_MS = 1400;
    const DEALER_HIT_PAUSE_MS = 1900;
    const DEALER_SETTLE_PAUSE_MS = 1300;

    const els = {
        actionControls: document.getElementById("actionControls"),
        activeHandLabel: document.getElementById("activeHandLabel"),
        balance: document.getElementById("balance"),
        statWins: document.getElementById("statWins"),
        statLosses: document.getElementById("statLosses"),
        statPushes: document.getElementById("statPushes"),
        statDealerBust: document.getElementById("statDealerBust"),
        statHiLo: document.getElementById("statHiLo"),
        countTile: document.getElementById("countTile"),
        countToggleButton: document.getElementById("countToggleButton"),
        strategyToggleButton: document.getElementById("strategyToggleButton"),
        betAmount: document.getElementById("betAmount"),
        bettingControls: document.getElementById("bettingControls"),
        betDownButton: document.getElementById("betDownButton"),
        betUpButton: document.getElementById("betUpButton"),
        dealButton: document.getElementById("dealButton"),
        dealerCards: document.getElementById("dealerCards"),
        dealerTotal: document.getElementById("dealerTotal"),
        declineInsuranceButton: document.getElementById("declineInsuranceButton"),
        doubleButton: document.getElementById("doubleButton"),
        hitButton: document.getElementById("hitButton"),
        insuranceButton: document.getElementById("insuranceButton"),
        insuranceControls: document.getElementById("insuranceControls"),
        newShoeButton: document.getElementById("newShoeButton"),
        playerHands: document.getElementById("playerHands"),
        resetButton: document.getElementById("resetButton"),
        shoeCount: document.getElementById("shoeCount"),
        splitButton: document.getElementById("splitButton"),
        standButton: document.getElementById("standButton"),
        statusText: document.getElementById("statusText")
    };

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function renderShoeStats() {
        if (!els.statWins) return;
        els.statWins.textContent = shoeStats.wins;
        els.statLosses.textContent = shoeStats.losses;
        els.statPushes.textContent = shoeStats.pushes;
        const pct = shoeStats.rounds === 0
            ? "0%"
            : Math.round((shoeStats.dealerBusts / shoeStats.rounds) * 100) + "%";
        els.statDealerBust.textContent = pct;
    }

    // Basic strategy lookup. dealerKey ∈ {2..10, "A"}. Player keys: hard total,
    // soft total (with usable ace), or pair rank.
    const BASIC_STRATEGY = {
        pairs: {
            "A": "Y Y Y Y Y Y Y Y Y Y".split(" "),
            "10": "N N N N N N N N N N".split(" "),
            "9": "Y Y Y Y Y N Y Y N N".split(" "),
            "8": "Y Y Y Y Y Y Y Y Y Y".split(" "),
            "7": "Y Y Y Y Y Y N N N N".split(" "),
            "6": "Y Y Y Y Y N N N N N".split(" "),
            "5": "N N N N N N N N N N".split(" "),
            "4": "N N N Y Y N N N N N".split(" "),
            "3": "Y Y Y Y Y Y N N N N".split(" "),
            "2": "Y Y Y Y Y Y N N N N".split(" "),
        },
        soft: {
            20: "S S S S S S S S S S".split(" "),
            19: "S S S S DS S S S S S".split(" "),
            18: "DS DS DS DS DS S S H H H".split(" "),
            17: "H D D D D H H H H H".split(" "),
            16: "H H D D D H H H H H".split(" "),
            15: "H H D D D H H H H H".split(" "),
            14: "H H H D D H H H H H".split(" "),
            13: "H H H D D H H H H H".split(" "),
        },
        hard: {
            17: "S S S S S S S S S S".split(" "),
            16: "S S S S S H H H H H".split(" "),
            15: "S S S S S H H H H H".split(" "),
            14: "S S S S S H H H H H".split(" "),
            13: "S S S S S H H H H H".split(" "),
            12: "H H S S S H H H H H".split(" "),
            11: "D D D D D D D D D D".split(" "),
            10: "D D D D D D D D H H".split(" "),
            9:  "H D D D D H H H H H".split(" "),
            8:  "H H H H H H H H H H".split(" "),
        }
    };

    function dealerKeyIndex(card) {
        if (!card) return -1;
        const r = card.rank;
        if (r === "A") return 9;
        if (r === "K" || r === "Q" || r === "J" || r === "10") return 8;
        return Number(r) - 2;
    }

    function recommendAction(hand, dealerUpCard, canSplitHand, canDoubleHand) {
        if (!hand || hand.cards.length < 2 || !dealerUpCard) return null;
        const idx = dealerKeyIndex(dealerUpCard);
        if (idx < 0) return null;
        const cards = hand.cards;

        if (canSplitHand && cards.length === 2 && cards[0].rank === cards[1].rank) {
            const rankKey = ["K","Q","J"].includes(cards[0].rank) ? "10" : cards[0].rank;
            const row = BASIC_STRATEGY.pairs[rankKey];
            if (row && row[idx] === "Y") return "split";
        }

        const value = game.handValue(cards);
        if (value.soft && value.total >= 13 && value.total <= 20) {
            const row = BASIC_STRATEGY.soft[value.total];
            if (row) {
                const code = row[idx];
                if (code === "DS") return canDoubleHand ? "double" : "stand";
                if (code === "D") return canDoubleHand ? "double" : (value.total === 18 && idx <= 1 ? "stand" : "hit");
                if (code === "S") return "stand";
                return "hit";
            }
        }

        let row = BASIC_STRATEGY.hard[value.total];
        if (!row && value.total >= 17) row = BASIC_STRATEGY.hard[17];
        if (!row && value.total <= 8) row = BASIC_STRATEGY.hard[8];
        if (!row) return null;
        const code = row[idx];
        if (code === "D") return canDoubleHand ? "double" : "hit";
        if (code === "DS") return canDoubleHand ? "double" : "stand";
        if (code === "S") return "stand";
        return "hit";
    }

    let strategyVisible = false;
    try { strategyVisible = localStorage.getItem("blackjack-strategy-visible") === "true"; } catch {}

    function clearRecommendation() {
        [els.hitButton, els.standButton, els.doubleButton, els.splitButton].forEach((b) => {
            if (b) b.classList.remove("is-recommended");
        });
    }

    function renderStrategyHint() {
        clearRecommendation();
        if (els.strategyToggleButton) {
            els.strategyToggleButton.setAttribute("aria-pressed", strategyVisible ? "true" : "false");
            els.strategyToggleButton.textContent = strategyVisible ? "Hide hint" : "Strategy hint";
        }
        if (!strategyVisible) return;
        if (state.status !== "playing") return;
        const hand = state.playerHands[state.activeHandIndex];
        if (!hand || hand.stood || hand.result) return;
        const action = recommendAction(
            hand,
            state.dealerHand[0],
            game.canSplit ? game.canSplit(state) : (game.canSplitHand ? game.canSplitHand(state, hand) : false),
            game.canDoubleHand ? game.canDoubleHand(state, hand) : (state.balance >= hand.bet && hand.cards.length === 2)
        );
        const map = { hit: els.hitButton, stand: els.standButton, double: els.doubleButton, split: els.splitButton };
        const btn = map[action];
        if (btn && !btn.disabled) btn.classList.add("is-recommended");
    }

    function hiLoValue(card) {
        if (!card) return 0;
        const r = card.rank;
        if (r === "A" || r === "K" || r === "Q" || r === "J" || r === "10") return -1;
        if (r === "7" || r === "8" || r === "9") return 0;
        return 1;
    }

    function runningCount() {
        let count = 0;
        state.playerHands.forEach((h) => h.cards.forEach((c) => count += hiLoValue(c)));
        const hideHole = isRoundHiddenDealerCard();
        state.dealerHand.forEach((card, idx) => {
            if (hideHole && idx === 1) return;
            count += hiLoValue(card);
        });
        return count;
    }

    let countVisible = false;
    try { countVisible = localStorage.getItem("blackjack-count-visible") === "true"; } catch {}

    function renderHiLo() {
        if (!els.countTile) return;
        els.countTile.hidden = !countVisible;
        els.countToggleButton?.setAttribute("aria-pressed", countVisible ? "true" : "false");
        if (els.countToggleButton) els.countToggleButton.textContent = countVisible ? "Hide count" : "Show count";
        if (!countVisible) return;
        const c = runningCount();
        const sign = c > 0 ? "+" : "";
        els.statHiLo.textContent = sign + c;
        els.statHiLo.classList.remove("is-positive", "is-negative");
        if (c > 0) els.statHiLo.classList.add("is-positive");
        else if (c < 0) els.statHiLo.classList.add("is-negative");
    }

    function resetShoeStats() {
        shoeStats.wins = 0;
        shoeStats.losses = 0;
        shoeStats.pushes = 0;
        shoeStats.dealerBusts = 0;
        shoeStats.rounds = 0;
        renderShoeStats();
        renderHiLo();
    }

    function cloneState(source) {
        return JSON.parse(JSON.stringify(source));
    }

    function cancelDealerAnimation() {
        dealerAnimationToken += 1;
        dealerAnimation = null;
    }

    function isRoundHiddenDealerCard() {
        if (dealerAnimation) return !dealerAnimation.holeRevealed;
        return state.status === "playing" || state.status === "insurance";
    }

    function initialDealOrder(slotKey) {
        const order = {
            "player-0-card-0": 0,
            "dealer-card-0": 1,
            "player-0-card-1": 2,
            "dealer-card-1": 3
        };
        return order[slotKey];
    }

    function dealDelay(slotKey) {
        const ordered = initialDealOrder(slotKey);
        if (ordered !== undefined) return ordered * 280;
        const delay = fallbackDealIndex * 280;
        fallbackDealIndex += 1;
        return delay;
    }

    function renderCard(card, hidden = false, slotKey = "") {
        const signature = hidden ? `${slotKey}:hidden` : `${slotKey}:${card.rank}:${card.suit}`;
        const previousSignature = previousCardSlots.get(slotKey);
        const isReveal = previousSignature && previousSignature !== signature && previousSignature.endsWith(":hidden");
        const shouldDeal = !previousCardSlots.has(slotKey) || (previousSignature !== signature && !isReveal);
        const animationClass = shouldDeal ? "deal-card" : (isReveal ? "reveal-card" : "settled-card");
        const delay = shouldDeal ? ` style="--deal-delay: ${dealDelay(slotKey)}ms"` : "";
        currentCardSlots.set(slotKey, signature);

        if (hidden) {
            return `<div class="card card-back ${animationClass}" aria-label="Hidden card"${delay}></div>`;
        }

        const red = card.suit === "hearts" || card.suit === "diamonds";
        return [
            `<div class="card ${red ? "red" : "black"} ${animationClass}"${delay}>`,
            `<span>${card.rank}</span>`,
            `<strong>${game.cardPip(card).replace(card.rank, "")}</strong>`,
            `<span>${card.rank}</span>`,
            "</div>"
        ].join("");
    }

    function handResultLabel(hand) {
        if (!hand.result) return "";
        const labels = {
            blackjack: "Blackjack",
            lose: "Lose",
            push: "Push",
            win: "Win"
        };
        return `<span class="result-pill ${hand.result}">${labels[hand.result]}</span>`;
    }

    function renderDealer() {
        const hideHole = isRoundHiddenDealerCard();
        const dealerHand = dealerAnimation
            ? state.dealerHand.slice(0, dealerAnimation.visibleDealerCount)
            : state.dealerHand;

        els.dealerCards.innerHTML = dealerHand.length
            ? dealerHand.map((card, index) => renderCard(card, hideHole && index === 1, `dealer-card-${index}`)).join("")
            : '<div class="empty-slot"></div><div class="empty-slot"></div>';

        if (!dealerHand.length) {
            els.dealerTotal.textContent = "";
            return;
        }

        if (hideHole) {
            els.dealerTotal.textContent = String(game.handValue([dealerHand[0]]).total);
            return;
        }

        const dealerValue = game.handValue(dealerHand);
        els.dealerTotal.textContent = dealerValue.bust ? "Bust" : String(dealerValue.total);
    }

    function renderHands() {
        if (!state.playerHands.length) {
            els.playerHands.innerHTML = '<div class="hand-panel empty-hand"><div class="empty-slot"></div><div class="empty-slot"></div></div>';
            els.activeHandLabel.textContent = `Bet ${game.formatMoney(state.currentBet)}`;
            return;
        }

        els.playerHands.innerHTML = state.playerHands.map((hand, index) => {
            const value = game.handValue(hand.cards);
            const active = state.status === "playing" && index === state.activeHandIndex && !hand.stood && !hand.result;
            return [
                `<article class="hand-panel ${active ? "active" : ""}">`,
                '<div class="hand-meta">',
                `<span>Hand ${index + 1}</span>`,
                `<strong>${value.bust ? "Bust" : value.total}${value.soft && !value.bust ? " soft" : ""}</strong>`,
                "</div>",
                `<div class="cards">${hand.cards.map((card, cardIndex) => renderCard(card, false, `player-${index}-card-${cardIndex}`)).join("")}</div>`,
                '<div class="hand-footer">',
                `<span>${game.formatMoney(hand.bet)}${hand.doubled ? " doubled" : ""}</span>`,
                dealerAnimation ? "" : handResultLabel(hand),
                "</div>",
                "</article>"
            ].join("");
        }).join("");

        const hand = game.activeHand(state) || state.playerHands[0];
        els.activeHandLabel.textContent = hand ? `Bet ${game.formatMoney(hand.bet)}` : `Bet ${game.formatMoney(state.currentBet)}`;
    }

    function renderControls() {
        if (dealerAnimation) {
            els.bettingControls.hidden = true;
            els.insuranceControls.hidden = true;
            els.actionControls.hidden = true;
            return;
        }

        const betting = state.status === "betting" || state.status === "roundOver";
        const insurance = state.status === "insurance";
        const playing = state.status === "playing";
        const hand = game.activeHand(state);

        els.bettingControls.hidden = !betting;
        els.insuranceControls.hidden = !insurance;
        els.actionControls.hidden = !playing;

        els.betAmount.textContent = game.formatMoney(state.currentBet);
        els.betDownButton.disabled = state.currentBet <= state.rules.minBet;
        els.betUpButton.disabled = state.currentBet >= Math.min(state.rules.maxBet, state.balance);
        els.dealButton.disabled = state.balance < state.currentBet || state.currentBet < state.rules.minBet;

        els.hitButton.disabled = !playing || !hand || hand.isSplitAces;
        els.standButton.disabled = !playing || !hand;
        els.doubleButton.disabled = !game.canDoubleHand(state, hand);
        els.splitButton.disabled = !game.canSplit(state, hand);
        els.insuranceButton.disabled = !insurance || state.balance < ((state.playerHands[0]?.bet || 0) / 2);

        document.querySelectorAll("[data-chip]").forEach((button) => {
            button.classList.toggle("selected", Number(button.dataset.chip) === state.currentBet);
        });
    }

    function pulse(element, className) {
        element.classList.remove(className);
        void element.offsetWidth;
        element.classList.add(className);
    }

    function render() {
        currentCardSlots = new Map();
        fallbackDealIndex = 0;
        renderHiLo();
        const balanceText = game.formatMoney(state.balance);
        const betText = game.formatMoney(state.currentBet);
        const shoeText = String(state.shoe.length);
        const statusText = dealerAnimation?.message || (state.balance < state.rules.minBet && state.status !== "playing"
            ? "Out of chips. Reset bankroll to play again."
            : state.message);

        els.balance.textContent = balanceText;
        els.shoeCount.textContent = shoeText;
        els.statusText.textContent = statusText;
        renderDealer();
        renderHands();
        renderControls();
        renderStrategyHint();

        if (previousUi.balance !== null && previousUi.balance !== balanceText) pulse(els.balance, "value-pop");
        if (previousUi.bet !== null && previousUi.bet !== betText) pulse(els.betAmount, "value-pop");
        if (previousUi.shoe !== null && previousUi.shoe !== shoeText) pulse(els.shoeCount, "value-pop");
        if (previousUi.status !== null && previousUi.status !== statusText) pulse(els.statusText, "message-pop");

        previousUi = {
            balance: balanceText,
            bet: betText,
            shoe: shoeText,
            status: statusText
        };

        previousCardSlots = currentCardSlots;
    }

    function shouldAnimateDealerTurn(previousState, nextState) {
        if (previousState.status !== "playing" || nextState.status !== "roundOver") return false;
        if (nextState.dealerHand.length < 2) return false;

        return nextState.playerHands.some((hand) => !game.handValue(hand.cards).bust);
    }

    function dealerStatusMessage() {
        const visibleCards = state.dealerHand.slice(0, dealerAnimation.visibleDealerCount);
        const value = game.handValue(visibleCards);

        if (!dealerAnimation.holeRevealed) return "Dealer turns over the hole card.";
        if (value.bust) return `Dealer busts with ${value.total}.`;
        if (dealerAnimation.visibleDealerCount < state.dealerHand.length) return `Dealer has ${value.total}. Taking another card...`;
        return `Dealer stands on ${value.total}.`;
    }

    async function animateDealerTurn() {
        const token = dealerAnimationToken + 1;
        dealerAnimationToken = token;
        dealerAnimation = {
            holeRevealed: false,
            visibleDealerCount: Math.min(2, state.dealerHand.length),
            message: "Dealer checks the hole card..."
        };
        render();

        await sleep(DEALER_REVEAL_PAUSE_MS);
        if (token !== dealerAnimationToken) return;
        dealerAnimation.holeRevealed = true;
        dealerAnimation.message = dealerStatusMessage();
        render();

        while (dealerAnimation.visibleDealerCount < state.dealerHand.length) {
            await sleep(DEALER_HIT_PAUSE_MS);
            if (token !== dealerAnimationToken) return;
            dealerAnimation.visibleDealerCount += 1;
            dealerAnimation.message = dealerStatusMessage();
            render();
        }

        await sleep(DEALER_SETTLE_PAUSE_MS);
        if (token !== dealerAnimationToken) return;
        dealerAnimation = null;
        render();
    }

    function applyAction(action) {
        if (dealerAnimation) return;
        const previousState = cloneState(state);
        state = action(state);

        if (previousState.status === "betting" && state.status !== "betting") {
            balanceBeforeRound = previousState.balance;
        }

        isPersistingOwnBankroll = true;
        try {
            if (profile) profile.setBankroll(state.balance);

            if (previousState.status !== "roundOver" && state.status === "roundOver") {
                const delta = state.balance - balanceBeforeRound;
                state.playerHands.forEach((hand) => {
                    if (hand.result === "win" || hand.result === "blackjack") shoeStats.wins++;
                    else if (hand.result === "lose") shoeStats.losses++;
                    else if (hand.result === "push") shoeStats.pushes++;
                });
                if (game.handValue(state.dealerHand).bust) shoeStats.dealerBusts++;
                shoeStats.rounds++;
                renderShoeStats();
                if (profile) {
                    profile.recordSession("blackjack", {
                        handsPlayed: state.playerHands.length || 1,
                        netProfit: delta,
                        biggestWin: Math.max(0, delta)
                    });
                }
                window.pgAnalytics?.track?.("blackjack_round_completed", {
                    balance: state.balance,
                    results: state.playerHands.map((hand) => hand.result || "unknown"),
                    dealer_total: game.handValue(state.dealerHand).total,
                });
            }
        } finally {
            isPersistingOwnBankroll = false;
        }

        if (shouldAnimateDealerTurn(previousState, state)) {
            // Catch rejections so a thrown animation step doesn't leave an
            // unhandled promise and a half-rendered dealer.
            animateDealerTurn().catch((err) => {
                console.error("Dealer animation failed", err);
                dealerAnimation = null;
                render();
            });
            return;
        }

        render();
    }

    function updateBet(amount) {
        if (dealerAnimation) return;
        state = game.setBet(state, amount);
        render();
    }

    function syncBalanceFromProfile() {
        if (!profile || isPersistingOwnBankroll) return;
        const nextBalance = profile.getBankroll();
        if (nextBalance === state.balance) return;
        cancelDealerAnimation();
        state.balance = nextBalance;
        if (state.status !== "playing") {
            state.currentBet = Math.min(
                state.rules.maxBet,
                Math.max(state.rules.minBet, Math.min(state.currentBet, state.balance))
            );
            state.message = state.balance < state.rules.minBet
                ? "Out of chips. Reset bankroll to play again."
                : "Bankroll updated.";
        }
        balanceBeforeRound = state.balance;
        render();
    }

    document.querySelectorAll("[data-chip]").forEach((button) => {
        button.addEventListener("click", () => updateBet(Number(button.dataset.chip)));
    });

    els.betDownButton.addEventListener("click", () => updateBet(state.currentBet - 5));
    els.betUpButton.addEventListener("click", () => updateBet(state.currentBet + 5));
    els.dealButton.addEventListener("click", () => {
        window.pgAnalytics?.track?.("blackjack_round_started", { bet: state.currentBet });
        applyAction((currentState) => game.startRound(currentState));
    });
    els.hitButton.addEventListener("click", () => {
        applyAction((currentState) => game.hit(currentState));
    });
    els.standButton.addEventListener("click", () => {
        applyAction((currentState) => game.stand(currentState));
    });
    els.doubleButton.addEventListener("click", () => {
        applyAction((currentState) => game.doubleDown(currentState));
    });
    els.splitButton.addEventListener("click", () => {
        applyAction((currentState) => game.split(currentState));
    });
    els.insuranceButton.addEventListener("click", () => {
        applyAction((currentState) => game.takeInsurance(currentState));
    });
    els.declineInsuranceButton.addEventListener("click", () => {
        applyAction((currentState) => game.declineInsurance(currentState));
    });
    els.newShoeButton.addEventListener("click", () => {
        window.pgAnalytics?.track?.("blackjack_new_shoe");
        cancelDealerAnimation();
        state = game.newShoe(state);
        resetShoeStats();
        render();
    });
    els.resetButton.addEventListener("click", () => {
        cancelDealerAnimation();
        state = game.resetBankroll(state);
        balanceBeforeRound = state.balance;
        isPersistingOwnBankroll = true;
        try {
            if (profile) profile.setBankroll(state.balance);
        } finally {
            isPersistingOwnBankroll = false;
        }
        resetShoeStats();
        render();
    });

    if (profile) profile.onChange(syncBalanceFromProfile);

    if (els.countToggleButton) {
        els.countToggleButton.addEventListener("click", () => {
            countVisible = !countVisible;
            try { localStorage.setItem("blackjack-count-visible", String(countVisible)); } catch {}
            renderHiLo();
        });
    }
    if (els.strategyToggleButton) {
        els.strategyToggleButton.addEventListener("click", () => {
            strategyVisible = !strategyVisible;
            try { localStorage.setItem("blackjack-strategy-visible", String(strategyVisible)); } catch {}
            renderStrategyHint();
        });
    }

    renderShoeStats();
    renderHiLo();
    render();
})();
