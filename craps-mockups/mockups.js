(function () {
    const boxNumbers = [4, 5, 6, 8, 9, 10];
    const chipColors = {
        1: ["#f3f0e8", "#101410"],
        5: ["#b91c1c", "#ffffff"],
        25: ["#177245", "#ffffff"],
        100: ["#111827", "#ffffff"],
        500: ["#5b21b6", "#ffffff"]
    };

    const state = {
        balance: 915,
        selectedChip: 5,
        phase: "POINT",
        point: 6,
        lastAction: null,
        lastBetSet: null,
        bets: {
            passLine: 25,
            passOdds: 50,
            dontPass: 0,
            come: 0,
            dontCome: 0,
            field: 0,
            place4: 0,
            place5: 0,
            place6: 0,
            place8: 0,
            place9: 0,
            place10: 0
        },
        comePoints: {
            8: { amount: 10, odds: 20 }
        }
    };

    const bankroll = document.getElementById("bankroll");
    const phaseText = document.getElementById("phaseText");
    const phaseHint = document.getElementById("phaseHint");
    const puck = document.getElementById("puck");
    const rollMessage = document.getElementById("rollMessage");
    const die1 = document.getElementById("die1");
    const die2 = document.getElementById("die2");
    const dice = document.querySelector(".dice");
    const propsSheet = document.getElementById("propsSheet");
    const propsButton = document.getElementById("propsButton");

    function money(value) {
        return "$" + value.toLocaleString();
    }

    function randDie() {
        const bytes = new Uint32Array(1);
        crypto.getRandomValues(bytes);
        return (bytes[0] % 6) + 1;
    }

    function setMessage(text) {
        rollMessage.textContent = text;
    }

    function saveLastBetSet() {
        state.lastBetSet = {
            bets: { ...state.bets },
            comePoints: JSON.parse(JSON.stringify(state.comePoints))
        };
    }

    function addBalance(delta) {
        state.balance += delta;
        bankroll.textContent = money(state.balance);
        bankroll.classList.remove("win-flash", "loss-flash");
        bankroll.offsetHeight;
        if (delta > 0) bankroll.classList.add("win-flash");
        if (delta < 0) bankroll.classList.add("loss-flash");
    }

    function getChipStyle(amount) {
        if (amount >= 500) return chipColors[500];
        if (amount >= 100) return chipColors[100];
        if (amount >= 25) return chipColors[25];
        if (amount >= 5) return chipColors[5];
        return chipColors[1];
    }

    function renderStack(key, amount, odds) {
        const stack = document.querySelector(`[data-stack="${key}"]`);
        if (!stack) return;
        stack.classList.remove("has-chip");
        stack.removeAttribute("data-amount");
        stack.removeAttribute("data-count");
        stack.style.removeProperty("--chip-color");
        stack.style.removeProperty("--chip-text");

        if (amount <= 0) return;
        const [color, text] = odds ? ["#c9a24b", "#161006"] : getChipStyle(amount);
        stack.classList.add("has-chip");
        stack.dataset.amount = money(amount);
        stack.dataset.count = String(Math.min(3, Math.max(1, Math.ceil(amount / 25))));
        stack.style.setProperty("--chip-color", color);
        stack.style.setProperty("--chip-text", text);
    }

    function updatePhase() {
        if (state.phase === "COME_OUT") {
            phaseText.textContent = "COME-OUT";
            phaseHint.textContent = "Puck off";
            puck.textContent = "OFF";
            puck.className = "puck off";
        } else {
            phaseText.textContent = "POINT " + state.point;
            phaseHint.textContent = "Puck on " + state.point;
            puck.textContent = "ON";
            puck.className = "puck on";
        }

        document.querySelectorAll(".box-zone").forEach((zone) => {
            const bet = zone.dataset.bet;
            const value = Number(bet.replace("place", ""));
            zone.classList.toggle("point-on", state.point === value);
        });
    }

    function updateStacks() {
        Object.entries(state.bets).forEach(([key, amount]) => {
            renderStack(key, amount, key.toLowerCase().includes("odds"));
        });
        boxNumbers.forEach((num) => {
            const come = state.comePoints[num] || { amount: 0, odds: 0 };
            renderStack("come" + num, come.amount, false);
            renderStack("come" + num + "Odds", come.odds, true);
        });
    }

    function update() {
        bankroll.textContent = money(state.balance);
        updatePhase();
        updateStacks();
        document.body.classList.toggle("house-edge", document.getElementById("edgeToggle").getAttribute("aria-pressed") === "true");
    }

    function canPlace(bet) {
        if ((bet === "come" || bet === "dontCome") && state.phase === "COME_OUT") {
            setMessage("Come bets open after a point is set.");
            return false;
        }
        if (state.selectedChip > state.balance) {
            setMessage("Not enough bankroll for that chip.");
            return false;
        }
        return true;
    }

    function placeBet(bet) {
        if (!canPlace(bet)) return;
        saveLastBetSet();
        state.bets[bet] = (state.bets[bet] || 0) + state.selectedChip;
        state.lastAction = { bet, amount: state.selectedChip };
        addBalance(-state.selectedChip);
        setMessage("Placed " + money(state.selectedChip) + " on " + labelFor(bet) + ".");
        update();
    }

    function labelFor(bet) {
        const labels = {
            passLine: "Pass Line",
            passOdds: "Pass odds",
            dontPass: "Don't Pass",
            come: "Come",
            dontCome: "Don't Come",
            field: "Field",
            any7: "Any Seven",
            anyCraps: "Any Craps",
            horn: "Horn",
            ce: "C & E"
        };
        if (bet.startsWith("place")) return "Place " + bet.replace("place", "");
        if (bet.startsWith("hard")) return "Hard " + bet.replace("hard", "");
        if (bet.startsWith("craps")) return "Craps " + bet.replace("craps", "");
        if (bet === "yo11") return "Yo";
        return labels[bet] || bet;
    }

    function clearRemovable() {
        saveLastBetSet();
        let refund = 0;
        ["field", "come", "dontCome", "place4", "place5", "place6", "place8", "place9", "place10"].forEach((key) => {
            refund += state.bets[key] || 0;
            state.bets[key] = 0;
        });
        addBalance(refund);
        setMessage(refund ? "Pulled down removable bets." : "No removable bets to clear.");
        update();
    }

    function undo() {
        if (!state.lastAction) {
            setMessage("No chip to undo.");
            return;
        }
        const { bet, amount } = state.lastAction;
        if ((state.bets[bet] || 0) >= amount) {
            state.bets[bet] -= amount;
            addBalance(amount);
            setMessage("Undid " + money(amount) + " from " + labelFor(bet) + ".");
            state.lastAction = null;
            update();
        }
    }

    function repeatLast() {
        if (!state.lastBetSet) {
            setMessage("No previous bet set.");
            return;
        }
        const total = Object.values(state.lastBetSet.bets).reduce((sum, amount) => sum + amount, 0);
        if (total > state.balance) {
            setMessage("Not enough bankroll to repeat.");
            return;
        }
        state.bets = { ...state.lastBetSet.bets };
        state.comePoints = JSON.parse(JSON.stringify(state.lastBetSet.comePoints));
        addBalance(-total);
        setMessage("Repeated last bet set.");
        update();
    }

    function addOdds() {
        if (state.phase === "COME_OUT" || state.bets.passLine <= 0) {
            setMessage("Odds open after a Pass/Come point is set.");
            return;
        }
        const maxOdds = state.bets.passLine * 5;
        const add = Math.min(state.selectedChip, state.balance, maxOdds - state.bets.passOdds);
        if (add <= 0) {
            setMessage("Pass odds are already at max.");
            return;
        }
        state.bets.passOdds += add;
        addBalance(-add);
        setMessage("Added " + money(add) + " odds behind Pass Line.");
        update();
    }

    function placeFieldOutcome(total) {
        const bet = state.bets.field;
        if (!bet) return 0;
        state.bets.field = 0;
        if ([2, 3, 4, 9, 10, 11, 12].includes(total)) {
            const multiplier = total === 2 || total === 12 ? 2 : 1;
            return bet + bet * multiplier;
        }
        return 0;
    }

    function resolvePlace(total) {
        let payout = 0;
        const rules = {
            4: 9 / 5,
            5: 7 / 5,
            6: 7 / 6,
            8: 7 / 6,
            9: 7 / 5,
            10: 9 / 5
        };
        boxNumbers.forEach((num) => {
            const key = "place" + num;
            const bet = state.bets[key];
            if (!bet) return;
            if (total === 7 && state.phase !== "COME_OUT") {
                state.bets[key] = 0;
                return;
            }
            if (total === num) payout += bet + Math.floor(bet * rules[num]);
        });
        return payout;
    }

    function moveComeBets(total) {
        if (state.bets.come <= 0) return 0;
        const bet = state.bets.come;
        state.bets.come = 0;
        if (total === 7 || total === 11) return bet * 2;
        if ([2, 3, 12].includes(total)) return 0;
        if (boxNumbers.includes(total)) {
            state.comePoints[total] = state.comePoints[total] || { amount: 0, odds: 0 };
            state.comePoints[total].amount += bet;
            setMessage("Come bet traveled to " + total + ".");
        }
        return 0;
    }

    function resolveComePoints(total) {
        let payout = 0;
        Object.entries(state.comePoints).forEach(([point, bet]) => {
            const pointNumber = Number(point);
            if (total === 7 && state.phase !== "COME_OUT") {
                delete state.comePoints[point];
                return;
            }
            if (total === pointNumber) {
                payout += bet.amount * 2;
                payout += bet.odds + Math.floor(bet.odds * oddsMultiplier(pointNumber));
                delete state.comePoints[point];
                setMessage("Come " + pointNumber + " wins with odds.");
            }
        });
        return payout;
    }

    function resolveLine(total) {
        let payout = 0;
        if (state.phase === "COME_OUT") {
            if (total === 7 || total === 11) {
                payout += state.bets.passLine * 2;
                state.bets.passLine = 0;
                state.bets.passOdds = 0;
                state.bets.dontPass = 0;
                setMessage("Come-out " + total + ". Pass Line wins.");
            } else if ([2, 3, 12].includes(total)) {
                if (total === 12) payout += state.bets.dontPass;
                else payout += state.bets.dontPass * 2;
                state.bets.passLine = 0;
                state.bets.passOdds = 0;
                state.bets.dontPass = 0;
                setMessage("Craps " + total + ". Pass loses.");
            } else if (boxNumbers.includes(total)) {
                state.phase = "POINT";
                state.point = total;
                setMessage("Point is " + total + ". Take odds if you want them.");
            }
            return payout;
        }

        if (total === state.point) {
            payout += state.bets.passLine * 2;
            payout += state.bets.passOdds + Math.floor(state.bets.passOdds * oddsMultiplier(state.point));
            state.bets.passLine = 0;
            state.bets.passOdds = 0;
            state.bets.dontPass = 0;
            state.phase = "COME_OUT";
            state.point = null;
            setMessage("Point hit. Pass Line wins.");
        } else if (total === 7) {
            payout += state.bets.dontPass * 2;
            state.bets.passLine = 0;
            state.bets.passOdds = 0;
            state.bets.dontPass = 0;
            state.comePoints = {};
            state.phase = "COME_OUT";
            state.point = null;
            setMessage("Seven out. Puck is off.");
        }
        return payout;
    }

    function oddsMultiplier(point) {
        if (point === 4 || point === 10) return 2;
        if (point === 5 || point === 9) return 1.5;
        return 1.2;
    }

    function roll() {
        dice.classList.add("rolling");
        const a = randDie();
        const b = randDie();
        const total = a + b;
        die1.textContent = String(a);
        die2.textContent = String(b);

        setTimeout(() => dice.classList.remove("rolling"), 540);

        let payout = 0;
        payout += placeFieldOutcome(total);
        payout += resolvePlace(total);
        payout += resolveComePoints(total);
        payout += moveComeBets(total);
        payout += resolveLine(total);
        if (payout > 0) addBalance(payout);
        if (!rollMessage.textContent.includes("Point") && !rollMessage.textContent.includes("Pass") && !rollMessage.textContent.includes("Come") && !rollMessage.textContent.includes("Seven")) {
            setMessage("Rolled " + a + " + " + b + " = " + total + ".");
        }
        update();
    }

    document.querySelectorAll("[data-chip]").forEach((button) => {
        button.addEventListener("click", () => {
            state.selectedChip = Number(button.dataset.chip);
            document.querySelectorAll("[data-chip]").forEach((chip) => {
                const selected = chip === button;
                chip.classList.toggle("selected", selected);
                chip.setAttribute("aria-checked", String(selected));
            });
        });
    });

    document.querySelectorAll("[data-bet]").forEach((button) => {
        button.addEventListener("click", () => placeBet(button.dataset.bet));
    });

    document.getElementById("edgeToggle").addEventListener("click", (event) => {
        const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
        event.currentTarget.setAttribute("aria-pressed", String(!pressed));
        update();
    });

    propsButton.addEventListener("click", () => {
        const open = !propsSheet.classList.contains("open");
        propsSheet.classList.toggle("open", open);
        propsSheet.setAttribute("aria-hidden", String(!open));
        propsButton.setAttribute("aria-expanded", String(open));
    });

    document.getElementById("closeProps").addEventListener("click", () => {
        propsSheet.classList.remove("open");
        propsSheet.setAttribute("aria-hidden", "true");
        propsButton.setAttribute("aria-expanded", "false");
    });

    document.getElementById("rollButton").addEventListener("click", roll);
    document.getElementById("undoButton").addEventListener("click", undo);
    document.getElementById("clearButton").addEventListener("click", clearRemovable);
    document.getElementById("repeatButton").addEventListener("click", repeatLast);
    document.getElementById("oddsButton").addEventListener("click", addOdds);

    setMessage("Preview: Pass Line has $25 plus $50 odds. Come 8 has $10 plus $20 odds.");
    update();
}());
