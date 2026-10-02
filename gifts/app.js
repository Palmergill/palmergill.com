// Gift board (spec 21). One column per person, the caller's own wishlist
// first, with a graph view of the same data (graph.js) and a Wishlists tab for
// browsing what other members want. Every byte of data comes from
// /api/gifts/*; the page itself is an empty shell that anonymous visitors see
// as a teaser.
//
// Routes live in the hash: "" is your board, #wishlists the member list, and
// #wishlist/<username> one member's wishlist, so members can share links.
(function () {
    "use strict";

    const API_BASE = window.API_ORIGIN || "";
    const HIDE_DONE_KEY = "gifts.hideDone";
    const VIEW_KEY = "gifts.view";
    const ME = "me";

    const STATUS_LABELS = {
        idea: "Idea",
        bought: "Bought",
        given: "Given",
        wanted: "Wanted",
        received: "Got it",
    };
    const IDEA_STATUSES = ["idea", "bought", "given"];
    const WISHLIST_STATUSES = ["wanted", "received"];
    const DONE_STATUSES = new Set(["given", "received"]);

    const byId = (id) => document.getElementById(id);
    const els = {
        loadingView: byId("loadingView"),
        signedOutView: byId("signedOutView"),
        boardView: byId("boardView"),
        boardActions: byId("boardActions"),
        board: byId("board"),
        graph: byId("graph"),
        graphLegend: byId("graphLegend"),
        tabs: byId("tabs"),
        boardTab: byId("boardTab"),
        wishlistsTab: byId("wishlistsTab"),
        boardViewButton: byId("boardViewButton"),
        graphViewButton: byId("graphViewButton"),
        wishlistsView: byId("wishlistsView"),
        memberGrid: byId("memberGrid"),
        wishlistsEmpty: byId("wishlistsEmpty"),
        wishlistView: byId("wishlistView"),
        wishlistTitle: byId("wishlistTitle"),
        wishlistActions: byId("wishlistActions"),
        wishList: byId("wishList"),
        wishlistEmpty: byId("wishlistEmpty"),
        errorBanner: byId("errorBanner"),
        liveRegion: byId("liveRegion"),
        hideDoneToggle: byId("hideDoneToggle"),
        signInLink: byId("signInLink"),
        itemEditor: byId("itemEditor"),
        itemForm: byId("itemForm"),
        editorHeading: byId("editorHeading"),
        editorError: byId("editorError"),
        publicWarning: byId("publicWarning"),
        givenFields: byId("givenFields"),
        moveUp: byId("moveUp"),
        moveDown: byId("moveDown"),
        personEditor: byId("personEditor"),
        personForm: byId("personForm"),
        personError: byId("personError"),
    };

    const state = {
        me: null,
        loaded: false,
        people: [],
        items: [],
        hideDone: readPref(HIDE_DONE_KEY) === "1",
        view: readPref(VIEW_KEY) === "graph" ? "graph" : "board",
        // The wishlist on screen, so a "Save as idea" can redraw it.
        wishlist: null,
        // Guards against a slow wishlist response landing after the viewer
        // has already navigated somewhere else.
        wishlistSeq: 0,
        // Linked-wishlist sections the viewer has collapsed, by person id.
        collapsed: new Set(),
        // A graph node to focus once the graph redraws after an edit.
        focusNode: null,
        editingItemId: null,
        editingPersonId: null,
        dragItemId: null,
        // Re-focus a quick-add input after a re-render, so adding several
        // gifts in a row never leaves the keyboard.
        refocus: null,
    };

    // ── fetch ───────────────────────────────────────────────────────────────

    class ForbiddenError extends Error {}

    async function api(path, options = {}) {
        const response = await fetch(`${API_BASE}/api/gifts${path}`, {
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...options,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        if (response.status === 204) return null;
        const data = await response.json().catch(() => ({}));
        if (response.status === 403) throw new ForbiddenError(detailMessage(data));
        if (!response.ok) throw new Error(detailMessage(data));
        return data;
    }

    // FastAPI sends a string detail for our own errors and an array of
    // validation objects for a 422.
    function detailMessage(data) {
        const detail = data && data.detail;
        if (typeof detail === "string") return detail;
        if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
        return "Something went wrong. Try again.";
    }

    // Runs a write and folds any failure into the banner. A 403 mid-session
    // means the cookie expired, so the page falls back to the sign-in view.
    async function attempt(work) {
        try {
            hideError();
            return await work();
        } catch (error) {
            if (error instanceof ForbiddenError) {
                showSignedOut();
            } else {
                showError(error.message);
            }
            return undefined;
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function readPref(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (_error) {
            return null;
        }
    }

    function writePref(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (_error) {
            // A blocked store only costs the preference, not the board.
        }
    }

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        for (const child of [].concat(children)) {
            if (child === null || child === undefined || child === false) continue;
            node.append(child);
        }
        return node;
    }

    function announce(message) {
        els.liveRegion.textContent = "";
        window.requestAnimationFrame(() => {
            els.liveRegion.textContent = message;
        });
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = false;
    }

    function hideError() {
        els.errorBanner.hidden = true;
    }

    const priceFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

    function formatPrice(cents) {
        if (cents === null || cents === undefined) return "";
        const text = priceFormat.format(cents / 100);
        return cents % 100 === 0 ? text.replace(/\.00$/, "") : text;
    }

    // "$25", "25.99", "1,200" → cents. Blank → null. Anything else → NaN.
    function parsePrice(text) {
        const cleaned = String(text || "").replace(/[$,\s]/g, "");
        if (!cleaned) return null;
        if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return Number.NaN;
        return Math.round(Number(cleaned) * 100);
    }

    function safeHref(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url);
            return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
        } catch (_error) {
            return null;
        }
    }

    function hostOf(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (_error) {
            return "";
        }
    }

    // Dates come back as "YYYY-MM-DD". Parse as local dates so a birthday
    // never shifts a day for viewers west of UTC.
    function parseDate(text) {
        if (!text) return null;
        const [year, month, day] = text.split("-").map(Number);
        return new Date(year, month - 1, day);
    }

    function birthdayLabel(text) {
        const date = parseDate(text);
        if (!date) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let next = new Date(today.getFullYear(), date.getMonth(), date.getDate());
        if (next < today) next = new Date(today.getFullYear() + 1, date.getMonth(), date.getDate());
        const days = Math.round((next - today) / 86400000);
        const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        if (days === 0) return `Birthday today`;
        if (days <= 30) return `Birthday ${label} · in ${days} day${days === 1 ? "" : "s"}`;
        return `Birthday ${label}`;
    }

    function initials(name) {
        const parts = name.trim().split(/\s+/).filter(Boolean);
        const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
        return letters.toUpperCase();
    }

    function titleNode(title, url) {
        const href = safeHref(url);
        return href ? el("a", { href, target: "_blank", rel: "noopener noreferrer nofollow", text: title }) : title;
    }

    // Has this wishlist item already been copied into these ideas?
    function alreadySaved(ideas, wish) {
        const title = wish.title.trim().toLowerCase();
        return ideas.some((idea) => (wish.url && idea.url === wish.url) || idea.title.trim().toLowerCase() === title);
    }

    function columnKey(personId) {
        return personId === null || personId === undefined ? ME : String(personId);
    }

    function personIdFromKey(key) {
        return key === ME ? null : Number(key);
    }

    function itemsIn(key) {
        return state.items.filter((item) => columnKey(item.personId) === key);
    }

    function columnName(key) {
        if (key === ME) return "your wishlist";
        const person = state.people.find((p) => String(p.id) === key);
        return person ? person.name : "that list";
    }

    // ── views ───────────────────────────────────────────────────────────────

    function setView(name) {
        els.loadingView.hidden = name !== "loading";
        els.signedOutView.hidden = name !== "signedOut";
        els.boardView.hidden = name !== "board";
        els.wishlistsView.hidden = name !== "wishlists";
        els.wishlistView.hidden = name !== "wishlist";
        els.tabs.hidden = !["board", "wishlists", "wishlist"].includes(name);
        els.boardActions.hidden = name !== "board";
        const [current, other] = name === "board"
            ? [els.boardTab, els.wishlistsTab]
            : [els.wishlistsTab, els.boardTab];
        current.setAttribute("aria-current", "page");
        other.removeAttribute("aria-current");
    }

    function showSignedOut() {
        closeDialogs();
        // Keep the hash, so a shared #wishlist/<name> link survives sign-in.
        const next = `${window.location.pathname}${window.location.hash}`;
        els.signInLink.href = `/login/?next=${encodeURIComponent(next)}`;
        setView("signedOut");
    }

    function closeDialogs() {
        if (els.itemEditor.open) els.itemEditor.close();
        if (els.personEditor.open) els.personEditor.close();
    }

    // ── board rendering ─────────────────────────────────────────────────────

    function render() {
        els.hideDoneToggle.setAttribute("aria-pressed", String(state.hideDone));
        const graph = state.view === "graph";
        els.boardViewButton.setAttribute("aria-pressed", String(!graph));
        els.graphViewButton.setAttribute("aria-pressed", String(graph));
        els.board.hidden = graph;
        els.graph.hidden = !graph;
        els.graphLegend.hidden = !graph;
        if (graph) {
            renderGraph();
            return;
        }
        const columns = [renderColumn(ME, null)];
        state.people.forEach((person, index) => columns.push(renderColumn(String(person.id), person, index)));
        columns.push(renderAddPerson());

        // The board is rebuilt wholesale, so carry over anything half-typed
        // into an add field, and the focus, across the rebuild.
        const drafts = [...els.board.querySelectorAll("input")]
            .filter((input) => input.id && input.value)
            .map((input) => [input.id, input.value]);
        const focusedId = els.board.contains(document.activeElement) ? document.activeElement.id : null;
        els.board.replaceChildren(...columns);
        for (const [id, value] of drafts) {
            const input = byId(id);
            if (input) input.value = value;
        }
        if (focusedId && !state.refocus) {
            const target = byId(focusedId);
            if (target) target.focus();
        }

        if (state.refocus) {
            const target = els.board.querySelector(state.refocus);
            state.refocus = null;
            if (target) target.focus();
        }
    }

    function renderGraph() {
        const items = state.hideDone ? state.items.filter((item) => !DONE_STATUSES.has(item.status)) : state.items;
        window.GiftGraph.render(els.graph, {
            people: state.people,
            items,
            isDone: (item) => DONE_STATUSES.has(item.status),
            statusLabel: (status) => STATUS_LABELS[status],
            onItem: (id) => {
                state.focusNode = `[data-item="${id}"]`;
                openItemEditor(id);
            },
            onPerson: (id) => {
                state.focusNode = `[data-person="${id}"]`;
                openPersonEditor(id);
            },
        });
        if (state.focusNode && !els.itemEditor.open && !els.personEditor.open) {
            const target = els.graph.querySelector(state.focusNode);
            state.focusNode = null;
            if (target) target.focus();
        }
    }

    // P4: a person linked to a site account shows that member's public
    // wishlist under your private ideas, with a one-click copy into them.
    function renderLinked(person) {
        const linked = person.linked;
        const ideas = itemsIn(String(person.id));
        const details = el("details", {
            class: "linked",
            open: !state.collapsed.has(person.id),
            ontoggle: (event) => {
                if (event.currentTarget.open) state.collapsed.delete(person.id);
                else state.collapsed.add(person.id);
            },
        }, [
            el("summary", { text: `From ${linked.displayName}'s wishlist (${linked.items.length})` }),
            linked.items.length
                ? el("ul", { class: "linked__list" }, linked.items.map((wish) => el("li", { class: "linked__item" }, [
                    el("span", { class: "linked__title" }, titleNode(wish.title, wish.url)),
                    wish.priceCents !== null ? el("span", { class: "linked__price", text: formatPrice(wish.priceCents) }) : null,
                    alreadySaved(ideas, wish)
                        ? el("span", { class: "linked__saved", text: "Saved" })
                        : el("button", {
                            type: "button",
                            class: "button button--quiet button--small",
                            "aria-label": `Save ${wish.title} as an idea for ${person.name}`,
                            text: "Save as idea",
                            onclick: () => saveAsIdea(person, wish),
                        }),
                ])))
                : el("p", { class: "linked__empty", text: "Nothing on it right now." }),
        ]);
        return details;
    }

    function renderColumn(key, person, index) {
        const all = itemsIn(key);
        const visible = state.hideDone ? all.filter((item) => !DONE_STATUSES.has(item.status)) : all;
        const hiddenCount = all.length - visible.length;
        const isMe = key === ME;
        const name = isMe ? "My wishlist" : person.name;

        const meta = [
            isMe
                ? el("span", { class: "badge badge--public", text: "Visible to members" })
                : el("span", { class: "badge badge--private", text: "Private" }),
            el("span", { text: `${all.length} ${all.length === 1 ? "gift" : "gifts"}` }),
        ];
        if (person && person.birthday) meta.push(el("span", { text: birthdayLabel(person.birthday) }));
        if (person && person.linkedUsername && !person.linked) {
            meta.push(el("span", { text: "Linked account unavailable" }));
        }

        const tools = isMe
            ? null
            : el("div", { class: "column__tools" }, [
                el("button", {
                    type: "button",
                    "aria-label": `Move ${name} earlier`,
                    title: "Move earlier",
                    class: "icon-button icon-button--order",
                    disabled: index === 0,
                    text: "←",
                    onclick: () => movePerson(person.id, index - 1),
                }),
                el("button", {
                    type: "button",
                    "aria-label": `Move ${name} later`,
                    title: "Move later",
                    class: "icon-button icon-button--order",
                    disabled: index === state.people.length - 1,
                    text: "→",
                    onclick: () => movePerson(person.id, index + 1),
                }),
                el("button", {
                    type: "button",
                    class: "icon-button",
                    "aria-label": `Edit ${name}`,
                    title: "Edit person",
                    text: "✎",
                    onclick: () => openPersonEditor(person.id),
                }),
            ]);

        const list = el("ul", { class: "cards", "data-column": key, "aria-label": `Gifts for ${name}` },
            visible.map((item) => renderCard(item)));

        let empty = null;
        if (!all.length) {
            empty = el("p", {
                class: "column__empty",
                text: isMe ? "Found something you like? Add it here." : "No ideas yet.",
            });
        } else if (!visible.length) {
            empty = el("p", { class: "column__empty", text: `${hiddenCount} given, hidden.` });
        }

        const column = el("section", {
            class: `column${isMe ? " column--me" : ""}`,
            "data-column": key,
            "aria-label": name,
        }, [
            el("div", { class: "column__head" }, [
                el("div", { class: "column__title" }, [
                    el("h2", { class: "column__name", text: name }),
                    el("div", { class: "column__meta" }, meta),
                ]),
                tools,
            ]),
            person && person.note ? el("p", { class: "column__note", text: person.note }) : null,
            list,
            empty,
            person && person.linked ? renderLinked(person) : null,
            el("form", { class: "quick-add", onsubmit: (event) => quickAdd(event, key) }, [
                el("label", { class: "sr-only", for: `add-${key}`, text: `Add a gift to ${name}` }),
                el("input", {
                    id: `add-${key}`,
                    type: "text",
                    name: "title",
                    maxlength: "200",
                    autocomplete: "off",
                    placeholder: isMe ? "+ Add something you'd like" : `+ Add an idea for ${name}`,
                }),
            ]),
        ]);
        wireDropTarget(column, list, key);
        return column;
    }

    function renderCard(item) {
        const href = safeHref(item.url);
        const title = titleNode(item.title, item.url);
        const meta = [el("span", { class: `status status--${item.status}`, text: STATUS_LABELS[item.status] })];
        if (item.priceCents !== null) meta.push(el("span", { text: formatPrice(item.priceCents) }));
        if (href) meta.push(el("span", { text: hostOf(href) }));
        if (item.occasion) meta.push(el("span", { text: item.occasion }));

        const card = el("li", {
            class: `card${DONE_STATUSES.has(item.status) ? " card--done" : ""}`,
            draggable: "true",
            "data-item": String(item.id),
        }, [
            el("button", {
                type: "button",
                class: "card__open",
                "aria-label": `Edit ${item.title}`,
                onclick: () => openItemEditor(item.id),
            }),
            el("p", { class: "card__title" }, title),
            el("div", { class: "card__meta" }, meta),
            item.note ? el("p", { class: "card__note", text: item.note }) : null,
        ]);
        card.addEventListener("dragstart", (event) => {
            state.dragItemId = item.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(item.id));
            window.requestAnimationFrame(() => card.classList.add("is-dragging"));
        });
        card.addEventListener("dragend", () => {
            state.dragItemId = null;
            card.classList.remove("is-dragging");
            clearDropMarkers();
        });
        return card;
    }

    function renderAddPerson() {
        return el("section", { class: "add-person", "aria-labelledby": "addPersonHeading" }, [
            el("h2", { id: "addPersonHeading", text: "Add a person" }),
            el("p", { text: "Ideas you file under someone are only ever visible to you." }),
            el("form", { onsubmit: addPerson }, [
                el("label", { class: "sr-only", for: "addPersonInput", text: "Name" }),
                el("input", {
                    id: "addPersonInput",
                    type: "text",
                    name: "name",
                    maxlength: "80",
                    autocomplete: "off",
                    placeholder: "Name, e.g. Mom",
                }),
            ]),
        ]);
    }

    // ── drag and drop ───────────────────────────────────────────────────────
    //
    // HTML5 drag and drop for pointer users. Touch and keyboard users move
    // gifts from the editor (List, Move up, Move down), which works everywhere.

    function clearDropMarkers() {
        els.board.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));
        els.board.querySelectorAll(".is-drop-before").forEach((node) => node.classList.remove("is-drop-before"));
    }

    // Where in `list` a drop at clientY lands, counting only cards other than
    // the one being dragged — the same "destination without the mover" the
    // API's index refers to.
    function dropIndex(list, clientY) {
        const cards = [...list.querySelectorAll(".card")].filter(
            (card) => Number(card.dataset.item) !== state.dragItemId
        );
        let index = cards.findIndex((card) => {
            const rect = card.getBoundingClientRect();
            return clientY < rect.top + rect.height / 2;
        });
        if (index === -1) index = cards.length;
        return { index, before: cards[index] || null };
    }

    function wireDropTarget(column, list, key) {
        column.addEventListener("dragover", (event) => {
            if (state.dragItemId === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            clearDropMarkers();
            column.classList.add("is-drop-target");
            const { before } = dropIndex(list, event.clientY);
            if (before) before.classList.add("is-drop-before");
        });
        column.addEventListener("dragleave", (event) => {
            if (!column.contains(event.relatedTarget)) column.classList.remove("is-drop-target");
        });
        column.addEventListener("drop", (event) => {
            event.preventDefault();
            const itemId = state.dragItemId;
            clearDropMarkers();
            if (itemId === null) return;
            const visibleIndex = dropIndex(list, event.clientY).index;
            moveItem(itemId, key, toFullIndex(key, itemId, visibleIndex));
        });
    }

    // With "Hide given" on, the visible list skips some rows; translate a
    // visible slot back to a slot in the full column.
    function toFullIndex(key, movingId, visibleIndex) {
        const full = itemsIn(key).filter((item) => item.id !== movingId);
        if (!state.hideDone) return visibleIndex;
        const visible = full.filter((item) => !DONE_STATUSES.has(item.status));
        if (visibleIndex >= visible.length) return full.length;
        return full.indexOf(visible[visibleIndex]);
    }

    // ── writes ──────────────────────────────────────────────────────────────

    function confirmGoingPublic(item, destinationKey) {
        if (destinationKey !== ME || item.personId === null) return true;
        return window.confirm(
            `Move "${item.title}" to your wishlist? Other members will be able to see it.`
        );
    }

    async function moveItem(itemId, destinationKey, index) {
        const item = state.items.find((row) => row.id === itemId);
        if (!item || !confirmGoingPublic(item, destinationKey)) return false;
        const sameColumn = columnKey(item.personId) === destinationKey;
        const result = await attempt(() => api(`/items/${itemId}/move`, {
            method: "POST",
            body: { person_id: personIdFromKey(destinationKey), index },
        }));
        if (!result) return false;
        adoptBoard(result);
        announce(sameColumn ? `Moved ${item.title}.` : `Moved ${item.title} to ${columnName(destinationKey)}.`);
        return true;
    }

    async function movePerson(personId, index) {
        const result = await attempt(() => api(`/people/${personId}/move`, { method: "POST", body: { index } }));
        if (!result) return;
        adoptBoard(result);
        const person = state.people.find((p) => p.id === personId);
        const button = els.board.querySelector(
            `[data-column="${personId}"] .column__tools .icon-button:not([disabled])`
        );
        if (button) button.focus();
        if (person) announce(`${person.name} is now column ${index + 2}.`);
    }

    async function quickAdd(event, key) {
        event.preventDefault();
        const input = event.currentTarget.elements.title;
        const title = input.value.trim();
        if (!title) return;
        // Clear now rather than disabling the field for the round trip: a
        // disabled input drops whatever the next gift's first keystrokes were.
        input.value = "";
        const created = await attempt(() => api("/items", {
            method: "POST",
            body: { person_id: personIdFromKey(key), title },
        }));
        if (!created) {
            const live = els.board.querySelector(`#add-${key}`);
            if (live && !live.value) live.value = title;
            if (live) live.focus();
            return;
        }
        state.items.push(created);
        state.refocus = `#add-${key}`;
        render();
        announce(`Added ${created.title} to ${columnName(key)}.`);
    }

    async function addPerson(event) {
        event.preventDefault();
        const input = event.currentTarget.elements.name;
        const name = input.value.trim();
        if (!name) return;
        const created = await attempt(() => api("/people", { method: "POST", body: { name } }));
        if (!created) {
            input.focus();
            return;
        }
        state.people.push(created);
        state.refocus = `#add-${created.id}`;
        render();
        announce(`Added ${created.name}.`);
    }

    function adoptBoard(data) {
        state.people = data.people;
        state.items = data.items;
        render();
    }

    // ── item editor ─────────────────────────────────────────────────────────

    function openItemEditor(itemId) {
        const item = state.items.find((row) => row.id === itemId);
        if (!item) return;
        state.editingItemId = itemId;
        const form = els.itemForm.elements;
        els.editorHeading.textContent = item.personId === null ? "On your wishlist" : `Idea for ${columnName(columnKey(item.personId))}`;
        form.title.value = item.title;
        form.url.value = item.url || "";
        form.price.value = item.priceCents === null ? "" : (item.priceCents / 100).toFixed(2);
        form.note.value = item.note || "";
        form.occasion.value = item.occasion || "";
        form.givenOn.value = item.givenOn || "";

        form.column.replaceChildren(
            el("option", { value: ME, text: "My wishlist" }),
            ...state.people.map((p) => el("option", { value: String(p.id), text: p.name }))
        );
        form.column.value = columnKey(item.personId);
        fillStatusOptions(item.status);
        syncEditor();
        els.editorError.hidden = true;
        els.itemEditor.showModal();
        form.title.focus();
    }

    // Status choices depend on which side of the privacy line the gift will
    // land on, so they follow the List select rather than the saved row.
    function fillStatusOptions(current) {
        const form = els.itemForm.elements;
        const statuses = form.column.value === ME ? WISHLIST_STATUSES : IDEA_STATUSES;
        form.status.replaceChildren(...statuses.map((s) => el("option", { value: s, text: STATUS_LABELS[s] })));
        form.status.value = statuses.includes(current) ? current : statuses[0];
    }

    function syncEditor() {
        const item = state.items.find((row) => row.id === state.editingItemId);
        if (!item) return;
        const form = els.itemForm.elements;
        const destination = form.column.value;
        els.publicWarning.hidden = !(destination === ME && item.personId !== null);
        els.givenFields.hidden = destination === ME;
        const siblings = itemsIn(columnKey(item.personId));
        const position = siblings.findIndex((row) => row.id === item.id);
        const moved = destination !== columnKey(item.personId);
        els.moveUp.disabled = moved || position <= 0;
        els.moveDown.disabled = moved || position === siblings.length - 1;
    }

    function editorError(message) {
        els.editorError.textContent = message;
        els.editorError.hidden = false;
    }

    async function saveItem(event) {
        event.preventDefault();
        const item = state.items.find((row) => row.id === state.editingItemId);
        if (!item) return;
        const form = els.itemForm.elements;
        const title = form.title.value.trim();
        if (!title) return editorError("Give the gift a name.");
        const url = form.url.value.trim();
        if (url && !safeHref(url)) return editorError("Links must start with http:// or https://.");
        const priceCents = parsePrice(form.price.value);
        if (Number.isNaN(priceCents)) return editorError("Enter a price like 25 or 24.99.");

        const destination = form.column.value;
        const changesSide = destination !== columnKey(item.personId);
        if (changesSide && !confirmGoingPublic(item, destination)) return;

        try {
            hideError();
            // Move first: the status options shown were for the destination
            // side, and the server only accepts a status for the side the row
            // is on when the PATCH arrives.
            if (changesSide) {
                const board = await api(`/items/${item.id}/move`, {
                    method: "POST",
                    body: { person_id: personIdFromKey(destination), index: itemsIn(destination).length },
                });
                state.people = board.people;
                state.items = board.items;
            }
            const updated = await api(`/items/${item.id}`, {
                method: "PATCH",
                body: {
                    title,
                    url: url || null,
                    price_cents: priceCents,
                    note: form.note.value.trim() || null,
                    status: form.status.value,
                    occasion: destination === ME ? item.occasion : (form.occasion.value.trim() || null),
                    given_on: destination === ME ? item.givenOn : (form.givenOn.value || null),
                },
            });
            state.items = state.items.map((row) => (row.id === updated.id ? updated : row));
        } catch (error) {
            if (error instanceof ForbiddenError) return showSignedOut();
            render();
            return editorError(error.message);
        }
        els.itemEditor.close();
        render();
        announce(`Saved ${title}.`);
    }

    async function nudgeItem(delta) {
        const item = state.items.find((row) => row.id === state.editingItemId);
        if (!item) return;
        const key = columnKey(item.personId);
        const position = itemsIn(key).findIndex((row) => row.id === item.id);
        const moved = await moveItem(item.id, key, position + delta);
        if (moved) {
            syncEditor();
            (delta < 0 ? els.moveUp : els.moveDown).focus();
        }
    }

    async function deleteItem() {
        const item = state.items.find((row) => row.id === state.editingItemId);
        if (!item || !window.confirm(`Delete "${item.title}"?`)) return;
        const done = await attempt(() => api(`/items/${item.id}`, { method: "DELETE" }).then(() => true));
        if (!done) return;
        state.items = state.items.filter((row) => row.id !== item.id);
        els.itemEditor.close();
        render();
        announce(`Deleted ${item.title}.`);
    }

    // ── person editor ───────────────────────────────────────────────────────

    function openPersonEditor(personId) {
        const person = state.people.find((p) => p.id === personId);
        if (!person) return;
        state.editingPersonId = personId;
        const form = els.personForm.elements;
        form.name.value = person.name;
        form.birthday.value = person.birthday || "";
        form.note.value = person.note || "";
        form.linkedUsername.value = person.linkedUsername || "";
        els.personError.hidden = true;
        els.personEditor.showModal();
        form.name.focus();
    }

    async function savePerson(event) {
        event.preventDefault();
        const form = els.personForm.elements;
        const name = form.name.value.trim();
        if (!name) {
            els.personError.textContent = "Give this person a name.";
            els.personError.hidden = false;
            return;
        }
        try {
            const updated = await api(`/people/${state.editingPersonId}`, {
                method: "PATCH",
                body: {
                    name,
                    birthday: form.birthday.value || null,
                    note: form.note.value.trim() || null,
                    linked_username: form.linkedUsername.value.trim() || null,
                },
            });
            state.people = state.people.map((p) => (p.id === updated.id ? updated : p));
        } catch (error) {
            if (error instanceof ForbiddenError) return showSignedOut();
            els.personError.textContent = error.message;
            els.personError.hidden = false;
            return;
        }
        els.personEditor.close();
        render();
        announce(`Saved ${name}.`);
    }

    async function deletePerson() {
        const person = state.people.find((p) => p.id === state.editingPersonId);
        if (!person) return;
        const count = itemsIn(String(person.id)).length;
        const extra = count ? ` and ${count} gift idea${count === 1 ? "" : "s"}` : "";
        if (!window.confirm(`Delete ${person.name}${extra}? This can't be undone.`)) return;
        const done = await attempt(() => api(`/people/${person.id}`, { method: "DELETE" }).then(() => true));
        if (!done) return;
        state.people = state.people.filter((p) => p.id !== person.id);
        state.items = state.items.filter((item) => item.personId !== person.id);
        els.personEditor.close();
        render();
        announce(`Deleted ${person.name}.`);
    }

    // ── wiring ──────────────────────────────────────────────────────────────

    els.hideDoneToggle.addEventListener("click", () => {
        state.hideDone = !state.hideDone;
        writePref(HIDE_DONE_KEY, state.hideDone ? "1" : "0");
        render();
    });

    function setBoardView(view) {
        if (view === state.view) return;
        state.view = view;
        els.graph.replaceChildren();
        writePref(VIEW_KEY, view);
        render();
    }

    els.boardViewButton.addEventListener("click", () => setBoardView("board"));
    els.graphViewButton.addEventListener("click", () => setBoardView("graph"));

    els.itemForm.addEventListener("submit", saveItem);
    els.itemForm.elements.column.addEventListener("change", () => {
        fillStatusOptions(els.itemForm.elements.status.value);
        syncEditor();
    });
    byId("editorClose").addEventListener("click", () => els.itemEditor.close());
    byId("editorCancel").addEventListener("click", () => els.itemEditor.close());
    byId("deleteItem").addEventListener("click", deleteItem);
    els.moveUp.addEventListener("click", () => nudgeItem(-1));
    els.moveDown.addEventListener("click", () => nudgeItem(1));

    els.personForm.addEventListener("submit", savePerson);
    byId("personClose").addEventListener("click", () => els.personEditor.close());
    byId("personCancel").addEventListener("click", () => els.personEditor.close());
    byId("deletePerson").addEventListener("click", deletePerson);

    // ── wishlists (P2) ──────────────────────────────────────────────────────

    async function saveAsIdea(person, wish) {
        const created = await attempt(() => api("/items", {
            method: "POST",
            body: {
                person_id: person.id,
                title: wish.title,
                url: wish.url,
                price_cents: wish.priceCents,
                note: wish.note,
            },
        }));
        if (!created) return;
        state.items.push(created);
        if (currentRoute().name === "wishlist" && state.wishlist) renderWishlist(state.wishlist);
        else render();
        announce(`Saved ${wish.title} as an idea for ${person.name}.`);
    }

    async function showWishlists() {
        setView("wishlists");
        const seq = ++state.wishlistSeq;
        const data = await attempt(() => api("/wishlists"));
        if (!data || seq !== state.wishlistSeq) return;
        els.wishlistsEmpty.hidden = data.members.length > 0;
        els.memberGrid.replaceChildren(...data.members.map((member) => el("a", {
            class: "member-card",
            href: `#wishlist/${encodeURIComponent(member.username)}`,
        }, [
            el("span", { class: "member-card__avatar", "aria-hidden": "true", text: initials(member.displayName) }),
            el("span", { class: "member-card__name", text: member.displayName }),
            el("span", { class: "member-card__count", text: `${member.count} ${member.count === 1 ? "thing" : "things"}` }),
        ])));
    }

    async function showWishlist(member) {
        setView("wishlist");
        state.wishlist = null;
        els.wishlistTitle.textContent = "Loading…";
        els.wishList.replaceChildren();
        els.wishlistActions.replaceChildren();
        els.wishlistEmpty.hidden = true;
        const seq = ++state.wishlistSeq;
        let data;
        try {
            data = await api(`/wishlists/${encodeURIComponent(member)}`);
        } catch (error) {
            if (seq !== state.wishlistSeq) return;
            if (error instanceof ForbiddenError) return showSignedOut();
            els.wishlistTitle.textContent = "Wishlist not found";
            return showError(error.message);
        }
        if (seq !== state.wishlistSeq) return;
        state.wishlist = data;
        renderWishlist(data);
    }

    function renderWishlist(data) {
        const isMe = data.username === state.me;
        const person = state.people.find((p) => p.linkedUsername === data.username) || null;
        els.wishlistTitle.textContent = isMe ? "Your wishlist" : `${data.displayName}'s wishlist`;

        let action;
        if (isMe) {
            action = el("p", { class: "wishlist-head__note", text: "This is how other members see your wishlist." });
        } else if (person) {
            action = el("p", { class: "wishlist-head__note", text: `Linked to ${person.name} on your board.` });
        } else {
            action = el("button", {
                type: "button",
                class: "button",
                text: `Add ${data.displayName} to my board`,
                onclick: () => addLinkedPerson(data),
            });
        }
        els.wishlistActions.replaceChildren(action);

        const ideas = person ? itemsIn(String(person.id)) : [];
        els.wishList.replaceChildren(...data.items.map((wish) => {
            const href = safeHref(wish.url);
            const meta = [];
            if (wish.priceCents !== null) meta.push(el("span", { text: formatPrice(wish.priceCents) }));
            if (href) meta.push(el("span", { text: hostOf(href) }));
            let save = null;
            if (person) {
                save = alreadySaved(ideas, wish)
                    ? el("span", { class: "linked__saved", text: `Saved to ${person.name}` })
                    : el("button", {
                        type: "button",
                        class: "button button--quiet button--small",
                        text: `Save as idea for ${person.name}`,
                        onclick: () => saveAsIdea(person, wish),
                    });
            }
            return el("li", { class: "wish" }, [
                el("div", { class: "wish__main" }, [
                    el("p", { class: "wish__title" }, titleNode(wish.title, wish.url)),
                    meta.length ? el("div", { class: "wish__meta" }, meta) : null,
                    wish.note ? el("p", { class: "wish__note", text: wish.note }) : null,
                ]),
                save,
            ]);
        }));
        els.wishlistEmpty.hidden = data.items.length > 0;
    }

    // One step from someone's wishlist to a column on your board, linked so
    // their wishlist shows up there.
    async function addLinkedPerson(data) {
        const result = await attempt(async () => {
            const created = await api("/people", { method: "POST", body: { name: data.displayName } });
            return api(`/people/${created.id}`, { method: "PATCH", body: { linked_username: data.username } });
        });
        if (!result) {
            // The usual failure is a name clash with someone already on the
            // board; point at the way through rather than leaving a dead end.
            showError(`${els.errorBanner.textContent} To link someone already on your board, edit them and enter ${data.username} as their site account.`);
            return;
        }
        state.people.push(result);
        renderWishlist(data);
        announce(`Added ${data.displayName} to your board.`);
    }

    // ── routing ─────────────────────────────────────────────────────────────

    function currentRoute() {
        let hash = window.location.hash.slice(1);
        try {
            hash = decodeURIComponent(hash);
        } catch (_error) {
            hash = "";
        }
        if (hash === "wishlists") return { name: "wishlists" };
        if (hash.startsWith("wishlist/") && hash.length > 9) return { name: "wishlist", member: hash.slice(9) };
        return { name: "board" };
    }

    function route() {
        if (!state.loaded) return;
        hideError();
        closeDialogs();
        const current = currentRoute();
        if (current.name === "wishlists") return showWishlists();
        if (current.name === "wishlist") return showWishlist(current.member);
        state.wishlistSeq += 1;
        setView("board");
        render();
    }

    window.addEventListener("hashchange", route);

    async function load() {
        setView("loading");
        try {
            const data = await api("/board");
            state.me = data.username;
            state.loaded = true;
            state.people = data.people;
            state.items = data.items;
            route();
        } catch (error) {
            if (error instanceof ForbiddenError) {
                showSignedOut();
                return;
            }
            setView("board");
            showError(`Couldn't load your board. ${error.message}`);
        }
    }

    load();
})();
