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
    let dealerAnimation = null;
    let dealerAnimationToken = 0;

    const DEALER_REVEAL_PAUSE_MS = 700;
    const DEALER_HIT_PAUSE_MS = 1050;
    const DEALER_SETTLE_PAUSE_MS = 750;

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

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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

        if (shouldAnimateDealerTurn(previousState, state)) {
            animateDealerTurn();
            return;
        }

        render();
    }

    function updateBet(amount) {
        if (dealerAnimation) return;
        state = game.setBet(state, amount);
        render();
    }

    document.querySelectorAll("[data-chip]").forEach((button) => {
        button.addEventListener("click", () => updateBet(Number(button.dataset.chip)));
    });

    els.betDownButton.addEventListener("click", () => updateBet(state.currentBet - 5));
    els.betUpButton.addEventListener("click", () => updateBet(state.currentBet + 5));
    els.dealButton.addEventListener("click", () => {
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
        cancelDealerAnimation();
        state = game.newShoe(state);
        render();
    });
    els.resetButton.addEventListener("click", () => {
        cancelDealerAnimation();
        state = game.resetBankroll(state);
        render();
    });

    render();
})();
