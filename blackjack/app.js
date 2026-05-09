(function () {
    const game = window.BlackjackGame;
    let state = game.createState();
    let previousUi = {
        balance: null,
        bet: null,
        shoe: null,
        status: null
    };
    let previousCardSlots = new Map();
    let currentCardSlots = new Map();
    let fallbackDealIndex = 0;

    const els = {
        actionControls: document.getElementById("actionControls"),
        activeHandLabel: document.getElementById("activeHandLabel"),
        balance: document.getElementById("balance"),
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

    function isRoundHiddenDealerCard() {
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
        if (ordered !== undefined) return ordered * 130;
        const delay = fallbackDealIndex * 130;
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
        els.dealerCards.innerHTML = state.dealerHand.length
            ? state.dealerHand.map((card, index) => renderCard(card, hideHole && index === 1, `dealer-card-${index}`)).join("")
            : '<div class="empty-slot"></div><div class="empty-slot"></div>';

        if (!state.dealerHand.length) {
            els.dealerTotal.textContent = "";
            return;
        }

        if (hideHole) {
            els.dealerTotal.textContent = String(game.handValue([state.dealerHand[0]]).total);
            return;
        }

        const dealerValue = game.handValue(state.dealerHand);
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
                handResultLabel(hand),
                "</div>",
                "</article>"
            ].join("");
        }).join("");

        const hand = game.activeHand(state) || state.playerHands[0];
        els.activeHandLabel.textContent = hand ? `Bet ${game.formatMoney(hand.bet)}` : `Bet ${game.formatMoney(state.currentBet)}`;
    }

    function renderControls() {
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
        const balanceText = game.formatMoney(state.balance);
        const betText = game.formatMoney(state.currentBet);
        const shoeText = String(state.shoe.length);
        const statusText = state.balance < state.rules.minBet && state.status !== "playing"
            ? "Out of chips. Reset bankroll to play again."
            : state.message;

        els.balance.textContent = balanceText;
        els.shoeCount.textContent = shoeText;
        els.statusText.textContent = statusText;
        renderDealer();
        renderHands();
        renderControls();

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

        if (window.lucide?.createIcons) {
            window.lucide.createIcons();
        }

        previousCardSlots = currentCardSlots;
    }

    function updateBet(amount) {
        state = game.setBet(state, amount);
        render();
    }

    document.querySelectorAll("[data-chip]").forEach((button) => {
        button.addEventListener("click", () => updateBet(Number(button.dataset.chip)));
    });

    els.betDownButton.addEventListener("click", () => updateBet(state.currentBet - 5));
    els.betUpButton.addEventListener("click", () => updateBet(state.currentBet + 5));
    els.dealButton.addEventListener("click", () => {
        state = game.startRound(state);
        render();
    });
    els.hitButton.addEventListener("click", () => {
        state = game.hit(state);
        render();
    });
    els.standButton.addEventListener("click", () => {
        state = game.stand(state);
        render();
    });
    els.doubleButton.addEventListener("click", () => {
        state = game.doubleDown(state);
        render();
    });
    els.splitButton.addEventListener("click", () => {
        state = game.split(state);
        render();
    });
    els.insuranceButton.addEventListener("click", () => {
        state = game.takeInsurance(state);
        render();
    });
    els.declineInsuranceButton.addEventListener("click", () => {
        state = game.declineInsurance(state);
        render();
    });
    els.newShoeButton.addEventListener("click", () => {
        state = game.newShoe(state);
        render();
    });
    els.resetButton.addEventListener("click", () => {
        state = game.resetBankroll(state);
        render();
    });

    render();
})();
