(function () {
    "use strict";

    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/draft`;
    const F = window.DraftOrderFormat;
    const ACTIVE_POLL_MS = 900;
    const IDLE_POLL_MS = 2500;
    // Bots act one card at a time and wait like a person would: long enough to
    // read the card that just landed, longer still after a round ends.
    const BOT_TURN_START_MS = 1100;
    const BOT_THINK_MIN_MS = 900;
    const BOT_THINK_MAX_MS = 1900;
    const ROOM_STATE_LABELS = { lobby: "Lobby", active: "Live", complete: "Final" };
    const ROUND_STATE_COPY = {
        banked: "Banked",
        busted: "Busted on a repeated rank",
        forfeited: "Written off by the host — scores zero",
    };
    // Clears the sticky site nav when the table is scrolled into view.
    const STICKY_NAV_OFFSET = 76;
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
        // The table sits below a full-height hero, so a manager whose turn
        // arrives while they are reading the standings would never see the
        // Flip and Bank buttons without scrolling for them.
        wasMyTurn: false,
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
        adminRoomsSection: byId("adminRoomsSection"),
        adminRooms: byId("adminRooms"),
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
        currentPotUnit: byId("currentPotUnit"),
        bustChance: byId("bustChance"),
        bankPosition: byId("bankPosition"),
        scoreToBeat: byId("scoreToBeat"),
        turnMessage: byId("turnMessage"),
        playActions: byId("playActions"),
        flipButton: byId("flipButton"),
        bankButton: byId("bankButton"),
        forfeitButton: byId("forfeitButton"),
        resumeBotsButton: byId("resumeBotsButton"),
        leaderboard: byId("leaderboard"),
        leaderboardTitle: byId("leaderboardTitle"),
        pollNote: byId("pollNote"),
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
        // Inside a room the hero is pure decoration, and at full size it costs
        // the whole first screen — the play stage and its buttons start below
        // the fold on a laptop. Collapse it to a slim bar.
        document.body.classList.toggle("in-room", name === "room");
    }

    function scrollToPlayStage() {
        // After a frame: the first render of a room swaps panels and collapses
        // the hero, so measuring inline lands on the pre-layout position.
        window.requestAnimationFrame(() => {
            const stage = document.querySelector(".play-stage");
            if (!stage || els.gamePanel.hidden) return;
            const top = Math.max(0, stage.getBoundingClientRect().top + window.scrollY - STICKY_NAV_OFFSET);
            if (Math.abs(window.scrollY - top) < 8) return;
            const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            window.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
        });
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

    function botThinkDelay() {
        const spread = BOT_THINK_MAX_MS - BOT_THINK_MIN_MS;
        return BOT_THINK_MIN_MS + Math.floor(Math.random() * (spread + 1));
    }

    function scheduleBotTurn(delay) {
        if (
            state.botPaused
            || state.actionBusy
            || !state.room?.canRunBot
            || state.room.state !== "active"
        ) {
            stopBotTimer();
            return;
        }
        // Renders happen on every poll. Restarting the countdown each time would
        // keep pushing the bot's next card back, so let a pending one run out.
        if (state.botTimer) return;
        state.botTimer = window.setTimeout(playBotStep, delay || BOT_TURN_START_MS);
    }

    function schedulePoll() {
        stopPolling();
        const waitingForReveal = state.room?.state === "complete" && !state.room.resultsRevealed;
        if (!state.room || (!["lobby", "active"].includes(state.room.state) && !waitingForReveal)) return;
        const delay = state.room.state === "active" ? ACTIVE_POLL_MS : IDLE_POLL_MS;
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
        }, delay);
    }

    function renderHome(sessions) {
        setView("home");
        els.accountName.textContent = state.identity.username;
        els.testRoomForm.hidden = state.identity.role !== "admin";
        const rooms = sessions || [];
        els.recentRoomsSection.hidden = rooms.length === 0;
        els.recentRooms.innerHTML = "";
        const isAdmin = state.identity.role === "admin";
        if (!isAdmin) els.adminRoomsSection.hidden = true;
        rooms.forEach((room) => {
            const slot = document.createElement("div");
            slot.className = "room-slot";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "room-open";
            const title = document.createElement("strong");
            title.textContent = room.leagueName;
            const details = document.createElement("span");
            const managers = room.playerCount;
            const stateLabel = room.state === "complete"
                ? (room.resultsRevealed ? "Draft order final" : "Final reveal ready")
                : room.state === "active"
                    ? `${room.currentPlayerName || "Player"} is up`
                    : `${managers} manager${managers === 1 ? "" : "s"} in lobby`;
            details.textContent = stateLabel;
            const status = document.createElement("small");
            // /sessions/mine only returns league rooms — practice and bot test
            // rooms stay out of the launcher — so the state label always applies.
            status.textContent = ROOM_STATE_LABELS[room.state] || room.state;
            button.append(title, details, status);
            button.addEventListener("click", () => openRoom(room.id));
            slot.appendChild(button);
            if (isAdmin) {
                slot.classList.add("has-delete");
                slot.appendChild(deleteRoomButton(room));
            }
            els.recentRooms.appendChild(slot);
        });
    }

    function renderAdminRooms(sessions) {
        const rooms = sessions || [];
        els.adminRoomsSection.hidden = rooms.length === 0;
        els.adminRooms.innerHTML = "";
        rooms.forEach((room) => {
            const row = document.createElement("div");
            row.className = "admin-room";
            const title = document.createElement("strong");
            title.textContent = room.leagueName;
            const meta = document.createElement("span");
            const managers = room.playerCount;
            // Rooms the admin never joined are listed but not openable — the
            // room endpoint still answers only to the managers playing in it.
            meta.textContent = [
                F.roomModeName(room.mode),
                ROOM_STATE_LABELS[room.state] || room.state,
                `${managers} manager${managers === 1 ? "" : "s"}`,
                `hosted by ${room.createdBy}`,
            ].join(" · ");
            row.append(title, meta, deleteRoomButton(room));
            els.adminRooms.appendChild(row);
        });
    }

    // Admin-only: rooms accumulate faster than a league finishes them, and
    // nobody else should be able to erase a draft other managers played.
    function deleteRoomButton(room) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "room-delete";
        remove.textContent = "×";
        remove.title = `Delete ${room.leagueName}`;
        remove.setAttribute("aria-label", `Delete ${room.leagueName}`);
        remove.addEventListener("click", async () => {
            const confirmed = window.confirm(
                `Delete "${room.leagueName}"? Every hand played in it goes with it.`,
            );
            if (!confirmed) return;
            remove.disabled = true;
            try {
                await requestJson(`/sessions/${room.id}`, { method: "DELETE" });
                showStatus(`Deleted ${room.leagueName}.`);
                await loadHome();
            } catch (error) {
                remove.disabled = false;
                handleActionError(error);
            }
        });
        return remove;
    }

    async function loadHome() {
        stopPolling();
        stopBotTimer();
        state.room = null;
        state.wasMyTurn = false;
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
        // Its own request so a failure here leaves the launcher standing.
        if (state.identity.role === "admin") await loadAdminRooms();
    }

    async function loadAdminRooms() {
        try {
            const data = await requestJson("/sessions/all");
            renderAdminRooms(data.sessions || []);
        } catch (error) {
            renderAdminRooms([]);
            showStatus(error.message, true);
        }
    }

    async function openRoom(roomId) {
        stopPolling();
        stopBotTimer();
        state.botPaused = false;
        // Arriving at a room is a fresh turn as far as the table is concerned,
        // otherwise a manager who has played once never gets scrolled in again.
        state.wasMyTurn = false;
        state.generation += 1;
        setView("loading");
        try {
            state.room = await requestJson(`/sessions/${roomId}`);
            state.resultsRevealed = Boolean(state.room.resultsRevealed);
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
                : `${modeLabel} · ${room.resultsRevealed ? "final result" : "reveal ready"}`;
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
            if (room.resultsRevealed) stopPolling();
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
                    : "Everyone finishes Round 1 in the seeded order. The standings leader starts each following round.")
                : "One more manager must join before you can start.")
            : "Waiting for the host to lock the roster and start.";
    }

    function renderCards(cards, concealedCount, scope) {
        const concealed = concealedCount !== null && concealedCount !== undefined;
        const descriptors = concealed
            ? Array.from({ length: concealedCount }, (_, index) => ({ key: `hidden:${index}` }))
            : cards.map((card, index) => ({ key: `${index}:${card.code}`, card }));

        // Polling redraws the rest of the live room frequently. Keep cards that
        // are already on the table mounted so their deal animation cannot
        // restart; append only cards that actually arrived since the last view.
        if (els.cardsHeld.dataset.cardScope !== scope) {
            els.cardsHeld.innerHTML = "";
            els.cardsHeld.dataset.cardScope = scope;
        }

        if (!descriptors.length) {
            const placeholderKey = concealed ? "placeholder:sealed" : "placeholder:first";
            if (els.cardsHeld.children.length === 1 && els.cardsHeld.children[0].dataset.cardKey === placeholderKey) {
                return;
            }
            els.cardsHeld.innerHTML = "";
            const placeholder = document.createElement("div");
            placeholder.className = concealed
                ? "card-placeholder card-placeholder--sealed"
                : "card-placeholder";
            placeholder.dataset.cardKey = placeholderKey;
            placeholder.textContent = concealed ? "Final hand sealed" : "First flip";
            els.cardsHeld.appendChild(placeholder);
            return;
        }

        let rendered = Array.from(els.cardsHeld.children);
        const existingCardsMatch = rendered.length <= descriptors.length && rendered.every(
            (node, index) => node.dataset.cardKey === descriptors[index].key,
        );
        if (!existingCardsMatch) {
            els.cardsHeld.innerHTML = "";
            rendered = [];
        }

        for (let index = rendered.length; index < descriptors.length; index += 1) {
            const descriptor = descriptors[index];
            const node = document.createElement("div");
            node.dataset.cardKey = descriptor.key;
            node.style.animationDelay = `${index * 35}ms`;
            if (concealed) {
                node.className = "playing-card is-concealed";
                node.textContent = "♠";
            } else {
                const card = descriptor.card;
                node.className = `playing-card${card.red ? " is-red" : ""}`;
                const center = document.createElement("b");
                center.setAttribute("aria-hidden", "true");
                center.textContent = card.symbol;
                const corner = document.createElement("small");
                corner.setAttribute("aria-hidden", "true");
                const rank = document.createElement("span");
                rank.textContent = card.rank;
                const suit = document.createElement("span");
                suit.textContent = card.symbol;
                corner.append(rank, suit);
                node.append(center, corner);
            }
            els.cardsHeld.appendChild(node);
        }

        Array.from(els.cardsHeld.children).forEach((node, index) => {
            node.style.setProperty("--tilt", `${(index - (descriptors.length - 1) / 2) * 2.2}deg`);
            // Every card announces itself. Without this the live region read out
            // the raw glyphs — a king of spades arrived as "♠ K ♠".
            node.setAttribute(
                "aria-label",
                concealed
                    ? `Hidden card ${index + 1} of ${descriptors.length}`
                    : `${descriptors[index].card.rank} of ${descriptors[index].card.suit}`,
            );
            node.setAttribute("role", "img");
        });
    }

    function renderGame(room) {
        const round = room.currentRound || { number: 1, cards: [], pot: 0, bustChance: 0 };
        const decision = room.decision || {};
        const concealed = Boolean(round.concealed && !room.canPlay);
        els.currentPlayerName.textContent = room.currentPlayer?.displayName || "—";
        els.roundBadge.textContent = `Round ${round.number} of ${room.roundsPerPlayer}`;
        const cardScope = `${room.id}:${room.currentPlayer?.id || "none"}:${round.number}:${concealed ? "sealed" : "open"}`;
        renderCards(round.cards || [], concealed ? (round.cardCount || 0) : null, cardScope);
        els.currentPot.textContent = concealed ? "Sealed" : (round.pot || 0);
        els.currentPotUnit.textContent = concealed ? "" : " pts";
        els.bustChance.textContent = concealed ? "Hidden" : F.bustCopy(round.bustChance);
        els.bankPosition.textContent = concealed
            ? "After reveal"
            : (decision.bankPosition ? F.ordinal(decision.bankPosition) : "—");
        // These stats describe the player at the table, so only phrase them in
        // the second person when the viewer is that player.
        els.scoreToBeat.textContent = concealed
            ? "Sealed"
            : decision.isLeadingIfBanked
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
        els.resumeBotsButton.hidden = !(state.botPaused && room.mode === "test" && room.isHost);
        els.resumeBotsButton.disabled = state.actionBusy;

        // Bring the table to the manager the moment the turn becomes theirs.
        // Latch first: the scroll is deferred a frame, and several call sites
        // re-render straight after this one.
        const turnJustArrived = room.canPlay && !state.wasMyTurn;
        state.wasMyTurn = Boolean(room.canPlay);
        if (turnJustArrived) scrollToPlayStage();

        renderTurnMessage(room, round, concealed);
        renderLeaderboard(room);
    }

    // The room publishes its own last action, so the actor and every spectator
    // narrate the same moment from one source. This used to be stitched
    // together client-side from an action's private response plus a timer,
    // which meant a watcher never learned what ended somebody else's round.
    function renderTurnMessage(room, round, concealed) {
        const event = room.lastEvent;
        const describesTable = Boolean(event) && event.playerId === room.currentPlayer?.id;
        els.turnMessage.className = "turn-message";
        if (describesTable) {
            const tone = F.turnEventTone(event);
            if (tone) els.turnMessage.classList.add(tone);
            els.turnMessage.textContent = F.turnEventMessage(event, {
                isSelf: event.playerId === room.viewerPlayerId,
            });
            return;
        }
        if (state.botPaused && room.mode === "test" && room.isHost) {
            els.turnMessage.textContent = "Bots are paused. Resume them when you’re ready.";
            return;
        }
        if (room.canRunBot) {
            els.turnMessage.textContent = `${room.currentPlayer?.displayName || "A bot"} is playing automatically…`;
            return;
        }
        if (!room.canPlay) {
            els.turnMessage.textContent = concealed
                ? `${room.currentPlayer?.displayName || "The current player"} has pulled ${round.cardCount || 0} card${round.cardCount === 1 ? "" : "s"}. Values and score stay sealed for the reveal.`
                : `Watching ${room.currentPlayer?.displayName || "the current player"} live — every card and point appears here.`;
            return;
        }
        els.turnMessage.textContent = round.cards.length
            ? "Bank the pot or press your luck."
            : "Your turn. The first flip can’t bust.";
    }

    function renderLeaderboard(room) {
        els.leaderboard.innerHTML = "";
        const finalRound = room.currentRound?.number === room.roundsPerPlayer;
        els.leaderboardTitle.textContent = finalRound
            ? `Standings after Round ${room.roundsPerPlayer - 1}`
            : "The chase";
        els.pollNote.textContent = finalRound ? "Final scores sealed" : "Updates live";
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
            rounds.textContent = `${player.roundsCompleted}/${room.roundsPerPlayer} rounds${player.isCurrent ? " · up now" : ""}${player.scoreHidden ? " · final locked" : ""}`;
            info.append(name, rounds);
            const score = document.createElement("div");
            score.className = "leaderboard-score";
            if (finalRound) {
                score.classList.add("leaderboard-score--sealed");

                const finalLine = document.createElement("span");
                finalLine.className = "leaderboard-score__line leaderboard-score__line--final";
                const finalLabel = document.createElement("span");
                finalLabel.className = "leaderboard-score__label";
                finalLabel.textContent = "Final";
                const finalValue = document.createElement("strong");
                finalValue.className = "leaderboard-score__value";
                finalValue.textContent = "🔒";
                finalValue.setAttribute("role", "img");
                finalValue.setAttribute("aria-label", "Locked until reveal");
                finalLine.append(finalLabel, finalValue);

                const priorLine = document.createElement("span");
                priorLine.className = "leaderboard-score__line";
                const priorLabel = document.createElement("span");
                priorLabel.className = "leaderboard-score__label";
                priorLabel.textContent = `After R${room.roundsPerPlayer - 1}`;
                const priorValue = document.createElement("strong");
                priorValue.className = "leaderboard-score__value";
                priorValue.textContent = `${player.score}`;
                priorLine.append(priorLabel, priorValue);

                score.append(finalLine, priorLine);
            } else {
                score.textContent = `${player.score}`;
            }
            row.append(place, info, score);
            els.leaderboard.appendChild(row);
        });
    }

    function renderResults(room) {
        els.draftOrder.innerHTML = "";
        const isPractice = room.mode === "practice";
        const serverRevealed = isPractice || room.resultsRevealed;
        els.practiceAgainButton.hidden = !isPractice;
        els.copyResultsButton.hidden = isPractice;
        els.verifyButton.textContent = isPractice ? "Verify practice deal" : "Verify every deal";
        if (!serverRevealed) {
            els.resultKicker.textContent = "Final round complete · scores sealed";
            els.resultTitle.textContent = "The final table is locked.";
            els.resultCopy.textContent = room.canReveal
                ? "Every final-round score is hidden. Reveal the final draft order when everyone is ready."
                : "Every final-round score is hidden. Waiting for the host to begin the reveal.";
            els.revealButton.textContent = "Reveal final draft order";
            els.revealButton.hidden = !room.canReveal;
            els.revealButton.disabled = state.actionBusy;
            els.resultActions.hidden = true;
            return;
        }

        els.resultKicker.textContent = isPractice ? "Practice complete · seed revealed" : "Scores revealed · seed unlocked";
        els.resultTitle.textContent = isPractice ? "Five practice rounds complete." : "The draft order is ready.";
        els.resultCopy.textContent = isPractice
            ? `You scored ${room.draftOrder?.[0]?.score || 0} points. Run it again whenever you want another warm-up.`
            : "Revealing from the last pick to the first, followed by the proof behind every card.";
        els.revealButton.hidden = true;
        if (isPractice) state.resultsRevealed = true;
        els.resultActions.hidden = !state.resultsRevealed;
        if (!state.resultsRevealed) {
            animateResults(room);
        } else {
            (room.draftOrder || []).forEach((entry) => els.draftOrder.appendChild(resultRow(entry)));
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

    function animateResults(room) {
        if (!room?.draftOrder || state.resultsRevealed) return;
        state.resultsRevealed = true;
        els.revealButton.hidden = true;
        els.draftOrder.innerHTML = "";
        const sequence = [...room.draftOrder].reverse();
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

    async function revealResults() {
        if (state.actionBusy || !state.room?.canReveal) return;
        state.actionBusy = true;
        stopPolling();
        setButtonBusy(els.revealButton, true, "Opening the table");
        try {
            const room = await requestJson(`/sessions/${state.room.id}/reveal`, { method: "POST" });
            state.generation += 1;
            state.room = room;
            state.resultsRevealed = false;
            renderRoom();
        } catch (error) {
            handleActionError(error);
            schedulePoll();
        } finally {
            state.actionBusy = false;
            setButtonBusy(els.revealButton, false, "Opening the table");
        }
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

    // One card per request, paced by the client, so a spectator watches a bot's
    // hand build the same way a human's does. The pause after a round ends is
    // the server's now: it holds the finished hand and reports canRunBot false
    // until the table clears.
    async function playBotStep() {
        stopBotTimer();
        if (state.actionBusy || state.botPaused || !state.room?.canRunBot) return;
        state.actionBusy = true;
        stopPolling();
        try {
            const room = await requestJson(
                `/sessions/${state.room.id}/bots/step`,
                { method: "POST" },
            );
            state.generation += 1;
            state.room = room;
            renderRoom();
        } catch (error) {
            // Pause the bots rather than hammering a room that just rejected a
            // step, but keep the room live — this used to stop polling too,
            // which froze the whole view until a manual reload.
            state.botPaused = true;
            handleActionError(error);
        } finally {
            state.actionBusy = false;
            schedulePoll();
            if (state.room?.state === "active") renderGame(state.room);
            scheduleBotTurn(botThinkDelay());
        }
    }

    function resumeBots() {
        state.botPaused = false;
        showStatus("Bots resumed.");
        if (state.room?.state === "active") renderGame(state.room);
        scheduleBotTurn(BOT_TURN_START_MS);
    }

    async function performAction(path, button, busyLabel) {
        if (state.actionBusy || !state.room) return;
        state.actionBusy = true;
        setButtonBusy(button, true, busyLabel);
        try {
            const room = await requestJson(`/sessions/${state.room.id}/${path}`, { method: "POST" });
            state.generation += 1;
            state.room = room;
            renderRoom();
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
            draws.textContent = player.draws.length
                ? `Draws: ${player.draws.map((draw) => `R${draw.round} ${F.cardLabel(draw.card)} @${draw.deckIndex}`).join(" · ")}`
                : "Draws: none — no card was ever dealt to this manager";
            meta.append(tie, draws);
            // A round the host wrote off is the one thing about this game a
            // person can influence, so the proof has to say so out loud. It
            // used to look identical to a round somebody simply played badly.
            const rounds = document.createElement("ol");
            rounds.className = "verification-rounds";
            (player.rounds || []).forEach((round) => {
                const item = document.createElement("li");
                item.className = `round-line round-line--${round.state}`;
                const label = document.createElement("strong");
                label.textContent = `Round ${round.number}`;
                const outcome = document.createElement("span");
                outcome.className = "round-outcome";
                outcome.textContent = ROUND_STATE_COPY[round.state] || round.state;
                const cards = document.createElement("span");
                cards.className = "round-cards";
                cards.textContent = round.cards.length
                    ? round.cards.map((card) => F.cardLabel(card)).join(" ")
                    : "no cards dealt";
                const score = document.createElement("span");
                score.className = "round-points";
                score.textContent = `${round.score} pts`;
                item.append(label, outcome, cards, score);
                rounds.appendChild(item);
            });
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
            body.append(meta, rounds, deck, legend);
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
    els.resumeBotsButton.addEventListener("click", resumeBots);
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
