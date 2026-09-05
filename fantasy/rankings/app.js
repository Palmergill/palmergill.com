// Personal ranking boards (spec 18).
//
// There is exactly one ordered array on the client — state.entries, in overall
// order — and every list is a filtered view of it. "Keeping the five boards in
// sync" is not a code path that can be wrong here, because it is not a code
// path at all.
//
// Moves are sent as intent ("above this player", "at rank N"), never as sort
// keys: the server owns the key arithmetic, so two clients cannot disagree
// about it. Writes are optimistic but serialized through one promise chain —
// two drags a moment apart must not race each other into a self-inflicted 409.
(function () {
    "use strict";

    const F = window.RankingsFormat;
    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/rankings`;
    const SEARCH_DEBOUNCE_MS = 180;
    const DRAG_THRESHOLD_PX = 6;
    const AUTOSCROLL_EDGE_PX = 60;

    const byId = (id) => document.getElementById(id);

    const els = {
        errorBanner: byId("errorBanner"),
        noticeBanner: byId("noticeBanner"),
        loadingView: byId("loadingView"),
        signedOutView: byId("signedOutView"),
        boardsView: byId("boardsView"),
        editorView: byId("editorView"),
        readerView: byId("readerView"),
        siteConsensusButton: byId("siteConsensusButton"),
        signedOutConsensusButton: byId("signedOutConsensusButton"),
        signInLink: byId("signInLink"),
        createAccountLink: byId("createAccountLink"),
        boardList: byId("boardList"),
        scoringChips: byId("scoringChips"),
        rosterChips: byId("rosterChips"),
        createBoardButton: byId("createBoardButton"),
        boardTitle: byId("boardTitle"),
        boardMeta: byId("boardMeta"),
        savePill: byId("savePill"),
        publishButton: byId("publishButton"),
        shareLink: byId("shareLink"),
        resetButton: byId("resetButton"),
        backButton: byId("backButton"),
        scopeChips: byId("scopeChips"),
        playerSearch: byId("playerSearch"),
        playerSearchResults: byId("playerSearchResults"),
        addTierButton: byId("addTierButton"),
        helperButton: byId("helperButton"),
        helperPanel: byId("helperPanel"),
        helperMeta: byId("helperMeta"),
        helperSizeChips: byId("helperSizeChips"),
        helperCloseButton: byId("helperCloseButton"),
        helperCards: byId("helperCards"),
        helperEmpty: byId("helperEmpty"),
        helperSkipButton: byId("helperSkipButton"),
        helperUndoButton: byId("helperUndoButton"),
        helperRestartButton: byId("helperRestartButton"),
        boardCount: byId("boardCount"),
        rankList: byId("rankList"),
        boardEmptyState: byId("boardEmptyState"),
        liveRegion: byId("liveRegion"),
        readerEyebrow: byId("readerEyebrow"),
        readerTitle: byId("readerTitle"),
        readerMeta: byId("readerMeta"),
        readerBackButton: byId("readerBackButton"),
        readerScopeChips: byId("readerScopeChips"),
        consensusControls: byId("consensusControls"),
        consensusScoringChips: byId("consensusScoringChips"),
        consensusRosterChips: byId("consensusRosterChips"),
        readerNote: byId("readerNote"),
        readerList: byId("readerList"),
        readerEmptyState: byId("readerEmptyState"),
    };

    const state = {
        identity: null,
        boards: [],
        board: null,
        entries: [],
        tiers: [],
        scope: "OVERALL",
        consensusById: {},
        reader: null,
        readerScope: "OVERALL",
        newScoring: "ppr",
        newRoster: "1qb",
        // Bumped whenever the context changes, so a reply that arrives late for
        // a board we have navigated away from is discarded rather than drawn.
        generation: 0,
        // Invalidates queued intents without changing the page context (for
        // example after a 409 or failed write).
        writeEpoch: 0,
        // Every write queues behind the last one.
        writeChain: Promise.resolve(),
        pending: 0,
        savedAt: null,
        searchSeq: 0,
        consensusSeq: 0,
        searchTimer: null,
        // Keyboard "grab mode": a player picked up but not yet dropped.
        grabbed: null,
        focusPlayerId: null,
        // Head-to-head helper: one sweep of adjacent matchups down the list.
        helper: { open: false, size: 3, cursor: 0, picks: 0, changes: 0, last: null, wantsFocus: false },
    };

    // ── fetch ───────────────────────────────────────────────────────────────

    class ForbiddenError extends Error {}
    class CancelledWrite extends Error {}

    async function requestJson(path, options) {
        const response = await fetch(`${API_BASE}${path}`, {
            credentials: "include",
            headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
            ...options,
        });
        if (response.status === 204) return null;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 403) throw new ForbiddenError(detailMessage(data));
            const error = new Error(detailMessage(data));
            error.status = response.status;
            error.detail = data.detail;
            throw error;
        }
        return data;
    }

    // FastAPI sends a string detail for our own HTTPExceptions, an object for
    // the ones that carry a payload, and an array of validation objects for a
    // 422 — which would otherwise stringify into noise.
    function detailMessage(data) {
        const detail = data && data.detail;
        if (typeof detail === "string") return detail;
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
            return detail.message || "Something went wrong.";
        }
        if (Array.isArray(detail)) {
            const first = detail[0];
            if (first && first.msg) return first.msg;
        }
        return "Something went wrong.";
    }

    // ── chrome ──────────────────────────────────────────────────────────────

    function setView(name) {
        els.loadingView.hidden = name !== "loading";
        els.signedOutView.hidden = name !== "signedOut";
        els.boardsView.hidden = name !== "boards";
        els.editorView.hidden = name !== "editor";
        els.readerView.hidden = name !== "reader";
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = !message;
    }

    function showNotice(message) {
        els.noticeBanner.textContent = message;
        els.noticeBanner.hidden = !message;
    }

    function announce(message) {
        els.liveRegion.textContent = message;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function renderSavePill() {
        if (state.pending > 0) {
            els.savePill.textContent = "Saving…";
            els.savePill.className = "save-pill save-pill--busy";
            return;
        }
        els.savePill.className = "save-pill";
        els.savePill.textContent = F.formatSavedAt(state.savedAt, new Date());
    }

    // ── board list ──────────────────────────────────────────────────────────

    function renderChipRow(container, options, selected, onPick) {
        container.innerHTML = "";
        options.forEach((option) => {
            const chip = el("button", "chip", option.label);
            chip.type = "button";
            chip.setAttribute("aria-pressed", String(option.value === selected));
            chip.addEventListener("click", () => onPick(option.value));
            container.appendChild(chip);
        });
    }

    function renderNewBoardControls() {
        renderChipRow(
            els.scoringChips,
            [
                { value: "ppr", label: "PPR" },
                { value: "half", label: "Half PPR" },
                { value: "std", label: "Standard" },
            ],
            state.newScoring,
            (value) => {
                state.newScoring = value;
                renderNewBoardControls();
            }
        );
        renderChipRow(
            els.rosterChips,
            [
                { value: "1qb", label: "1QB" },
                { value: "superflex", label: "Superflex" },
            ],
            state.newRoster,
            (value) => {
                state.newRoster = value;
                renderNewBoardControls();
            }
        );
    }

    function renderBoardList() {
        els.boardList.innerHTML = "";
        if (!state.boards.length) {
            els.boardList.appendChild(
                el("p", "empty-state", "No boards yet. Pick a format below and start one.")
            );
            return;
        }
        state.boards.forEach((board) => {
            const card = el("article", "board-card");
            const link = el("button", "board-card__open", F.boardLabel(board));
            link.type = "button";
            link.addEventListener("click", () => openBoard(board.id));
            card.appendChild(link);

            const counts = F.POSITIONS.map(
                (position) => `${position} ${board.positionCounts[position] || 0}`
            ).join(" · ");
            card.appendChild(el("p", "board-card__meta", `${board.entryCount} players — ${counts}`));

            const saved = F.formatSavedAt(board.updatedAt, new Date());
            if (saved) card.appendChild(el("p", "board-card__saved", saved));
            if (board.published) {
                const publicLink = el("a", "board-card__share", "Published · view");
                publicLink.href = board.shareUrl;
                publicLink.target = "_blank";
                publicLink.rel = "noopener";
                card.appendChild(publicLink);
            }

            const remove = el("button", "board-card__delete", "Delete");
            remove.type = "button";
            remove.addEventListener("click", () => deleteBoard(board));
            card.appendChild(remove);

            els.boardList.appendChild(card);
        });
    }

    // ── the list ────────────────────────────────────────────────────────────

    function scopedEntries() {
        return F.scopeEntries(state.entries, state.scope);
    }

    function renderScopeChips() {
        renderChipRow(
            els.scopeChips,
            F.SCOPES.map((scope) => ({
                value: scope,
                label:
                    scope === "OVERALL"
                        ? `Overall (${state.entries.length})`
                        : `${scope} (${F.scopeEntries(state.entries, scope).length})`,
            })),
            state.scope,
            setScope
        );
    }

    function setScope(scope) {
        state.scope = scope;
        state.grabbed = null;
        state.focusPlayerId = null;
        resetHelperPass();
        const url = new URL(window.location.href);
        url.searchParams.set("scope", scope);
        window.history.replaceState({}, "", url);
        renderScopeChips();
        renderList();
    }

    function renderList() {
        const entries = scopedEntries();
        const labels = F.positionRanks(state.entries);
        els.rankList.innerHTML = "";
        els.boardEmptyState.hidden = entries.length > 0;
        els.boardCount.textContent = entries.length
            ? `${entries.length} ${state.scope === "OVERALL" ? "players" : state.scope + "s"}`
            : "";

        F.tierBands(state.entries, state.tiers, state.scope).forEach((band) => {
            if (band.tier) els.rankList.appendChild(renderTier(band.tier));
            band.players.forEach((entry) => {
                const index = entries.findIndex((row) => row.player_id === entry.player_id);
                els.rankList.appendChild(renderRow(entry, index, labels[entry.player_id]));
            });
        });

        // Restore focus after a re-render so keyboard moves do not drop the
        // caret back to the top of a three-hundred-row list.
        if (state.focusPlayerId) {
            const row = els.rankList.querySelector(`[data-player-id="${cssEscape(state.focusPlayerId)}"]`);
            if (row) row.focus({ preventScroll: true });
        }

        // The helper cards are a view of this same order, so they repaint with
        // it rather than keeping their own copy of who sits where.
        renderHelper();
    }

    function cssEscape(value) {
        return window.CSS && window.CSS.escape ? window.CSS.escape(value) : value;
    }

    function renderRow(entry, index, positionLabel) {
        const row = el("li", "rank-row");
        row.dataset.playerId = entry.player_id;
        row.tabIndex = state.focusPlayerId
            ? (state.focusPlayerId === entry.player_id ? 0 : -1)
            : (index === 0 ? 0 : -1);
        row.setAttribute("aria-roledescription", "reorderable ranking row");
        row.setAttribute("aria-describedby", "keyboardHint");
        if (state.grabbed === entry.player_id) row.classList.add("is-grabbed");

        const grip = el("button", "rank-row__grip");
        grip.type = "button";
        grip.tabIndex = -1;
        grip.setAttribute("aria-hidden", "true");
        grip.textContent = "⠿";
        grip.addEventListener("pointerdown", (event) => beginDrag(event, entry));
        row.appendChild(grip);

        const rank = el("input", "rank-row__jump");
        rank.type = "number";
        rank.min = "1";
        rank.inputMode = "numeric";
        rank.value = String(index + 1);
        rank.setAttribute("aria-label", `Move ${entry.name || "player"} to rank`);
        rank.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                rank.blur();
            }
        });
        rank.addEventListener("change", () => submitRankJump(entry, rank));
        row.appendChild(rank);

        const identity = el("div", "rank-row__identity");
        identity.appendChild(el("span", "rank-row__name", entry.name || "Unknown player"));
        const meta = el("span", "rank-row__meta");
        meta.textContent = [positionLabel, entry.team].filter(Boolean).join(" · ");
        identity.appendChild(meta);
        if (!entry.name) {
            // The catalog dropped him; the board keeps him until his owner says
            // otherwise.
            identity.appendChild(el("span", "rank-row__tombstone", "no longer in the player pool"));
        }
        row.appendChild(identity);

        const consensus = state.consensusById[entry.player_id];
        const delta = consensusDelta(entry);
        const deltaNode = el("span", "rank-row__delta", F.formatSigned(delta));
        if (delta > 0) deltaNode.classList.add("rank-row__delta--up");
        if (delta < 0) deltaNode.classList.add("rank-row__delta--down");
        deltaNode.title = consensus
            ? "Your rank compared with the published site consensus"
            : "No published site consensus yet";
        deltaNode.setAttribute(
            "aria-label",
            consensus
                ? delta > 0
                    ? `${delta} places above site consensus`
                    : delta < 0
                        ? `${Math.abs(delta)} places below site consensus`
                        : "Same as site consensus"
                : "No published site consensus"
        );
        row.appendChild(deltaNode);

        const nudges = el("div", "rank-row__nudges");
        nudges.appendChild(nudgeButton("▲", `Move ${entry.name || "player"} up`, () => nudge(entry, -1)));
        nudges.appendChild(nudgeButton("▼", `Move ${entry.name || "player"} down`, () => nudge(entry, 1)));
        row.appendChild(nudges);

        const remove = el("button", "rank-row__remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${entry.name || "player"} from the board`);
        remove.addEventListener("click", () => removePlayer(entry));
        row.appendChild(remove);

        row.addEventListener("keydown", (event) => onRowKeyDown(event, entry));
        row.addEventListener("focus", () => {
            state.focusPlayerId = entry.player_id;
        });
        return row;
    }

    // How far this player sits from the published site consensus, in the list
    // currently on screen. null when no consensus has been published yet.
    function consensusDelta(entry) {
        const consensus = state.consensusById[entry.player_id];
        if (!consensus) return null;
        const consensusRank =
            state.scope === "OVERALL" ? consensus.overallRank : consensus.positionRank;
        const currentRank = state.scope === "OVERALL" ? entry.overallRank : entry.positionRank;
        return consensusRank == null ? null : consensusRank - currentRank;
    }

    function renderTier(tier) {
        const row = el("li", "tier-row");
        row.dataset.tierId = String(tier.id);

        const grip = el("button", "tier-row__grip", "⠿");
        grip.type = "button";
        grip.setAttribute("aria-label", `Move tier ${tier.label}`);
        grip.addEventListener("pointerdown", (event) => beginDrag(event, tier, "tier"));
        grip.addEventListener("keydown", (event) => {
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            const scoped = scopedEntries();
            const current = tier.beforePlayerId
                ? scoped.findIndex((entry) => entry.player_id === tier.beforePlayerId)
                : scoped.length;
            moveTierToIndex(tier, current + (event.key === "ArrowUp" ? -1 : 1));
        });
        row.appendChild(grip);

        const label = el("input", "tier-row__label");
        label.type = "text";
        label.maxLength = 60;
        label.value = tier.label;
        label.setAttribute("aria-label", "Tier name");
        label.addEventListener("change", () => renameTier(tier, label.value));
        row.appendChild(label);

        const remove = el("button", "tier-row__remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Delete tier ${tier.label}`);
        remove.addEventListener("click", () => removeTier(tier));
        row.appendChild(remove);
        return row;
    }

    function nudgeButton(glyph, label, onClick) {
        const button = el("button", "rank-row__nudge", glyph);
        button.type = "button";
        button.setAttribute("aria-label", label);
        button.addEventListener("click", onClick);
        return button;
    }

    // ── moves ───────────────────────────────────────────────────────────────

    // Every move funnels through here: drag, nudge, jump and keyboard all
    // reduce to "put this player at index N of the list I am looking at".
    function moveToIndex(entry, targetIndex, options) {
        const scoped = scopedEntries();
        const from = scoped.findIndex((e) => e.player_id === entry.player_id);
        const bounded = Math.max(0, Math.min(targetIndex, scoped.length - 1));
        if (from === bounded) return;

        if (!options?.keepHelperUndo) state.helper.last = null;
        const previous = state.entries.slice();
        applyLocalMove(entry, bounded);
        renderList();

        const labels = F.positionRanks(state.entries);
        announce(F.describeMove(entry.name, from + 1, bounded + 1, labels[entry.player_id]));

        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/entries/${encodeURIComponent(entry.player_id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                        revision: context.revision,
                        scope: context.scope,
                        to_rank: bounded + 1,
                    }),
                }),
            previous
        );
    }

    function applyLocalMove(entry, targetIndexInScope) {
        const overallIds = state.entries.map((e) => e.player_id);
        const byId = new Map(state.entries.map((e) => [e.player_id, e]));
        let order;
        if (state.scope === "OVERALL") {
            order = F.moveWithin(overallIds, entry.player_id, targetIndexInScope);
        } else {
            const target = F.projectOverallMove(
                state.entries,
                entry.player_id,
                state.scope,
                targetIndexInScope
            );
            order = F.moveWithin(overallIds, entry.player_id, target);
        }
        state.entries = order.map((id) => byId.get(id));
        recomputeRanks();
    }

    function recomputeRanks() {
        const seen = {};
        state.entries.forEach((entry, index) => {
            seen[entry.position] = (seen[entry.position] || 0) + 1;
            entry.overallRank = index + 1;
            entry.positionRank = seen[entry.position];
        });
    }

    function snapshotBoardState() {
        return { entries: state.entries.slice(), tiers: state.tiers.map((tier) => ({ ...tier })) };
    }

    function restoreBoardState(snapshot) {
        if (Array.isArray(snapshot)) {
            state.entries = snapshot;
        } else if (snapshot) {
            state.entries = snapshot.entries;
            state.tiers = snapshot.tiers;
        }
        recomputeRanks();
        renderScopeChips();
        renderList();
    }

    function nudge(entry, offset) {
        const scoped = scopedEntries();
        const from = scoped.findIndex((e) => e.player_id === entry.player_id);
        if (from === -1) return;
        moveToIndex(entry, from + offset);
    }

    function submitRankJump(entry, input) {
        const requested = parseInt(input.value, 10);
        if (Number.isNaN(requested)) {
            renderList();
            return;
        }
        moveToIndex(entry, requested - 1);
    }

    async function removePlayer(entry) {
        state.helper.last = null;
        const previous = state.entries.slice();
        state.entries = state.entries.filter((e) => e.player_id !== entry.player_id);
        recomputeRanks();
        renderScopeChips();
        renderList();
        announce(`${entry.name || "Player"} removed.`);
        queueWrite(
            (context) =>
                requestJson(
                    `/boards/${context.boardId}/entries/${encodeURIComponent(entry.player_id)}` +
                        `?revision=${context.revision}`,
                    { method: "DELETE" }
                ),
            previous
        );
    }

    // Optimistic, but with no retry queue: replaying a stale positional intent
    // after other moves have landed is how a board gets quietly corrupted. A
    // failed write rolls back and says so.
    function queueWrite(run, previousEntries, onSuccess) {
        state.pending += 1;
        renderSavePill();
        const context = {
            generation: state.generation,
            epoch: state.writeEpoch,
            boardId: state.board.id,
            scope: state.scope,
        };
        let committed = false;

        state.writeChain = state.writeChain
            .then(() => {
                if (
                    context.generation !== state.generation ||
                    context.epoch !== state.writeEpoch ||
                    !state.board ||
                    context.boardId !== state.board.id
                ) {
                    throw new CancelledWrite();
                }
                return run({ ...context, revision: state.board.revision });
            })
            .then(async (result) => {
                committed = true;
                if (
                    context.generation !== state.generation ||
                    context.epoch !== state.writeEpoch ||
                    !state.board ||
                    context.boardId !== state.board.id
                ) return;
                state.board.revision = result.revision;
                if (Array.isArray(result.tiers)) {
                    state.tiers = result.tiers;
                    // A player crossing a divider changes which player follows
                    // that fixed cut point, so the server's tier anchors must
                    // be painted even when the player order was optimistic.
                    renderList();
                }
                state.savedAt = new Date();
                showError("");
                try {
                    if (onSuccess) await onSuccess(result);
                    if (result.renormalized) {
                        // The server respread every key. Its order is authoritative
                        // now; stop trusting the local prediction.
                        await refreshBoard();
                    }
                } catch (error) {
                    showError("Saved, but couldn't refresh the latest board. Reload to verify it.");
                }
            })
            .catch((error) => {
                if (error instanceof CancelledWrite || committed) return undefined;
                if (context.generation !== state.generation) return undefined;
                // Every later optimistic intent was derived from state that
                // included this failed write. Cancel rather than replay it.
                state.writeEpoch += 1;
                if (error.status === 409) {
                    const board = error.detail && error.detail.board;
                    if (board) {
                        adoptBoard(board);
                        showNotice(
                            "This board changed somewhere else. Reloaded the latest order — your last move wasn't applied."
                        );
                        return undefined;
                    }
                }
                restoreBoardState(previousEntries);
                showError(error.message || "Couldn't save that move.");
                return undefined;
            })
            .finally(() => {
                state.pending = Math.max(0, state.pending - 1);
                renderSavePill();
            });
    }

    // A tier cuts the list where the person is already working: above the row
    // they last touched, and only at the top when they have not touched one.
    // Landing every divider at rank 1 meant dragging it back down each time.
    function addTier() {
        const scoped = scopedEntries();
        const focused = state.focusPlayerId
            ? scoped.findIndex((entry) => entry.player_id === state.focusPlayerId)
            : -1;
        const rank = focused === -1 ? 1 : focused + 1;
        const suggested = `Tier ${state.tiers.filter((tier) => tier.scope === state.scope).length + 1}`;
        const label = window.prompt("Name this tier", suggested);
        if (label == null || !label.trim()) return;
        const previous = snapshotBoardState();
        const name = label.trim();
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/tiers`, {
                    method: "POST",
                    body: JSON.stringify({
                        revision: context.revision,
                        scope: context.scope,
                        label: name,
                        to_rank: rank,
                    }),
                }),
            previous,
            () => {
                renderList();
                const below = scoped[rank - 1];
                announce(
                    below && below.name
                        ? `${name} added above ${below.name}.`
                        : `${name} added.`
                );
            }
        );
    }

    function renameTier(tier, label) {
        const value = label.trim();
        if (!value || value === tier.label) {
            renderList();
            return;
        }
        const previous = snapshotBoardState();
        tier.label = value;
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/tiers/${tier.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ revision: context.revision, label: value }),
                }),
            previous,
            () => {
                renderList();
                announce(`Tier renamed ${value}.`);
            }
        );
    }

    function moveTierToIndex(tier, targetIndex) {
        const scoped = scopedEntries();
        const bounded = Math.max(0, Math.min(targetIndex, scoped.length));
        const previous = snapshotBoardState();
        tier.beforePlayerId = scoped[bounded] ? scoped[bounded].player_id : null;
        renderList();
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/tiers/${tier.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ revision: context.revision, to_rank: bounded + 1 }),
                }),
            previous,
            () => {
                renderList();
                announce(`${tier.label} moved.`);
            }
        );
    }

    function movePlayerToCombinedIndex(entry, targetIndex) {
        const plan = F.planCombinedPlayerMove(
            state.entries, state.tiers, state.scope, entry.player_id, targetIndex
        );
        if (!plan || plan.unchanged) return;
        state.helper.last = null;
        const previous = snapshotBoardState();
        applyLocalMove(entry, plan.playerIndex);

        // Convert the optimistic combined order back into the API's stable
        // "tier sits above this player" representation.
        state.tiers = state.tiers.map((tier) =>
            tier.scope === state.scope && Object.prototype.hasOwnProperty.call(plan.tierAnchors, tier.id)
                ? { ...tier, beforePlayerId: plan.tierAnchors[tier.id] }
                : tier
        );
        renderList();

        announce(
            plan.previous && plan.previous.kind === "tier"
                ? `${entry.name || "Player"} moved below ${plan.previous.value.label}.`
                : plan.next && plan.next.kind === "tier"
                    ? `${entry.name || "Player"} moved above ${plan.next.value.label}.`
                    : `${entry.name || "Player"} moved to ${plan.playerIndex + 1}.`
        );
        queueWrite(
            (context) =>
                requestJson(
                    `/boards/${context.boardId}/entries/${encodeURIComponent(entry.player_id)}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            revision: context.revision,
                            scope: context.scope,
                            ...plan.placement,
                        }),
                    }
                ),
            previous
        );
    }

    function removeTier(tier) {
        if (!window.confirm(`Delete the ${tier.label} tier divider?`)) return;
        const previous = snapshotBoardState();
        state.tiers = state.tiers.filter((row) => row.id !== tier.id);
        renderList();
        queueWrite(
            (context) =>
                requestJson(
                    `/boards/${context.boardId}/tiers/${tier.id}?revision=${context.revision}`,
                    { method: "DELETE" }
                ),
            previous,
            () => announce(`${tier.label} deleted.`)
        );
    }

    // ── head-to-head helper ─────────────────────────────────────────────────
    //
    // Dragging three hundred rows into order is not how anybody decides what
    // they think; arguing about two players is. The helper asks "who would you
    // draft first?" about neighbours in the list currently on screen and lets
    // the answer do the reordering — one sweep from the top down, so a pass
    // always ends and every question is between players close enough for the
    // answer to be worth something.
    //
    // A pick is not a special kind of edit: it funnels through moveToIndex like
    // a drag or a nudge, so it inherits the optimistic render, the serialized
    // write queue and the announcement without a second code path.

    function currentMatchup() {
        return F.matchupAt(state.entries, state.scope, state.helper.cursor, state.helper.size);
    }

    // "players" for the overall board, "receivers" for a positional list — the
    // scope label itself reads wrong in a sentence ("two overall").
    function listNoun() {
        return state.scope === "OVERALL" ? "players" : F.scopeLabel(state.scope).toLowerCase();
    }

    function resetHelperPass() {
        state.helper.cursor = 0;
        state.helper.picks = 0;
        state.helper.changes = 0;
        state.helper.last = null;
    }

    function setHelperOpen(open) {
        state.helper.open = open;
        els.helperPanel.hidden = !open;
        els.helperButton.setAttribute("aria-expanded", String(open));
        els.helperButton.textContent = open ? "Close helper" : "Rank helper";
        if (open) {
            resetHelperPass();
            state.helper.wantsFocus = true;
            renderHelper();
        }
    }

    function setHelperSize(size) {
        state.helper.size = size;
        // A wider window starting from the same cursor asks a different
        // question, so the pending undo no longer describes what is on screen.
        state.helper.last = null;
        state.helper.wantsFocus = true;
        renderHelper();
    }

    function renderHelper() {
        if (!state.helper.open) return;
        const active = document.activeElement;
        const focusedPlayerId = els.helperCards.contains(active)
            ? active.dataset.playerId
            : null;
        renderChipRow(
            els.helperSizeChips,
            [{ value: 2, label: "Two up" }, { value: 3, label: "Three up" }],
            state.helper.size,
            setHelperSize
        );
        els.helperUndoButton.hidden = !state.helper.last;

        const scoped = scopedEntries();
        const total = F.matchupTotal(scoped.length, state.helper.size);
        const matchup = currentMatchup();
        els.helperCards.innerHTML = "";

        if (!matchup) {
            els.helperCards.hidden = true;
            els.helperEmpty.hidden = false;
            els.helperSkipButton.disabled = true;
            els.helperEmpty.textContent = scoped.length < 2
                ? `Add at least two ${listNoun()} to compare them.`
                : `Pass complete — ${state.helper.picks} ${state.helper.picks === 1 ? "matchup" : "matchups"}, ` +
                  `${state.helper.changes} ${state.helper.changes === 1 ? "change" : "changes"}. ` +
                  "Start over to run the list again, now that it has moved.";
            els.helperMeta.textContent = `${F.scopeLabel(state.scope)} · ${total} ${total === 1 ? "matchup" : "matchups"} in a pass`;
            if (state.helper.wantsFocus || focusedPlayerId) {
                state.helper.wantsFocus = false;
                (scoped.length < 2 ? els.helperCloseButton : els.helperRestartButton)
                    .focus({ preventScroll: true });
            }
            return;
        }

        els.helperCards.hidden = false;
        els.helperEmpty.hidden = true;
        els.helperSkipButton.disabled = false;
        els.helperMeta.textContent =
            `${F.scopeLabel(state.scope)} · matchup ${matchup.start + 1} of ${total}` +
            (state.helper.changes ? ` · ${state.helper.changes} moved` : "");

        const labels = F.positionRanks(state.entries);
        matchup.players.forEach((entry, offset) => {
            els.helperCards.appendChild(
                renderMatchupCard(entry, matchup.start + offset, offset, labels[entry.player_id])
            );
        });

        if (state.helper.wantsFocus || focusedPlayerId) {
            state.helper.wantsFocus = false;
            const previous = focusedPlayerId
                ? els.helperCards.querySelector(`[data-player-id="${cssEscape(focusedPlayerId)}"]`)
                : null;
            const target = previous || els.helperCards.querySelector(".helper-card");
            if (target) target.focus({ preventScroll: true });
        }
    }

    function renderMatchupCard(entry, index, offset, positionLabel) {
        const card = el("button", "helper-card");
        card.type = "button";
        card.dataset.playerId = entry.player_id;
        card.setAttribute(
            "aria-label",
            `Pick ${entry.name || "player"}, currently number ${index + 1} of your ${listNoun()}`
        );
        card.addEventListener("click", () => pickMatchup(entry.player_id));

        const head = el("span", "helper-card__head");
        head.appendChild(el("span", "helper-card__key", String(offset + 1)));
        head.appendChild(el("span", "helper-card__rank", `Your #${index + 1}`));
        card.appendChild(head);

        card.appendChild(el("span", "helper-card__name", entry.name || "Unknown player"));
        card.appendChild(
            el("span", "helper-card__meta", [positionLabel, entry.team].filter(Boolean).join(" · "))
        );

        const delta = consensusDelta(entry);
        const note = el(
            "span",
            "helper-card__delta",
            delta == null ? "No site consensus yet" : `${F.formatSigned(delta)} vs consensus`
        );
        if (delta > 0) note.classList.add("helper-card__delta--up");
        if (delta < 0) note.classList.add("helper-card__delta--down");
        card.appendChild(note);

        if (entry.injury_status) {
            card.appendChild(el("span", "helper-card__injury", entry.injury_status));
        }
        return card;
    }

    function beatenNames(beaten) {
        const names = beaten.map((entry) => entry.name || "an unnamed player");
        if (names.length < 2) return names[0] || "";
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }

    function pickMatchup(winnerId) {
        const matchup = currentMatchup();
        const plan = F.planMatchupPick(matchup, winnerId);
        if (!plan) return;

        state.helper.picks += 1;
        state.helper.cursor = matchup.start + 1;
        state.helper.wantsFocus = true;
        // The pick, not the list, has focus. Without this the re-render pulls
        // the caret back into the row the person last touched.
        state.focusPlayerId = null;

        if (plan.unchanged) {
            state.helper.last = null;
            announce(`${plan.winner.name || "Player"} stays ahead of ${beatenNames(plan.beaten)}.`);
            renderHelper();
            return;
        }

        state.helper.changes += 1;
        state.helper.last = {
            playerId: plan.winner.player_id,
            fromIndex: plan.fromIndex,
            cursor: matchup.start,
        };
        // Renders the list, and the helper with it.
        moveToIndex(plan.winner, plan.toIndex, { keepHelperUndo: true });
    }

    function skipMatchup() {
        const matchup = currentMatchup();
        if (!matchup) return;
        state.helper.cursor = matchup.start + 1;
        state.helper.last = null;
        state.helper.wantsFocus = true;
        renderHelper();
    }

    // Only ever the pick immediately before: any other edit clears it, so the
    // index it wants to restore is still the index the player came from.
    function undoHelperPick() {
        const last = state.helper.last;
        if (!last) return;
        state.helper.last = null;
        state.helper.cursor = last.cursor;
        state.helper.picks = Math.max(0, state.helper.picks - 1);
        state.helper.changes = Math.max(0, state.helper.changes - 1);
        state.helper.wantsFocus = true;
        state.focusPlayerId = null;

        const scoped = scopedEntries();
        const entry = scoped.find((row) => row.player_id === last.playerId);
        const at = scoped.findIndex((row) => row.player_id === last.playerId);
        if (entry && at !== -1 && at !== last.fromIndex) {
            moveToIndex(entry, last.fromIndex);
            return;
        }
        renderHelper();
    }

    function restartHelperPass() {
        resetHelperPass();
        state.helper.wantsFocus = true;
        renderHelper();
        announce("Starting the matchups again from the top.");
    }

    function onHelperKeyDown(event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Escape") {
            setHelperOpen(false);
            els.helperButton.focus();
            return;
        }
        const slot = parseInt(event.key, 10);
        if (Number.isNaN(slot)) return;
        const matchup = currentMatchup();
        if (!matchup || slot < 1 || slot > matchup.players.length) return;
        event.preventDefault();
        pickMatchup(matchup.players[slot - 1].player_id);
    }

    // ── pointer drag ────────────────────────────────────────────────────────
    //
    // Pointer Events rather than HTML5 drag-and-drop: HTML5 DnD does not fire
    // on touch in iOS Safari at all, and reordering receivers on a phone is a
    // core use of this page. Pointer events also give us the drag image and an
    // unthrottled move stream, which a 300-row auto-scrolling list needs.
    //
    // Not virtualized on purpose — 300 <li> is not a performance problem, and a
    // virtual list would break both focus management and the rect cache below.

    const drag = {
        active: false,
        entry: null,
        kind: "player",
        pointerId: null,
        startY: 0,
        rows: [],
        fromIndex: 0,
        toIndex: 0,
        node: null,
        scrollFrame: null,
        scrollDelta: 0,
    };

    function beginDrag(event, entry, kind) {
        if (event.button != null && event.button !== 0) return;
        const dragKind = kind || "player";
        const row = event.currentTarget.closest(dragKind === "tier" ? ".tier-row" : ".rank-row");
        if (!row) return;
        event.preventDefault();

        drag.active = false;
        drag.entry = entry;
        drag.kind = dragKind;
        drag.pointerId = event.pointerId;
        drag.startY = event.clientY;
        drag.node = row;
        // Measured once: re-reading layout on every pointermove is what makes a
        // long list feel sticky.
        const selector = dragKind === "tier" ? ".rank-row" : ".rank-row, .tier-row";
        drag.rows = Array.from(els.rankList.querySelectorAll(selector)).map((node) => {
            const rect = node.getBoundingClientRect();
            return { node, top: rect.top, middle: rect.top + rect.height / 2, height: rect.height };
        });
        drag.fromIndex = dragKind === "tier"
            ? scopedEntries().findIndex((player) => player.player_id === entry.beforePlayerId)
            : drag.rows.findIndex((r) => r.node === row);
        if (drag.fromIndex < 0) drag.fromIndex = drag.rows.length;
        drag.toIndex = drag.fromIndex;

        event.currentTarget.setPointerCapture(event.pointerId);
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragEnd);
        window.addEventListener("pointercancel", cancelDrag);
        window.addEventListener("keydown", onDragKey, true);
    }

    function onDragMove(event) {
        if (drag.pointerId !== event.pointerId) return;
        const delta = event.clientY - drag.startY;
        if (!drag.active && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
        if (!drag.active) {
            drag.active = true;
            drag.node.classList.add("is-dragging");
            els.rankList.classList.add("is-reordering");
        }

        drag.node.style.transform = `translateY(${delta}px)`;
        const pointerY = event.clientY;
        let target = drag.kind === "tier" ? drag.rows.length : drag.rows.length - 1;
        for (let i = 0; i < drag.rows.length; i += 1) {
            if (pointerY < drag.rows[i].middle) {
                target = i;
                break;
            }
        }
        if (target !== drag.toIndex) {
            drag.toIndex = target;
            paintPlaceholder();
        }
        updateAutoScroll(pointerY);
    }

    function paintPlaceholder() {
        if (drag.kind === "tier") return;
        drag.rows.forEach((row, index) => {
            if (row.node === drag.node) return;
            let shift = 0;
            if (drag.fromIndex < drag.toIndex && index > drag.fromIndex && index <= drag.toIndex) {
                shift = -drag.rows[drag.fromIndex].height;
            } else if (drag.fromIndex > drag.toIndex && index >= drag.toIndex && index < drag.fromIndex) {
                shift = drag.rows[drag.fromIndex].height;
            }
            row.node.style.transform = shift ? `translateY(${shift}px)` : "";
        });
    }

    function updateAutoScroll(pointerY) {
        const top = pointerY - AUTOSCROLL_EDGE_PX;
        const bottom = window.innerHeight - AUTOSCROLL_EDGE_PX - pointerY;
        drag.scrollDelta = top < 0 ? Math.max(-18, top / 3) : bottom < 0 ? Math.min(18, -bottom / 3) : 0;
        if (drag.scrollDelta && drag.scrollFrame == null) {
            const step = () => {
                if (!drag.scrollDelta) {
                    drag.scrollFrame = null;
                    return;
                }
                window.scrollBy(0, drag.scrollDelta);
                drag.scrollFrame = window.requestAnimationFrame(step);
            };
            drag.scrollFrame = window.requestAnimationFrame(step);
        }
    }

    function onDragKey(event) {
        if (event.key === "Escape") cancelDrag();
    }

    function onDragEnd(event) {
        if (drag.pointerId !== event.pointerId) return;
        const { active, entry, toIndex } = drag;
        const kind = drag.kind;
        teardownDrag();
        if (!active) return;
        if (kind === "tier") moveTierToIndex(entry, toIndex);
        else movePlayerToCombinedIndex(entry, toIndex);
    }

    function cancelDrag() {
        const wasActive = drag.active;
        teardownDrag();
        if (wasActive) renderList();
    }

    function teardownDrag() {
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragEnd);
        window.removeEventListener("pointercancel", cancelDrag);
        window.removeEventListener("keydown", onDragKey, true);
        if (drag.scrollFrame != null) window.cancelAnimationFrame(drag.scrollFrame);
        drag.rows.forEach((row) => {
            row.node.style.transform = "";
        });
        if (drag.node) drag.node.classList.remove("is-dragging");
        els.rankList.classList.remove("is-reordering");
        drag.active = false;
        drag.entry = null;
        drag.kind = "player";
        drag.pointerId = null;
        drag.rows = [];
        drag.node = null;
        drag.scrollFrame = null;
        drag.scrollDelta = 0;
    }

    // ── keyboard ────────────────────────────────────────────────────────────
    //
    // A peer of the mouse, not a fallback. Alt+arrows are one-shot moves that
    // each cost a request; grab mode moves a player forty slots in one write.

    function onRowKeyDown(event, entry) {
        // Rank inputs and action buttons own their own keys. Row reordering is
        // active only when the row itself has focus.
        if (event.target !== event.currentTarget) return;
        const scoped = scopedEntries();
        const index = scoped.findIndex((e) => e.player_id === entry.player_id);
        if (index === -1) return;

        if (state.grabbed === entry.player_id) {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const target = index + (event.key === "ArrowUp" ? -1 : 1);
                repositionGrabbed(entry, target);
                return;
            }
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                dropGrabbed(entry);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                state.grabbed = null;
                state.grabbedFrom = null;
                state.entries = state.grabbedSnapshot || state.entries;
                recomputeRanks();
                renderList();
                announce("Move cancelled.");
                return;
            }
        }

        if (event.altKey) {
            const step = event.shiftKey ? 10 : 1;
            if (event.key === "ArrowUp") {
                event.preventDefault();
                moveToIndex(entry, index - step);
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveToIndex(entry, index + step);
                return;
            }
            if (event.key === "Home") {
                event.preventDefault();
                moveToIndex(entry, 0);
                return;
            }
            if (event.key === "End") {
                event.preventDefault();
                moveToIndex(entry, scoped.length - 1);
                return;
            }
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const next = scoped[index + (event.key === "ArrowUp" ? -1 : 1)];
            if (next) {
                state.focusPlayerId = next.player_id;
                const node = els.rankList.querySelector(`[data-player-id="${cssEscape(next.player_id)}"]`);
                if (node) node.focus();
            }
            return;
        }

        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            state.grabbed = entry.player_id;
            state.grabbedFrom = index;
            state.grabbedSnapshot = state.entries.slice();
            renderList();
            announce(`${entry.name || "Player"} picked up at ${index + 1}. Arrow keys to move, Enter to drop.`);
        }
    }

    // Grab mode reorders locally and writes once, on drop.
    function repositionGrabbed(entry, targetIndex) {
        const scoped = scopedEntries();
        const bounded = Math.max(0, Math.min(targetIndex, scoped.length - 1));
        const current = scoped.findIndex((row) => row.player_id === entry.player_id);
        if (current !== bounded) state.helper.last = null;
        applyLocalMove(entry, bounded);
        renderList();
        announce(`${bounded + 1}`);
    }

    function dropGrabbed(entry) {
        const scoped = scopedEntries();
        const to = scoped.findIndex((e) => e.player_id === entry.player_id);
        const from = state.grabbedFrom;
        const previous = state.grabbedSnapshot;
        state.grabbed = null;
        state.grabbedFrom = null;
        state.grabbedSnapshot = null;
        renderList();

        if (from === to) {
            announce("Dropped in the same place.");
            return;
        }
        const labels = F.positionRanks(state.entries);
        announce(F.describeMove(entry.name, from + 1, to + 1, labels[entry.player_id]));
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/entries/${encodeURIComponent(entry.player_id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                        revision: context.revision,
                        scope: context.scope,
                        to_rank: to + 1,
                    }),
                }),
            previous
        );
    }

    // ── player search ───────────────────────────────────────────────────────

    function onSearchInput() {
        const term = els.playerSearch.value.trim();
        window.clearTimeout(state.searchTimer);
        if (term.length < 2) {
            closeSearch();
            return;
        }
        state.searchTimer = window.setTimeout(() => runSearch(term), SEARCH_DEBOUNCE_MS);
    }

    async function runSearch(term) {
        const seq = (state.searchSeq += 1);
        try {
            const data = await requestJson(
                `/players/search?q=${encodeURIComponent(term)}&season=${state.board.season}` +
                    `&scoring=${encodeURIComponent(state.board.scoring)}&limit=12`
            );
            // A slower earlier request must not overwrite a newer reply.
            if (seq !== state.searchSeq) return;
            renderSearchResults(data.results || []);
        } catch (error) {
            if (seq === state.searchSeq) closeSearch();
        }
    }

    function renderSearchResults(players) {
        const onBoard = new Set(state.entries.map((e) => e.player_id));
        const options = (Array.isArray(players) ? players : []).filter(
            (player) => F.POSITIONS.includes(player.position) && !onBoard.has(player.player_id)
        );
        els.playerSearchResults.innerHTML = "";
        if (!options.length) {
            // Silence here reads as "no such player", which is wrong and
            // confusing when the real answer is that he is already ranked.
            const total = Array.isArray(players) ? players.length : 0;
            const item = el("li", "search-results__empty");
            item.textContent = total
                ? "Everyone matching that is already on your board."
                : "No players match that.";
            els.playerSearchResults.appendChild(item);
            els.playerSearchResults.hidden = false;
            els.playerSearch.setAttribute("aria-expanded", "true");
            return;
        }
        options.forEach((player) => {
            const item = el("li", "search-results__item");
            item.setAttribute("role", "option");
            const button = el(
                "button",
                "search-results__button",
                `${player.name} — ${player.position}${player.team ? ` · ${player.team}` : ""}`
            );
            button.type = "button";
            button.addEventListener("click", () => addPlayer(player));
            item.appendChild(button);
            els.playerSearchResults.appendChild(item);
        });
        els.playerSearchResults.hidden = false;
        els.playerSearch.setAttribute("aria-expanded", "true");
    }

    function closeSearch() {
        els.playerSearchResults.innerHTML = "";
        els.playerSearchResults.hidden = true;
        els.playerSearch.setAttribute("aria-expanded", "false");
    }

    function addPlayer(player) {
        closeSearch();
        els.playerSearch.value = "";
        const previous = snapshotBoardState();
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/entries`, {
                    method: "POST",
                    body: JSON.stringify({
                        player_id: player.player_id,
                        revision: context.revision,
                        scope: "OVERALL",
                    }),
                }),
            previous,
            async (result) => {
                if (!result.renormalized) await refreshBoard();
                announce(`${player.name} added to the bottom of the board.`);
            }
        );
    }

    // ── board lifecycle ─────────────────────────────────────────────────────

    function adoptBoard(board) {
        state.searchSeq += 1;
        state.board = board;
        state.entries = board.entries.slice();
        state.tiers = (board.tiers || []).slice();
        state.consensusById = {};
        state.savedAt = board.updatedAt ? new Date(board.updatedAt) : null;
        // A board arriving whole — first open, or a 409 reload — invalidates
        // both the sweep position and the undo it was holding.
        resetHelperPass();
        els.boardTitle.textContent = board.title || "My rankings";
        els.boardMeta.textContent = F.boardLabel(board);
        recomputeRanks();
        renderScopeChips();
        renderList();
        renderSavePill();
        renderPublishControls();
    }

    function renderPublishControls() {
        const published = state.board && state.board.published;
        els.publishButton.textContent = published ? "Unpublish" : "Publish";
        els.shareLink.hidden = !published;
        if (published) els.shareLink.href = state.board.shareUrl;
    }

    async function loadConsensusForBoard(board) {
        const seq = (state.consensusSeq += 1);
        try {
            const consensus = await requestJson(
                `/consensus?season=${board.season}&scoring=${encodeURIComponent(board.scoring)}` +
                    `&roster=${encodeURIComponent(board.roster)}`
            );
            if (seq !== state.consensusSeq || !state.board || state.board.id !== board.id) return;
            state.consensusById = Object.fromEntries(
                (consensus.entries || []).map((entry) => [entry.player_id, entry])
            );
            renderList();
        } catch (_error) {
            if (seq === state.consensusSeq && state.board && state.board.id === board.id) {
                state.consensusById = {};
                renderList();
            }
        }
    }

    function togglePublish() {
        const publishing = !state.board.published;
        if (!publishing && !window.confirm("Unpublish this board? Its shared link will stop working.")) {
            return;
        }
        const previous = snapshotBoardState();
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                        revision: context.revision,
                        published: publishing,
                    }),
                }),
            previous,
            (board) => {
                state.board = board;
                state.entries = board.entries.slice();
                state.tiers = (board.tiers || []).slice();
                renderPublishControls();
                renderList();
                showNotice(
                    publishing
                        ? "Published. Anyone with the shared link can now read this board."
                        : "Unpublished. The shared link no longer opens this board."
                );
                loadConsensusForBoard(board);
            }
        );
    }

    async function refreshBoard() {
        const generation = state.generation;
        const boardId = state.board.id;
        const board = await requestJson(`/boards/${boardId}`);
        if (generation !== state.generation || !state.board || state.board.id !== boardId) return;
        adoptBoard(board);
        loadConsensusForBoard(board);
    }

    async function openBoard(boardId) {
        const generation = (state.generation += 1);
        showError("");
        showNotice("");
        setView("loading");
        try {
            const board = await requestJson(`/boards/${boardId}`);
            if (generation !== state.generation) return;
            adoptBoard(board);
            loadConsensusForBoard(board);
            const url = new URL(window.location.href);
            url.searchParams.delete("share");
            url.searchParams.delete("view");
            url.searchParams.set("board", String(boardId));
            window.history.replaceState({}, "", url);
            setView("editor");
        } catch (error) {
            if (generation !== state.generation) return;
            showError(error.message);
            try {
                await loadBoards();
            } catch (_listError) {
                setView(error instanceof ForbiddenError ? "signedOut" : "boards");
            }
        }
    }

    async function createBoard() {
        showError("");
        els.createBoardButton.disabled = true;
        try {
            const board = await requestJson("/boards", {
                method: "POST",
                body: JSON.stringify({ scoring: state.newScoring, roster: state.newRoster }),
            });
            state.generation += 1;
            adoptBoard(board);
            loadConsensusForBoard(board);
            const url = new URL(window.location.href);
            url.searchParams.delete("share");
            url.searchParams.delete("view");
            url.searchParams.set("board", String(board.id));
            window.history.replaceState({}, "", url);
            setView("editor");
        } catch (error) {
            if (error.status === 409 && error.detail && error.detail.boardId) {
                showNotice("You already had a board for that format — opening it.");
                await openBoard(error.detail.boardId);
            } else {
                showError(error.message);
            }
        } finally {
            els.createBoardButton.disabled = false;
        }
    }

    async function deleteBoard(board) {
        const label = F.boardLabel(board);
        if (!window.confirm(`Delete your ${label} board? This cannot be undone.`)) return;
        try {
            await requestJson(`/boards/${board.id}`, { method: "DELETE" });
            await loadBoards();
        } catch (error) {
            showError(error.message);
        }
    }

    function resetBoard() {
        if (!window.confirm("Reset this board to the site consensus? Your order will be replaced.")) {
            return;
        }
        const previous = snapshotBoardState();
        queueWrite(
            (context) =>
                requestJson(`/boards/${context.boardId}/reset`, {
                    method: "POST",
                    body: JSON.stringify({ revision: context.revision }),
                }),
            previous,
            (board) => {
                adoptBoard(board);
                loadConsensusForBoard(board);
                announce("Board reset to the site consensus.");
            }
        );
    }

    async function loadBoards() {
        const generation = state.generation;
        const data = await requestJson("/boards/mine");
        if (generation !== state.generation) return;
        state.searchSeq += 1;
        state.board = null;
        state.entries = [];
        state.tiers = [];
        state.consensusById = {};
        state.boards = data.boards;
        renderBoardList();
        renderNewBoardControls();
        setView("boards");
    }

    // ── public readers ─────────────────────────────────────────────────────

    function renderReaderScopeChips() {
        const entries = state.reader ? state.reader.entries : [];
        renderChipRow(
            els.readerScopeChips,
            F.SCOPES.map((scope) => ({
                value: scope,
                label:
                    scope === "OVERALL"
                        ? `Overall (${entries.length})`
                        : `${scope} (${F.scopeEntries(entries, scope).length})`,
            })),
            state.readerScope,
            (scope) => {
                state.readerScope = scope;
                const url = new URL(window.location.href);
                url.searchParams.set("scope", scope);
                window.history.replaceState({}, "", url);
                renderReaderScopeChips();
                renderReaderList();
            }
        );
    }

    function renderReaderTier(tier) {
        const row = el("li", "tier-row tier-row--reader");
        row.appendChild(el("span", "tier-row__reader-label", tier.label));
        return row;
    }

    function renderReaderRow(entry, index) {
        const row = el("li", "rank-row rank-row--reader");
        row.appendChild(el("span", "reader-rank", String(index + 1)));
        const identity = el("div", "rank-row__identity");
        identity.appendChild(el("span", "rank-row__name", entry.name || "Unknown player"));
        const positionRank = entry.positionRank ? `${entry.position}${entry.positionRank}` : entry.position;
        identity.appendChild(
            el("span", "rank-row__meta", [positionRank, entry.team].filter(Boolean).join(" · "))
        );
        row.appendChild(identity);

        if (state.reader.kind === "consensus") {
            const average = el("span", "reader-stat", `Avg ${entry.averageRank}`);
            average.setAttribute("aria-label", `Average rank ${entry.averageRank}`);
            row.appendChild(average);
            const spread = el("span", "reader-stat", F.consensusSpread(entry));
            spread.title = "Best–worst published rank";
            spread.setAttribute("aria-label", `Published rank range ${F.consensusSpread(entry)}`);
            row.appendChild(spread);
            const appearances = el(
                "span", "reader-stat reader-stat--appearances", `${entry.appearances}/${entry.boardCount}`
            );
            appearances.setAttribute(
                "aria-label", `Appears on ${entry.appearances} of ${entry.boardCount} boards`
            );
            row.appendChild(appearances);
        }
        return row;
    }

    function renderReaderList() {
        const reader = state.reader;
        const entries = F.scopeEntries(reader ? reader.entries : [], state.readerScope);
        const tiers = reader && reader.kind === "shared" ? reader.tiers || [] : [];
        els.readerList.innerHTML = "";
        F.tierBands(reader ? reader.entries : [], tiers, state.readerScope).forEach((band) => {
            if (band.tier) els.readerList.appendChild(renderReaderTier(band.tier));
            band.players.forEach((entry) => {
                const index = entries.findIndex((row) => row.player_id === entry.player_id);
                els.readerList.appendChild(renderReaderRow(entry, index));
            });
        });
        els.readerEmptyState.hidden = entries.length > 0;
    }

    function adoptReader(reader) {
        state.reader = reader;
        els.consensusControls.hidden = reader.kind !== "consensus";
        els.readerEyebrow.textContent = reader.kind === "consensus" ? "Published boards" : "Shared board";
        if (reader.kind === "consensus") {
            els.readerTitle.textContent = "Site consensus";
            els.readerMeta.textContent = F.boardLabel(reader);
            els.readerNote.textContent = reader.boardCount
                ? `${reader.boardCount} published ${reader.boardCount === 1 ? "board" : "boards"}. ` +
                    `Players must appear on at least ${reader.appearanceFloor}. Avg is the mean rank; ` +
                    `the range is best–worst, and the last number is appearances.`
                : "Consensus appears after someone publishes a board for this format.";
            renderChipRow(
                els.consensusScoringChips,
                [
                    { value: "ppr", label: "PPR" },
                    { value: "half", label: "Half PPR" },
                    { value: "std", label: "Standard" },
                ],
                reader.scoring,
                (scoring) => openConsensus({ scoring, roster: reader.roster, season: reader.season })
            );
            renderChipRow(
                els.consensusRosterChips,
                [
                    { value: "1qb", label: "1QB" },
                    { value: "superflex", label: "Superflex" },
                ],
                reader.roster,
                (roster) => openConsensus({ scoring: reader.scoring, roster, season: reader.season })
            );
        } else {
            els.readerTitle.textContent = reader.owner
                ? reader.title || `${reader.owner}'s rankings`
                : "Shared board unavailable";
            els.readerMeta.textContent = reader.owner ? `${F.boardLabel(reader)} · by ${reader.owner}` : "";
            els.readerNote.textContent = reader.owner ? "Read-only published ranking board." : "";
        }
        renderReaderScopeChips();
        renderReaderList();
        setView("reader");
    }

    async function openShared(slug) {
        const generation = (state.generation += 1);
        setView("loading");
        try {
            const board = await requestJson(`/shared/${encodeURIComponent(slug)}`);
            if (generation !== state.generation) return;
            adoptReader({ ...board, kind: "shared" });
        } catch (error) {
            if (generation !== state.generation) return;
            showError(error.message);
            els.readerEmptyState.textContent = "That shared board is unavailable or no longer published.";
            adoptReader({ kind: "shared", entries: [], tiers: [], owner: "", season: "", scoring: "", roster: "" });
        }
    }

    async function openConsensus(overrides) {
        const generation = (state.generation += 1);
        showError("");
        setView("loading");
        const params = new URLSearchParams(window.location.search);
        const choices = overrides && !overrides.preventDefault ? overrides : {};
        const season = choices.season || (state.board ? state.board.season : params.get("season"));
        const scoring = choices.scoring || (state.board ? state.board.scoring : params.get("scoring")) || "ppr";
        const roster = choices.roster || (state.board ? state.board.roster : params.get("roster")) || "1qb";
        const query = new URLSearchParams({ scoring, roster });
        if (season) query.set("season", season);
        try {
            const consensus = await requestJson(`/consensus?${query.toString()}`);
            if (generation !== state.generation) return;
            adoptReader({ ...consensus, kind: "consensus", tiers: [] });
            const url = new URL(window.location.href);
            url.searchParams.delete("share");
            url.searchParams.delete("board");
            url.searchParams.set("view", "consensus");
            url.searchParams.set("season", consensus.season);
            url.searchParams.set("scoring", consensus.scoring);
            url.searchParams.set("roster", consensus.roster);
            window.history.replaceState({}, "", url);
        } catch (error) {
            if (generation !== state.generation) return;
            showError(error.message);
            setView("signedOut");
        }
    }

    async function leaveReader() {
        const url = new URL(window.location.href);
        ["share", "view", "season", "scoring", "roster"].forEach((key) => url.searchParams.delete(key));
        window.history.replaceState({}, "", url);
        if (state.board && state.board.revision != null) {
            url.searchParams.set("board", String(state.board.id));
            window.history.replaceState({}, "", url);
            setView("editor");
            return;
        }
        try {
            await loadBoards();
        } catch (error) {
            if (error instanceof ForbiddenError) setView("signedOut");
            else showError(error.message);
        }
    }

    function nextPath() {
        return window.location.pathname + window.location.search;
    }

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const requestedScope = (params.get("scope") || "OVERALL").toUpperCase();
        if (F.SCOPES.includes(requestedScope)) {
            state.scope = requestedScope;
            state.readerScope = requestedScope;
        }

        els.createBoardButton.addEventListener("click", createBoard);
        els.siteConsensusButton.addEventListener("click", openConsensus);
        els.signedOutConsensusButton.addEventListener("click", openConsensus);
        els.readerBackButton.addEventListener("click", leaveReader);
        els.publishButton.addEventListener("click", togglePublish);
        els.addTierButton.addEventListener("click", addTier);
        els.helperButton.addEventListener("click", () => setHelperOpen(!state.helper.open));
        els.helperCloseButton.addEventListener("click", () => {
            setHelperOpen(false);
            els.helperButton.focus();
        });
        els.helperSkipButton.addEventListener("click", skipMatchup);
        els.helperUndoButton.addEventListener("click", undoHelperPick);
        els.helperRestartButton.addEventListener("click", restartHelperPass);
        els.helperPanel.addEventListener("keydown", onHelperKeyDown);
        els.resetButton.addEventListener("click", resetBoard);
        els.backButton.addEventListener("click", () => {
            state.generation += 1;
            showNotice("");
            const url = new URL(window.location.href);
            ["board", "scope"].forEach((key) => url.searchParams.delete(key));
            window.history.replaceState({}, "", url);
            loadBoards().catch((error) => showError(error.message));
        });
        els.playerSearch.addEventListener("input", onSearchInput);
        els.playerSearch.addEventListener("blur", () => window.setTimeout(closeSearch, 150));

        try {
            const share = params.get("share");
            if (share) {
                await openShared(share);
                return;
            }
            if (params.get("view") === "consensus") {
                await openConsensus();
                return;
            }
            const requested = params.get("board");
            if (requested) {
                await openBoard(parseInt(requested, 10));
            } else {
                await loadBoards();
            }
        } catch (error) {
            if (error instanceof ForbiddenError) {
                const destination = encodeURIComponent(nextPath());
                els.signInLink.href = `/login/?next=${destination}`;
                els.createAccountLink.href = `/signup/?next=${destination}`;
                setView("signedOut");
                return;
            }
            showError(error.message);
            setView("boards");
        }
    }

    document.addEventListener("DOMContentLoaded", init);
})();
