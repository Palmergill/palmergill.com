(function () {
    "use strict";

    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/draft`;
    const F = window.DraftOrderFormat;
    const POLL_MS = 2500;
    const ROOM_STATE_LABELS = { lobby: "Lobby", active: "Live", complete: "Final" };
    const state = {
        identity: null,
        room: null,
        pollTimer: null,
        actionBusy: false,
        revealTimers: [],
        resultsRevealed: false,
        statusTimer: null,
        botTimer: null,
        botPaused: false,
        // Bumped by every action. A poll that was already in flight when the
        // action landed carries a stale generation and is discarded, so the
        // board never rewinds to the pre-action snapshot.
        generation: 0,
    };

    const byId = (id) => document.getElementById(id);
    const els = {
        globalStatus: byId("globalStatus"),
        loadingView: byId("loadingView"),
        signedOutView: byId("signedOutView"),
        homeView: byId("homeView"),
        roomView: byId("roomView"),
        signInLink: byId("signInLink"),
        createAccountLink: byId("createAccountLink"),
        accountName: byId("accountName"),
        startPracticeButton: byId("startPracticeButton"),
        createRoomForm: byId("createRoomForm"),
        leagueName: byId("leagueName"),
        joinRoomForm: byId("joinRoomForm"),
        joinCode: byId("joinCode"),
        testRoomForm: byId("testRoomForm"),
        testLeagueName: byId("testLeagueName"),
        testBotCount: byId("testBotCount"),
        recentRoomsSection: byId("recentRoomsSection"),
        recentRooms: byId("recentRooms"),
        leaveRoomView: byId("leaveRoomView"),
        roomStateLabel: byId("roomStateLabel"),
        roomLeagueName: byId("roomLeagueName"),
        seedHash: byId("seedHash"),
        copyHashButton: byId("copyHashButton"),
        lobbyPanel: byId("lobbyPanel"),
        roomCodeCard: byId("roomCodeCard"),
        testRoomCard: byId("testRoomCard"),
        roomCode: byId("roomCode"),
        copyCodeButton: byId("copyCodeButton"),
        copyLinkButton: byId("copyLinkButton"),
        rosterCount: byId("rosterCount"),
        lobbyRoster: byId("lobbyRoster"),
        startGameButton: byId("startGameButton"),
        startHelp: byId("startHelp"),
        gamePanel: byId("gamePanel"),
        currentPlayerName: byId("currentPlayerName"),
        roundBadge: byId("roundBadge"),
        cardsHeld: byId("cardsHeld"),
        currentPot: byId("currentPot"),
        bustChance: byId("bustChance"),
        bankPosition: byId("bankPosition"),
        scoreToBeat: byId("scoreToBeat"),
        turnMessage: byId("turnMessage"),
        playActions: byId("playActions"),
        flipButton: byId("flipButton"),
        bankButton: byId("bankButton"),
        forfeitButton: byId("forfeitButton"),
        leaderboard: byId("leaderboard"),
        resultPanel: byId("resultPanel"),
        resultKicker: byId("resultKicker"),
        resultTitle: byId("resultTitle"),
        resultCopy: byId("resultCopy"),
        revealButton: byId("revealButton"),
        draftOrder: byId("draftOrder"),
        resultActions: byId("resultActions"),
        verifyButton: byId("verifyButton"),
        copyResultsButton: byId("copyResultsButton"),
        practiceAgainButton: byId("practiceAgainButton"),
        verifyPanel: byId("verifyPanel"),
        closeVerifyButton: byId("closeVerifyButton"),
        hashMatchBadge: byId("hashMatchBadge"),
        masterSeed: byId("masterSeed"),
        publishedHash: byId("publishedHash"),
        algorithmCopy: byId("algorithmCopy"),
        verificationPlayers: byId("verificationPlayers"),
    };

    async function requestJson(path, options) {
        const response = await fetch(`${API_BASE}${path}`, {
            credentials: "include",
            headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
            ...options,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(detailMessage(data));
            error.status = response.status;
            throw error;
        }
        return data;
    }

    // FastAPI sends a string detail for our own HTTPExceptions but an array of
    // validation objects for a 422, which would stringify into noise.
    function detailMessage(data) {
        const detail = data?.detail;
        if (typeof detail === "string" && detail) return detail;
        if (Array.isArray(detail) && detail.length) {
            const first = detail[0];
            if (typeof first?.msg === "string") return first.msg;
        }
        if (typeof data?.error === "string" && data.error) return data.error;
        return "Something went wrong.";
    }

    function nextPath() {
        return `${window.location.pathname}${window.location.search}${window.location.hash}`;
    }

    function redirectToLogin() {
        window.location.assign(`/login/?next=${encodeURIComponent(nextPath())}`);
    }

    // Every action shares this: a session that expired while the tab sat open
    // has to send the manager back to sign in, not fail quietly behind a
    // banner they may have scrolled past.
    function handleActionError(error) {
        if (error?.status === 401) {
            showStatus("Your session expired. Taking you back to sign in…", true);
            redirectToLogin();
            return;
        }
        showStatus(error?.message || "Something went wrong.", true);
    }

    function showStatus(message, isError) {
        window.clearTimeout(state.statusTimer);
        els.globalStatus.textContent = message;
        els.globalStatus.classList.toggle("is-error", Boolean(isError));
        els.globalStatus.hidden = !message;
        if (!message) return;
        // The banner lives above a tall hero, so a manager acting on the setup
        // cards or the play stage would never see it where it sits.
        els.globalStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
        // Errors stay until the next message replaces them; confirmations fade.
        if (!isError) {
            state.statusTimer = window.setTimeout(() => {
                if (els.globalStatus.textContent === message) els.globalStatus.hidden = true;
            }, 5000);
        }
    }

    function setView(name) {
        els.loadingView.hidden = name !== "loading";
        els.signedOutView.hidden = name !== "signedOut";
        els.homeView.hidden = name !== "home";
        els.roomView.hidden = name !== "room";
    }

    // Flip and Bank carry a <span> headline over a <small> subtitle, so the
    // label has to be swapped without touching the button's own children.
    function setButtonBusy(button, busy, busyLabel) {
        if (!button) return;
        button.disabled = busy;
        let overlay = button.querySelector(":scope > .button-busy-label");
        if (!busy) {
            if (overlay) overlay.remove();
            button.classList.remove("is-busy");
            return;
        }
        if (!overlay) {
            overlay = document.createElement("span");
            overlay.className = "button-busy-label";
            button.appendChild(overlay);
        }
        overlay.textContent = busyLabel;
        button.classList.add("is-busy");
    }

    function initials(name) {
        return String(name || "?")
            .split(/[\s_-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0].toUpperCase())
            .join("") || "?";
    }

    function roomInviteUrl(code) {
        const url = new URL("/fantasy/draft-order/", window.location.origin);
        url.searchParams.set("join", code);
        return url.toString();
    }

    async function copyText(value, successMessage) {
        try {
            await navigator.clipboard.writeText(value);
            showStatus(successMessage || "Copied.");
        } catch {
            showStatus("Copy failed. Select the text and copy it manually.", true);
        }
    }

    function updateRoomUrl(roomId) {
        const url = new URL(window.location.href);
        url.search = "";
        if (roomId) url.searchParams.set("room", roomId);
        window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }

    function stopPolling() {
        if (state.pollTimer) window.clearTimeout(state.pollTimer);
        state.pollTimer = null;
    }

    function stopBotTimer() {
        if (state.botTimer) window.clearTimeout(state.botTimer);
        state.botTimer = null;
    }

    function scheduleBotTurn() {
        stopBotTimer();
        if (
            state.botPaused
            || state.actionBusy
            || !state.room?.canRunBot
            || state.room.state !== "active"
        ) return;
        state.botTimer = window.setTimeout(playBotRound, 900);
    }

    function schedulePoll() {
        stopPolling();
        if (!state.room || !["lobby", "active"].includes(state.room.state)) return;
        state.pollTimer = window.setTimeout(async () => {
            const generation = state.generation;
            const roomId = state.room.id;
            try {
                const room = await requestJson(`/sessions/${roomId}`);
                // An action that resolved while this GET was in flight already
                // rendered newer state — don't overwrite it with the old one.
                if (generation !== state.generation || state.room?.id !== roomId) return;
                state.room = room;
                renderRoom();
            } catch (error) {
                if (error.status === 401) {
                    redirectToLogin();
                    return;
                }
            } finally {
                schedulePoll();
            }
        }, POLL_MS);
    }

    function renderHome(sessions) {
        setView("home");
        els.accountName.textContent = state.identity.username;
        els.testRoomForm.hidden = state.identity.role !== "admin";
        const rooms = sessions || [];
        els.recentRoomsSection.hidden = rooms.length === 0;
        els.recentRooms.innerHTML = "";
        rooms.forEach((room) => {
            const button = document.createElement("button");
            button.type = "button";
            const title = document.createElement("strong");
            title.textContent = room.leagueName;
            const details = document.createElement("span");
            const managers = room.players.length;
            const stateLabel = room.state === "complete"
                ? "Draft order final"
                : room.state === "active"
                    ? `${room.currentPlayer?.displayName || "Player"} is up`
                    : `${managers} manager${managers === 1 ? "" : "s"} in lobby`;
            details.textContent = stateLabel;
            const status = document.createElement("small");
            const modeLabel = room.mode === "league"
                ? ROOM_STATE_LABELS[room.state] || room.state
                : F.roomModeName(room.mode);
            status.textContent = modeLabel;
            button.append(title, details, status);
            button.addEventListener("click", () => openRoom(room.id));
            els.recentRooms.appendChild(button);
        });
    }

    async function loadHome() {
        stopPolling();
        stopBotTimer();
        state.room = null;
        state.resultsRevealed = false;
        state.revealTimers.forEach(window.clearTimeout);
        state.revealTimers = [];
        updateRoomUrl(null);
        setView("loading");
        try {
            const data = await requestJson("/sessions/mine");
            renderHome(data.sessions || []);
        } catch (error) {
            if (error?.status === 401) {
                handleActionError(error);
                return;
            }
            renderHome([]);
            showStatus(error.message, true);
        }
    }

    async function openRoom(roomId) {
        stopPolling();
        stopBotTimer();
        state.botPaused = false;
        state.generation += 1;
        setView("loading");
        try {
            state.room = await requestJson(`/sessions/${roomId}`);
            state.resultsRevealed = false;
            state.revealTimers.forEach(window.clearTimeout);
            state.revealTimers = [];
            updateRoomUrl(roomId);
            renderRoom();
            schedulePoll();
        } catch (error) {
            if (error?.status === 401) {
                handleActionError(error);
                return;
            }
            showStatus(error.message, true);
            await loadHome();
        }
    }

    function renderRoom() {
        const room = state.room;
        if (!room) return;
        setView("room");
        els.verifyPanel.hidden = true;
        els.roomLeagueName.textContent = room.leagueName;
        els.seedHash.textContent = F.compactHash(room.seedHash, 12);
        const modeLabel = F.roomModeName(room.mode);
        els.roomStateLabel.textContent = room.state === "lobby"
            ? `${modeLabel} · lobby open`
            : room.state === "active"
                ? `${modeLabel} · live`
                : `${modeLabel} · final result`;
        els.lobbyPanel.hidden = room.state !== "lobby";
        els.gamePanel.hidden = room.state !== "active";
        els.resultPanel.hidden = room.state !== "complete";

        if (room.state === "lobby") renderLobby(room);
        if (room.state === "active") {
            renderGame(room);
            scheduleBotTurn();
        } else {
            stopBotTimer();
        }
        if (room.state === "complete") {
            stopPolling();
            renderResults(room);
        }
    }

    function renderLobby(room) {
        const isTest = room.mode === "test";
        els.roomCodeCard.hidden = isTest;
        els.testRoomCard.hidden = !isTest;
        els.roomCode.textContent = room.joinCode || "—";
        els.rosterCount.textContent = room.players.length;
        els.lobbyRoster.innerHTML = "";
        room.players.forEach((player) => {
            const row = document.createElement("li");
            const avatar = document.createElement("span");
            avatar.className = "roster-avatar";
            avatar.textContent = initials(player.displayName);
            const name = document.createElement("span");
            name.className = "roster-name";
            name.textContent = player.displayName;
            row.append(avatar, name);
            if (player.isBot) {
                const bot = document.createElement("span");
                bot.className = "bot-chip";
                bot.textContent = "Bot";
                row.appendChild(bot);
            }
            if (player.isHost) {
                const host = document.createElement("span");
                host.className = "host-chip";
                host.textContent = "Host";
                row.appendChild(host);
            } else if (room.isHost) {
                const remove = document.createElement("button");
                remove.className = "remove-player";
                remove.type = "button";
                remove.textContent = "Remove";
                remove.addEventListener("click", () => removePlayer(player));
                row.appendChild(remove);
            }
            els.lobbyRoster.appendChild(row);
        });
        els.startGameButton.hidden = !room.isHost;
        els.startGameButton.disabled = !room.canStart || state.actionBusy;
        els.startGameButton.textContent = isTest
            ? "Start full-flow test"
            : "Lock roster & reveal turn order";
        els.startHelp.textContent = room.isHost
            ? (room.canStart
                ? (isTest
                    ? "Bots play automatically. Everyone finishes each round before the standings leader starts the next one."
                    : "Everyone finishes Round 1 in the seeded order. The standings leader starts Rounds 2 and 3.")
                : "One more manager must join before you can start.")
            : "Waiting for the host to lock the roster and start.";
    }

    function renderCards(cards) {
        els.cardsHeld.innerHTML = "";
        if (!cards.length) {
            const placeholder = document.createElement("div");
            placeholder.className = "card-placeholder";
            placeholder.textContent = "First flip";
            els.cardsHeld.appendChild(placeholder);
            return;
        }
        cards.forEach((card, index) => {
            const node = document.createElement("div");
            node.className = `playing-card${card.red ? " is-red" : ""}`;
            const center = document.createElement("b");
            center.textContent = card.symbol;
            const corner = document.createElement("small");
            const rank = document.createElement("span");
            rank.textContent = card.rank;
            const suit = document.createElement("span");
            suit.textContent = card.symbol;
            corner.append(rank, suit);
            node.append(center, corner);
            node.style.setProperty("--tilt", `${(index - (cards.length - 1) / 2) * 2.2}deg`);
            node.style.animationDelay = `${index * 35}ms`;
            els.cardsHeld.appendChild(node);
        });
    }

    function renderGame(room) {
        const round = room.currentRound || { number: 1, cards: [], pot: 0, bustChance: 0 };
        const decision = room.decision || {};
        els.currentPlayerName.textContent = room.currentPlayer?.displayName || "—";
        els.roundBadge.textContent = `Round ${round.number} of ${room.roundsPerPlayer}`;
        renderCards(round.cards || []);
        els.currentPot.textContent = round.pot || 0;
        els.bustChance.textContent = F.bustCopy(round.bustChance);
        els.bankPosition.textContent = decision.bankPosition ? F.ordinal(decision.bankPosition) : "—";
        // These stats describe the player at the table, so only phrase them in
        // the second person when the viewer is that player.
        els.scoreToBeat.textContent = decision.isLeadingIfBanked
            ? (room.canPlay ? "You’d lead" : "Would lead")
            : `${decision.scoreToBeat || 0} pts`;
        els.playActions.hidden = !room.canPlay;
        els.flipButton.disabled = state.actionBusy;
        els.bankButton.disabled = state.actionBusy || !(round.cards || []).length;

        // The host's way out of a room stalled on someone who left.
        const stalledOn = room.currentPlayer?.displayName;
        els.forfeitButton.hidden = room.canRunBot || !room.canForfeit || room.canPlay;
        els.forfeitButton.disabled = state.actionBusy;
        if (!els.forfeitButton.hidden) {
            els.forfeitButton.textContent = `${stalledOn} isn’t responding — skip them`;
        }

        if (room.canRunBot && !els.turnMessage.dataset.event) {
            els.turnMessage.className = "turn-message";
            els.turnMessage.textContent = `${room.currentPlayer?.displayName || "A bot"} is playing automatically…`;
        } else if (!room.canPlay && !els.turnMessage.dataset.event) {
            els.turnMessage.className = "turn-message";
            els.turnMessage.textContent = `Watching ${room.currentPlayer?.displayName || "the current player"}. This screen updates automatically.`;
        } else if (!els.turnMessage.dataset.event) {
            els.turnMessage.className = "turn-message";
            els.turnMessage.textContent = round.cards.length
                ? "Bank the pot or press your luck."
                : "Your turn. The first flip can’t bust.";
        }
        renderLeaderboard(room);
    }

    function renderLeaderboard(room) {
        els.leaderboard.innerHTML = "";
        room.leaderboard.forEach((player) => {
            const row = document.createElement("li");
            if (player.isCurrent) row.className = "is-current";
            const place = document.createElement("span");
            place.className = "leaderboard-place";
            place.textContent = String(player.place).padStart(2, "0");
            const info = document.createElement("span");
            info.className = "leaderboard-player";
            const name = document.createElement("strong");
            name.textContent = `${player.displayName}${player.isBot ? " · BOT" : ""}`;
            const rounds = document.createElement("span");
            rounds.textContent = `${player.roundsCompleted}/${room.roundsPerPlayer} rounds${player.isCurrent ? " · up now" : ""}`;
            info.append(name, rounds);
            const score = document.createElement("span");
            score.className = "leaderboard-score";
            score.textContent = `${player.score}`;
            row.append(place, info, score);
            els.leaderboard.appendChild(row);
        });
    }

    function renderResults(room) {
        els.draftOrder.innerHTML = "";
        const isPractice = room.mode === "practice";
        if (isPractice) state.resultsRevealed = true;
        els.resultKicker.textContent = isPractice ? "Practice complete · seed revealed" : "Scores locked · seed revealed";
        els.resultTitle.textContent = isPractice ? "Three practice rounds complete." : "The draft order is ready.";
        els.resultCopy.textContent = isPractice
            ? `You scored ${room.draftOrder?.[0]?.score || 0} points. Run it again whenever you want another warm-up.`
            : "Reveal from the last pick to the first, then open the proof behind every card.";
        els.practiceAgainButton.hidden = !isPractice;
        els.copyResultsButton.hidden = isPractice;
        els.verifyButton.textContent = isPractice ? "Verify practice deal" : "Verify every deal";
        els.resultActions.hidden = !state.resultsRevealed;
        els.revealButton.hidden = isPractice || state.resultsRevealed;
        if (state.resultsRevealed) {
            room.draftOrder.forEach((entry) => els.draftOrder.appendChild(resultRow(entry)));
        }
    }

    function resultRow(entry) {
        const row = document.createElement("li");
        const pick = document.createElement("span");
        pick.className = "pick-number";
        pick.textContent = `#${entry.pick}`;
        const info = document.createElement("span");
        const name = document.createElement("strong");
        name.textContent = entry.displayName;
        const best = document.createElement("small");
        best.textContent = `Best round ${entry.bestRound} pts`;
        info.append(name, best);
        const score = document.createElement("span");
        score.className = "draft-score";
        score.textContent = `${entry.score} pts`;
        row.append(pick, info, score);
        return row;
    }

    function revealResults() {
        if (!state.room?.draftOrder || state.resultsRevealed) return;
        state.resultsRevealed = true;
        els.revealButton.hidden = true;
        els.draftOrder.innerHTML = "";
        const sequence = [...state.room.draftOrder].reverse();
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        sequence.forEach((entry, index) => {
            const timer = window.setTimeout(() => {
                els.draftOrder.prepend(resultRow(entry));
                if (index === sequence.length - 1) {
                    els.resultActions.hidden = false;
                    window.pgAnalytics?.track?.("draft_order_revealed", { players: sequence.length });
                }
            }, reducedMotion ? 0 : index * 850);
            state.revealTimers.push(timer);
        });
    }

    async function startPractice(button) {
        if (state.actionBusy) return;
        state.actionBusy = true;
        state.botPaused = false;
        stopPolling();
        stopBotTimer();
        setButtonBusy(button, true, "Shuffling practice");
        try {
            const room = await requestJson("/practice", { method: "POST" });
            state.generation += 1;
            state.room = room;
            state.resultsRevealed = false;
            updateRoomUrl(room.id);
            renderRoom();
            schedulePoll();
            window.pgAnalytics?.track?.("draft_practice_started");
        } catch (error) {
            handleActionError(error);
        } finally {
            state.actionBusy = false;
            setButtonBusy(button, false, "Shuffling practice");
            if (state.room?.state === "active") renderGame(state.room);
        }
    }

    async function playBotRound() {
        if (state.actionBusy || state.botPaused || !state.room?.canRunBot) return;
        state.actionBusy = true;
        stopPolling();
        const botName = state.room.currentPlayer?.displayName || "Bot";
        els.turnMessage.dataset.event = "bot_round";
        els.turnMessage.className = "turn-message";
        els.turnMessage.textContent = `${botName} is playing round ${state.room.currentRound?.number || 1}…`;
        try {
            const room = await requestJson(
                `/sessions/${state.room.id}/bots/play-round`,
                { method: "POST" },
            );
            state.generation += 1;
            state.room = room;
            const event = room.event;
            els.turnMessage.className = event?.outcome === "busted"
                ? "turn-message is-bust"
                : "turn-message is-bank";
            els.turnMessage.textContent = F.botRoundMessage(event);
            renderRoom();
            window.setTimeout(() => { delete els.turnMessage.dataset.event; }, 700);
            schedulePoll();
        } catch (error) {
            state.botPaused = true;
            delete els.turnMessage.dataset.event;
            handleActionError(error);
        } finally {
            state.actionBusy = false;
            if (state.room?.state === "active") renderGame(state.room);
            scheduleBotTurn();
        }
    }

    async function performAction(path, button, busyLabel) {
        if (state.actionBusy || !state.room) return;
        state.actionBusy = true;
        setButtonBusy(button, true, busyLabel);
        try {
            const room = await requestJson(`/sessions/${state.room.id}/${path}`, { method: "POST" });
            state.generation += 1;
            state.room = room;
            els.turnMessage.dataset.event = room.event?.type || "";
            if (room.event?.type === "flip" && room.event.busted) {
                els.turnMessage.className = "turn-message is-bust";
                els.turnMessage.textContent = `${F.cardLabel(room.event.card)} repeats a rank. Round busted.`;
            } else if (room.event?.type === "flip") {
                els.turnMessage.className = "turn-message";
                els.turnMessage.textContent = `${F.cardLabel(room.event.card)} dealt. Bank it or press again.`;
            } else if (room.event?.type === "bank") {
                els.turnMessage.className = "turn-message is-bank";
                els.turnMessage.textContent = `${room.event.score} points banked.`;
            } else if (room.event?.type === "forfeit") {
                els.turnMessage.className = "turn-message is-bust";
                els.turnMessage.textContent = `${room.event.displayName} was skipped. Their remaining rounds score zero.`;
            }
            renderRoom();
            window.setTimeout(() => { delete els.turnMessage.dataset.event; }, 1800);
            schedulePoll();
        } catch (error) {
            handleActionError(error);
            if (error?.status !== 401 && state.room) {
                try {
                    state.generation += 1;
                    state.room = await requestJson(`/sessions/${state.room.id}`);
                    renderRoom();
                } catch { /* Keep the last known room visible. */ }
            }
        } finally {
            state.actionBusy = false;
            setButtonBusy(button, false, busyLabel);
            if (state.room?.state === "active") renderGame(state.room);
            scheduleBotTurn();
        }
    }

    async function removePlayer(player) {
        if (!state.room || !window.confirm(`Remove ${player.displayName} from the lobby?`)) return;
        try {
            state.generation += 1;
            state.room = await requestJson(`/sessions/${state.room.id}/players/${player.id}`, { method: "DELETE" });
            renderRoom();
        } catch (error) {
            handleActionError(error);
        }
    }

    async function showVerification() {
        if (!state.room) return;
        setButtonBusy(els.verifyButton, true, "Loading proof");
        try {
            const proof = await requestJson(`/sessions/${state.room.id}/verify`);
            renderVerification(proof);
            els.resultPanel.hidden = true;
            els.verifyPanel.hidden = false;
            els.verifyPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
            handleActionError(error);
        } finally {
            setButtonBusy(els.verifyButton, false, "Loading proof");
        }
    }

    function renderVerification(proof) {
        els.hashMatchBadge.textContent = proof.hashMatches ? "✓ SHA-256 matched" : "Hash mismatch";
        els.hashMatchBadge.classList.toggle("is-failed", !proof.hashMatches);
        els.masterSeed.textContent = proof.masterSeed;
        els.publishedHash.textContent = proof.publishedSeedHash;
        els.algorithmCopy.innerHTML = "";
        [
            proof.algorithm.commitment,
            proof.algorithm.canonicalDeck,
            proof.algorithm.derivation,
            proof.algorithm.shuffle,
            `Contexts: ${proof.algorithm.contexts.turnOrder}; ${proof.algorithm.contexts.playerDeck}.`,
            `Ties: ${proof.algorithm.tieBreakRule}`,
        ].forEach((copy) => {
            const paragraph = document.createElement("p");
            paragraph.textContent = copy;
            els.algorithmCopy.appendChild(paragraph);
        });

        els.verificationPlayers.innerHTML = "";
        proof.players.forEach((player) => {
            const details = document.createElement("details");
            details.className = "verification-player";
            const summary = document.createElement("summary");
            const name = document.createElement("strong");
            name.textContent = `${player.turnPosition}. ${player.displayName}`;
            const score = document.createElement("span");
            score.textContent = `${player.finalScore} pts · ${player.draws.length} cards used`;
            summary.append(name, score);
            const body = document.createElement("div");
            body.className = "verification-body";
            const meta = document.createElement("div");
            meta.className = "verification-meta";
            const tie = document.createElement("span");
            tie.textContent = `Tie key ${player.tieBreakValue}`;
            const draws = document.createElement("span");
            draws.textContent = `Draws: ${player.draws.map((draw) => `R${draw.round} ${F.cardLabel(draw.card)} @${draw.deckIndex}`).join(" · ")}`;
            meta.append(tie, draws);
            const used = new Set(player.draws.map((draw) => draw.deckIndex));
            const deck = document.createElement("div");
            deck.className = "deck-grid";
            player.deck.forEach((card) => {
                const node = document.createElement("span");
                node.className = `mini-card${card.red ? " is-red" : ""}${used.has(card.deckIndex) ? " is-drawn" : ""}`;
                node.textContent = F.cardLabel(card);
                node.title = `Deck index ${card.deckIndex}${used.has(card.deckIndex) ? " · drawn" : ""}`;
                deck.appendChild(node);
            });
            const legend = document.createElement("p");
            legend.className = "deck-legend";
            legend.textContent = "Highlighted cards were drawn. Indexing starts at 0.";
            body.append(meta, deck, legend);
            details.append(summary, body);
            els.verificationPlayers.appendChild(details);
        });
    }

    els.createRoomForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = els.createRoomForm.querySelector("button[type='submit']");
        setButtonBusy(button, true, "Creating room");
        try {
            const room = await requestJson("/sessions", {
                method: "POST",
                body: JSON.stringify({ league_name: els.leagueName.value.trim() }),
            });
            state.generation += 1;
            state.room = room;
            state.resultsRevealed = false;
            updateRoomUrl(room.id);
            renderRoom();
            schedulePoll();
            window.pgAnalytics?.track?.("draft_room_created");
        } catch (error) {
            handleActionError(error);
        } finally {
            setButtonBusy(button, false, "Creating room");
        }
    });

    els.startPracticeButton.addEventListener("click", () => startPractice(els.startPracticeButton));
    els.practiceAgainButton.addEventListener("click", () => startPractice(els.practiceAgainButton));

    els.testRoomForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.actionBusy) return;
        const button = els.testRoomForm.querySelector("button[type='submit']");
        state.actionBusy = true;
        state.botPaused = false;
        setButtonBusy(button, true, "Staging bots");
        try {
            const room = await requestJson("/sessions/test", {
                method: "POST",
                body: JSON.stringify({
                    league_name: els.testLeagueName.value.trim(),
                    bot_count: Number(els.testBotCount.value),
                }),
            });
            state.generation += 1;
            state.room = room;
            state.resultsRevealed = false;
            updateRoomUrl(room.id);
            renderRoom();
            schedulePoll();
            window.pgAnalytics?.track?.("draft_test_room_created", {
                bots: Number(els.testBotCount.value),
            });
        } catch (error) {
            handleActionError(error);
        } finally {
            state.actionBusy = false;
            setButtonBusy(button, false, "Staging bots");
            if (state.room?.state === "lobby") renderLobby(state.room);
        }
    });

    els.joinRoomForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = els.joinRoomForm.querySelector("button[type='submit']");
        setButtonBusy(button, true, "Joining room");
        try {
            const room = await requestJson("/sessions/join", {
                method: "POST",
                body: JSON.stringify({ join_code: els.joinCode.value.trim() }),
            });
            state.generation += 1;
            state.room = room;
            state.resultsRevealed = false;
            updateRoomUrl(room.id);
            renderRoom();
            schedulePoll();
            window.pgAnalytics?.track?.("draft_room_joined");
        } catch (error) {
            handleActionError(error);
        } finally {
            setButtonBusy(button, false, "Joining room");
        }
    });

    els.leaveRoomView.addEventListener("click", loadHome);
    els.copyHashButton.addEventListener("click", () => state.room && copyText(state.room.seedHash, "Seed commitment copied."));
    els.copyCodeButton.addEventListener("click", () => state.room && copyText(state.room.joinCode, "Room code copied."));
    els.copyLinkButton.addEventListener("click", () => state.room && copyText(roomInviteUrl(state.room.joinCode), "Invite link copied."));
    els.startGameButton.addEventListener("click", async () => {
        if (state.actionBusy || !state.room) return;
        state.actionBusy = true;
        setButtonBusy(els.startGameButton, true, "Locking roster");
        try {
            const room = await requestJson(`/sessions/${state.room.id}/start`, { method: "POST" });
            state.generation += 1;
            state.room = room;
            renderRoom();
            schedulePoll();
            window.pgAnalytics?.track?.("draft_game_started", { players: state.room.players.length });
        } catch (error) {
            handleActionError(error);
        } finally {
            state.actionBusy = false;
            setButtonBusy(els.startGameButton, false, "Locking roster");
            if (state.room?.state === "active") renderGame(state.room);
            scheduleBotTurn();
        }
    });
    els.flipButton.addEventListener("click", () => performAction("flip", els.flipButton, "Dealing"));
    els.bankButton.addEventListener("click", () => performAction("bank", els.bankButton, "Banking"));
    els.forfeitButton.addEventListener("click", () => {
        const name = state.room?.currentPlayer?.displayName || "this manager";
        if (!window.confirm(`Skip ${name}? Their remaining rounds score zero and the draft moves on. This can't be undone.`)) return;
        performAction("forfeit", els.forfeitButton, "Skipping");
    });
    els.revealButton.addEventListener("click", revealResults);
    els.verifyButton.addEventListener("click", showVerification);
    els.closeVerifyButton.addEventListener("click", () => {
        els.verifyPanel.hidden = true;
        els.resultPanel.hidden = false;
        els.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    els.copyResultsButton.addEventListener("click", () => {
        if (!state.room?.draftOrder) return;
        const text = [
            `${state.room.leagueName} draft order`,
            ...state.room.draftOrder.map((entry) => `${entry.pick}. ${entry.displayName} — ${entry.score} pts`),
            `Verified at ${F.roomUrl(window.location.origin, state.room.id)}`,
        ].join("\n");
        copyText(text, "Draft order copied.");
    });

    async function joinFromInvite(code) {
        setView("loading");
        try {
            const room = await requestJson("/sessions/join", {
                method: "POST",
                body: JSON.stringify({ join_code: code }),
            });
            state.generation += 1;
            state.room = room;
            updateRoomUrl(room.id);
            renderRoom();
            schedulePoll();
        } catch (error) {
            if (error?.status === 401) {
                handleActionError(error);
                return;
            }
            await loadHome();
            els.joinCode.value = code;
            showStatus(error.message, true);
        }
    }

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const desiredRoom = params.get("room");
        const inviteCode = (params.get("join") || "").trim().toUpperCase();
        try {
            const response = await fetch("/login/session", { credentials: "include", cache: "no-store" });
            const identity = await response.json();
            if (!identity.authenticated) {
                const destination = encodeURIComponent(nextPath());
                els.signInLink.href = `/login/?next=${destination}`;
                els.createAccountLink.href = `/signup/?next=${destination}${inviteCode ? `&invite=${encodeURIComponent(inviteCode)}` : ""}`;
                // A manager can use an open room code as their account invite,
                // even when general site sign-ups are closed.
                els.createAccountLink.hidden = false;
                setView("signedOut");
                return;
            }
            state.identity = identity;
            if (desiredRoom) await openRoom(desiredRoom);
            else if (inviteCode) await joinFromInvite(inviteCode);
            else await loadHome();
        } catch {
            showStatus("The draft room service is unavailable right now.", true);
            setView("signedOut");
        }
    }

    init();
})();
