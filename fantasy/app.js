// Fantasy dashboard controller. Vanilla JS, no build step. Reads the P1
// fantasy API and renders the rankings board (with week switching, player
// search, rank movement, matchups, injury badges, a consensus projection
// source, and a compare tray), plus trending panels and a player slide-over.
// Formatting/derivation lives in format.js (FantasyFormat). View state is
// mirrored into the URL query string so a view is shareable/refresh-safe.
(function () {
    "use strict";

    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy`;
    const F = window.FantasyFormat;
    const MAX_COMPARE = 4;

    const state = {
        season: null,
        week: null,
        defaultWeek: null,
        // "season" (market value, year-long) or "week" (this week's board).
        boardMode: "season",
        weekBoard: null,
        inSeason: false,
        seasonFantasyScoring: "std",
        seasonFantasyPosition: "ALL",
        // The board's last payload, so a chip, a sort, or clearing the compare
        // tray repaints from memory instead of refetching the same rows.
        seasonFantasyData: null,
        // The server ranks by market value; anything else is a local re-read
        // of rows already in hand.
        seasonFantasySort: { key: "fantasy_points", dir: "desc" },
        seasonPropsPosition: "ALL",
        seasonPropsMarket: null,
        marketExpanded: false,
        movers: null,
        moversView: "gainers",
        drawerPlayerId: null,
        compare: [], // [{ player_id, name }]
    };

    const els = {
        boardMode: document.getElementById("boardMode"),
        marketBoardEyebrow: document.getElementById("marketBoardEyebrow"),
        marketBoardTitle: document.getElementById("marketBoardTitle"),
        marketTableWrap: document.getElementById("marketTableWrap"),
        weekBoardWrap: document.getElementById("weekBoardWrap"),
        weekLeaders: document.getElementById("weekLeaders"),
        weekProjHead: document.getElementById("weekProjHead"),
        weekLabel: document.getElementById("weekLabel"),
        weekValue: document.getElementById("weekValue"),
        seasonValue: document.getElementById("seasonValue"),
        offseasonBanner: document.getElementById("offseasonBanner"),
        errorBanner: document.getElementById("errorBanner"),
        playerSearch: document.getElementById("playerSearch"),
        searchResults: document.getElementById("searchResults"),
        seasonPropsTabs: document.getElementById("seasonPropsTabs"),
        seasonPropsLeaders: document.getElementById("seasonPropsLeaders"),
        seasonPropsPositions: document.getElementById("seasonPropsPositions"),
        seasonPropsNote: document.getElementById("seasonPropsNote"),
        seasonFantasyLeaders: document.getElementById("seasonFantasyLeaders"),
        seasonFantasyNote: document.getElementById("seasonFantasyNote"),
        seasonFantasyScoring: document.getElementById("seasonFantasyScoring"),
        seasonFantasyPositions: document.getElementById("seasonFantasyPositions"),
        seasonFantasyProjHead: document.getElementById("seasonFantasyProjHead"),
        seasonOffenseYards: document.getElementById("seasonOffenseYards"),
        seasonOffenseTouchdowns: document.getElementById("seasonOffenseTouchdowns"),
        seasonOffensesNote: document.getElementById("seasonOffensesNote"),
        showAllMarket: document.getElementById("showAllMarket"),
        playerMarkets: document.getElementById("playerMarkets"),
        marketMovers: document.getElementById("marketMovers"),
        marketMoversNote: document.getElementById("marketMoversNote"),
        marketFreshness: document.getElementById("marketFreshness"),
        memberStatus: document.getElementById("memberStatus"),
        memberTeam: document.getElementById("memberTeam"),
        memberMetrics: document.getElementById("memberMetrics"),
        chooseTeam: document.getElementById("chooseTeam"),
        teamSelect: document.getElementById("teamSelect"),
        trendingAdd: document.getElementById("trendingAdd"),
        trendingDrop: document.getElementById("trendingDrop"),
        gamesSection: document.getElementById("gamesSection"),
        gamesStrip: document.getElementById("gamesStrip"),
        gamesAsOf: document.getElementById("gamesAsOf"),
        marketGroup: document.getElementById("marketGroup"),
        liveMarkets: document.getElementById("live-markets"),
        propsSection: document.getElementById("propsSection"),
        propGameTabs: document.getElementById("propGameTabs"),
        propsBoard: document.getElementById("propsBoard"),
        propsAsOf: document.getElementById("propsAsOf"),
        futuresSection: document.getElementById("futuresSection"),
        futuresTabs: document.getElementById("futuresTabs"),
        futuresBody: document.getElementById("futuresBody"),
        futuresAsOf: document.getElementById("futuresAsOf"),
        drawer: document.getElementById("playerDrawer"),
        drawerBackdrop: document.getElementById("drawerBackdrop"),
        drawerClose: document.getElementById("drawerClose"),
        drawerName: document.getElementById("drawerName"),
        drawerSub: document.getElementById("drawerSub"),
        drawerBody: document.getElementById("drawerBody"),
        compareTray: document.getElementById("compareTray"),
        compareChips: document.getElementById("compareChips"),
        compareClear: document.getElementById("compareClear"),
        compareGo: document.getElementById("compareGo"),
        compareDrawer: document.getElementById("compareDrawer"),
        compareBackdrop: document.getElementById("compareBackdrop"),
        compareDrawerClose: document.getElementById("compareDrawerClose"),
        compareSub: document.getElementById("compareSub"),
        compareBody: document.getElementById("compareBody"),
        marketsDrawer: document.getElementById("marketsDrawer"),
        marketsBackdrop: document.getElementById("marketsBackdrop"),
        marketsClose: document.getElementById("marketsClose"),
        marketsSub: document.getElementById("marketsSub"),
    };

    async function fetchJson(url) {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.detail || `Request failed with ${response.status}`);
        }
        return response.json();
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = false;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function providerLink(provider) {
        const link = el("a", "source-link", provider.label);
        link.href = provider.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        return link;
    }

    // The picker these labels used to come from is gone, and fetching
    // /projection-sources purely to caption a drawer heading would be a
    // network call for a control that no longer exists.
    const PROVIDERS = {
        sleeper: { id: "sleeper", label: "Sleeper", url: "https://sleeper.com/" },
        espn: { id: "espn", label: "ESPN", url: "https://www.espn.com/fantasy/football/" },
        fantasypros: { id: "fantasypros", label: "FantasyPros", url: "https://www.fantasypros.com/nfl/" },
        consensus: { id: "consensus", label: "Consensus", url: null },
    };

    function providerFor(sourceId) {
        return PROVIDERS[sourceId] || {
            id: sourceId,
            label: sourceId ? sourceId.replace(/\b\w/g, (char) => char.toUpperCase()) : "Unknown",
            url: null,
        };
    }

    let overlayFocus = null;

    function rememberOverlayFocus() {
        overlayFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    function restoreOverlayFocus() {
        if (overlayFocus && document.contains(overlayFocus)) overlayFocus.focus();
        overlayFocus = null;
    }

    function syncDrawerBody() {
        const open = !els.drawer.hidden || !els.compareDrawer.hidden || !els.marketsDrawer.hidden;
        document.body.classList.toggle("drawer-open", open);
    }

    function visibleDialog() {
        const overlay = [els.marketsDrawer, els.compareDrawer, els.drawer]
            .find((node) => node && !node.hidden);
        return overlay ? overlay.querySelector('[role="dialog"]') : null;
    }

    function trapDialogFocus(event) {
        if (event.key !== "Tab") return;
        const dialog = visibleDialog();
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((node) => !node.hidden && node.offsetParent !== null);
        if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    // ── URL state (shareable deep links) ────────────────────────────────

    // `pos` and `scoring` keep their names and vocabulary from the retired
    // projection board, so old deep links still land somewhere sensible; they
    // now address the market board. `week` is deliberately not read — there is
    // no week control left, so an old ?week=5 link would pin the game lines to
    // a week the reader cannot change.
    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        if (params.has("pos")) state.seasonFantasyPosition = params.get("pos").toUpperCase();
        if (params.has("scoring")) state.seasonFantasyScoring = params.get("scoring");
        // Applied once /state says whether there is a week to show; until then
        // it is only a request.
        if (params.get("board") === "week") state.boardMode = "week";
        // "delta", "delta:asc" — an unknown column is ignored rather than
        // leaving the board sorted by nothing.
        if (params.has("sort")) {
            const [key, dir] = params.get("sort").split(":");
            if (MARKET_SORTS[key]) {
                state.seasonFantasySort = { key, dir: dir === "asc" ? "asc" : "desc" };
            }
        }
        state.seasonPropsMarket = params.get("category");
        return { player: params.get("player"), category: state.seasonPropsMarket };
    }

    function writeUrlState(push) {
        const params = new URLSearchParams();
        if (state.seasonFantasyPosition && state.seasonFantasyPosition !== "ALL") {
            params.set("pos", state.seasonFantasyPosition);
        }
        if (state.seasonFantasyScoring && state.seasonFantasyScoring !== "std") {
            params.set("scoring", state.seasonFantasyScoring);
        }
        if (state.boardMode === "week") params.set("board", "week");
        const sort = state.seasonFantasySort;
        // The sort belongs to the market table; the week board is ranked.
        if (state.boardMode !== "week" && (sort.key !== "fantasy_points" || sort.dir !== "desc")) {
            params.set("sort", `${sort.key}:${sort.dir}`);
        }
        if (state.drawerPlayerId && !els.drawer.hidden) params.set("player", state.drawerPlayerId);
        if (state.seasonPropsMarket && !els.marketsDrawer.hidden) params.set("category", state.seasonPropsMarket);
        const query = params.toString();
        const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
        window.history[push ? "pushState" : "replaceState"](null, "", url);
    }

    // ── player search ───────────────────────────────────────────────────

    let searchTimer = null;
    let searchSeq = 0;

    function initSearch() {
        els.playerSearch.addEventListener("input", () => {
            const term = els.playerSearch.value.trim();
            window.clearTimeout(searchTimer);
            if (term.length < 2) {
                hideSearchResults();
                return;
            }
            searchTimer = window.setTimeout(() => runSearch(term), 180);
        });
        els.playerSearch.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hideSearchResults();
        });
        document.addEventListener("click", (e) => {
            if (!e.target.closest(".player-search")) hideSearchResults();
        });
    }

    async function runSearch(term) {
        const seq = ++searchSeq;
        try {
            const data = await fetchJson(`${API_BASE}/players/search?q=${encodeURIComponent(term)}&limit=8`);
            if (seq !== searchSeq) return;
            renderSearchResults(data.results || []);
        } catch (err) {
            hideSearchResults();
        }
    }

    function renderSearchResults(results) {
        els.searchResults.innerHTML = "";
        if (results.length === 0) {
            hideSearchResults();
            return;
        }
        results.forEach((player) => {
            const li = el("li", "search-results__item");
            li.setAttribute("role", "option");
            li.tabIndex = 0;
            const name = el("span", "search-results__name", player.name || player.player_id);
            const meta = el("span", "search-results__meta",
                `${F.positionLabel(player.position) || ""} ${player.team || ""}`.trim());
            li.appendChild(name);
            li.appendChild(meta);
            const pick = () => {
                hideSearchResults();
                els.playerSearch.value = "";
                openPlayer(player.player_id);
            };
            li.addEventListener("click", pick);
            li.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
            });
            els.searchResults.appendChild(li);
        });
        els.searchResults.hidden = false;
        els.playerSearch.setAttribute("aria-expanded", "true");
    }

    function hideSearchResults() {
        els.searchResults.hidden = true;
        els.searchResults.innerHTML = "";
        els.playerSearch.setAttribute("aria-expanded", "false");
    }

    // ── season player lines lookup ─────────────────────────────────────

    let seasonPropsTimer = null;
    let seasonPropsSeq = 0;

    // Fetched separately from the player record so a slow season-props lookup
    // never delays the rest of the drawer — the card drops into its reserved
    // slot when it arrives, the same way news does.
    async function loadPlayerSeasonProps(playerId) {
        const slot = els.drawerMarket;
        if (!slot) return;
        slot.innerHTML = "";
        slot.appendChild(el("p", "drawer__loading", "Loading season lines…"));
        try {
            const params = state.season != null ? `?season=${encodeURIComponent(state.season)}` : "";
            const data = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}/season-props${params}`);
            if (state.drawerPlayerId !== playerId || els.drawer.hidden) return;
            slot.innerHTML = "";
            slot.appendChild(seasonMarketCard(data));
            window.pgAnalytics?.track?.("fantasy_season_props", { player_id: playerId });
        } catch (err) {
            if (state.drawerPlayerId !== playerId || els.drawer.hidden) return;
            slot.innerHTML = "";
            slot.appendChild(el("p", "season-props__status season-props__status--error", "Season lines are unavailable right now."));
        }
    }

    async function loadPlayerMarketHistory(playerId) {
        const slot = els.drawerHistory;
        if (!slot) return;
        try {
            const params = new URLSearchParams({ scoring: state.seasonFantasyScoring, days: "30" });
            if (state.season != null) params.set("season", state.season);
            const data = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}/season-fantasy-history?${params}`);
            if (state.drawerPlayerId !== playerId || els.drawer.hidden || !(data.points || []).length) return;
            slot.innerHTML = "";
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "30-day value"));
            const values = data.points.map((point) => point.market).filter((value) => value != null);
            const spark = F.sparkline(values, 420, 92, 5);
            if (spark) {
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("viewBox", "0 0 420 92");
                svg.setAttribute("class", "sparkline sparkline--market");
                svg.setAttribute("role", "img");
                svg.setAttribute("aria-label", `Market value from ${F.formatPoints(spark.first)} to ${F.formatPoints(spark.last)}`);
                const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
                line.setAttribute("points", spark.points);
                line.setAttribute("fill", "none");
                line.setAttribute("stroke", "currentColor");
                line.setAttribute("stroke-width", "2.5");
                svg.appendChild(line);
                card.appendChild(svg);
            }
            slot.appendChild(card);
        } catch (err) { /* history is optional */ }
    }

    function seasonMarketCard(data) {
        const card = el("div", "drawer-card");
        const head = el("div", "season-props__player");
        head.appendChild(el("h3", "drawer-card__title",
            `${data.season || ""} season market lines`.trim()));
        // Each provider's own last movement, not the fetch time. A board can
        // be collected minutes ago and still be quoting eleven-day-old prices.
        head.appendChild(el("span", "season-props__asof",
            F.marketSources(data.sources) || data.source || ""));
        card.appendChild(head);

        const markets = data.markets || [];
        const posted = markets.filter((market) => market.line != null).length;
        if (posted === 0) {
            card.appendChild(el(
                "p",
                "season-props__status",
                "No usable regular-season market data for this player yet. Only a few hundred players have a quote or bounded last trade."
            ));
            return card;
        }

        const grid = el("div", "season-props__grid");
        markets.forEach((market) => grid.appendChild(seasonPropCard(market)));
        card.appendChild(grid);
        return card;
    }

    function seasonPropCard(market) {
        const card = el("article", "season-line");
        card.appendChild(el("h5", "season-line__label", market.label));
        if (market.line == null) {
            card.classList.add("season-line--empty");
            card.appendChild(el("p", "season-line__missing", "Not posted"));
            return card;
        }
        const line = Number(market.line);
        card.appendChild(el("p", "season-line__total", Number.isFinite(line) ? line.toLocaleString(undefined, { maximumFractionDigits: 1 }) : market.line));
        const prices = el("div", "season-line__prices");
        prices.appendChild(seasonPrice("Over", market.over_price));
        prices.appendChild(seasonPrice("Under", market.under_price));
        card.appendChild(prices);
        if (market.implied_value != null) {
            card.appendChild(el("p", "season-line__implied",
                `${F.seasonLine(market.implied_value)} implied`));
        }
        const books = market.books || [];
        const detail = books
            .map((book) => book.implied_value == null
                ? book.bookmaker
                : `${book.bookmaker} ${F.seasonLine(book.implied_value)}`)
            .join(" · ");
        card.appendChild(el("p", "season-line__books", detail || "Consensus line"));
        return card;
    }

    function seasonPrice(label, price) {
        const item = el("span", "season-price");
        item.appendChild(el("small", null, label));
        item.appendChild(el("b", null, price == null ? "—" : F.americanOdds(price)));
        return item;
    }

    // The exchange covers barely a hundred of the several thousand players in
    // the catalog, so a bare search box is a guessing game: most names a
    // manager thinks to type have no market at all. The board leads with who
    // actually has usable data, and the search is there to jump to one of them.
    async function loadSeasonPropLeaders(market) {
        if (!els.seasonPropsLeaders) return;
        try {
            const params = new URLSearchParams({ limit: "200" });
            if (market) params.set("market", market);
            if (state.season != null) params.set("season", state.season);
            const data = await fetchJson(`${API_BASE}/season-props?${params.toString()}`);
            state.seasonPropsMarket = data.market;
            if (!els.marketsDrawer.hidden) writeUrlState();
            renderSeasonPropTabs(data);
            renderSeasonPropLeaders(data);
        } catch (err) {
            els.seasonPropsLeaders.innerHTML = "";
            els.seasonPropsNote.textContent = "Season lines are unavailable right now.";
        }
    }

    function renderSeasonPropTabs(data) {
        els.seasonPropsTabs.innerHTML = "";
        (data.markets || []).forEach((entry) => {
            const tab = el("button", "chip", entry.label);
            tab.type = "button";
            tab.setAttribute("aria-pressed", String(entry.market === data.market));
            // A category with nothing trading stays visible but unclickable,
            // so the board reads as "not quoted" rather than "not built".
            tab.disabled = entry.players === 0;
            tab.title = entry.players === 0
                ? `${entry.label} — no usable market data`
                : `${entry.label} — ${entry.players} players with market data`;
            tab.addEventListener("click", () => {
                state.seasonPropsMarket = entry.market;
                writeUrlState(true);
                loadSeasonPropLeaders(entry.market);
            });
            els.seasonPropsTabs.appendChild(tab);
        });
    }

    // Both season boards rank the same market data, so they share one
    // position filter. The rows are already in hand, so a chip re-renders
    // locally — the request would only return the identical payload.
    function renderSeasonPositionChips(container, leaders, active, onPick) {
        if (!container) return;
        container.innerHTML = "";
        const options = [
            { position: "ALL", count: leaders.length },
            ...F.seasonPositionCounts(leaders),
        ];
        options.forEach(({ position, count }) => {
            const chip = el("button", "chip",
                position === "ALL" ? "All" : F.positionLabel(position));
            chip.type = "button";
            chip.dataset.position = position;
            chip.setAttribute("aria-pressed", String(position === active));
            chip.title = `${count} player${count === 1 ? "" : "s"}`;
            chip.addEventListener("click", () => onPick(position));
            container.appendChild(chip);
        });
    }

    // Changing scoring or market category swaps the player set underneath the
    // filter, so one the new set cannot satisfy falls back to the whole board
    // rather than leaving the user looking at an empty table.
    function resolveSeasonPosition(leaders, position) {
        if (!position || position === "ALL") return "ALL";
        return leaders.some((entry) => F.seasonPositionMatches(entry, position))
            ? position
            : "ALL";
    }

    function renderSeasonPropLeaders(data) {
        const all = data.leaders || [];
        const position = resolveSeasonPosition(all, state.seasonPropsPosition);
        state.seasonPropsPosition = position;
        renderSeasonPositionChips(els.seasonPropsPositions, all, position, (pick) => {
            state.seasonPropsPosition = pick;
            renderSeasonPropLeaders(data);
        });

        // Rank within the filtered view, keeping the board-wide rank so a
        // positional board still says where its players sit overall.
        const rows = all
            .map((entry, index) => ({ entry, overall: index + 1 }))
            .filter(({ entry }) => F.seasonPositionMatches(entry, position));

        els.seasonPropsLeaders.innerHTML = "";
        rows.forEach(({ entry, overall }, index) => {
            const player = entry.player || {};
            const tr = el("tr", "season-leader");
            tr.tabIndex = 0;
            tr.setAttribute("role", "button");
            tr.setAttribute("aria-label", `Open ${player.name || "player"} season lines`);
            tr.appendChild(el("td", "col-rank", index + 1));
            const who = el("td", "col-player");
            who.appendChild(el("span", "season-leader__name", player.name || player.player_id));
            const overallDetail = position === "ALL" ? "" : ` · ${overall} overall`;
            who.appendChild(el("span", "season-leader__meta",
                `${player.position || ""} ${player.team || ""}${overallDetail}`.trim()));
            tr.appendChild(who);
            tr.appendChild(el("td", "col-proj", F.seasonLine(entry.implied_value)));
            const movement = el("td", "col-proj season-fantasy__delta",
                entry.movement == null ? "—" : F.formatSigned(entry.movement, 1));
            if (entry.movement != null) movement.classList.add(entry.movement >= 0 ? "is-over" : "is-under");
            tr.appendChild(movement);
            tr.appendChild(seasonBookCell(entry.books, entry.book_values));
            const open = () => {
                if (player.player_id) openPlayer(player.player_id);
            };
            tr.addEventListener("click", open);
            tr.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open();
                }
            });
            els.seasonPropsLeaders.appendChild(tr);
        });

        if (!rows.length) {
            els.seasonPropsNote.textContent = "Nothing is quoted in this category yet.";
            return;
        }
        els.seasonPropsNote.textContent = [
            position === "ALL" ? `${rows.length} quoted` : `${rows.length} of ${all.length} ${position}s`,
            data.baseline_as_of ? `7d baseline ${F.formatAsOf(data.baseline_as_of)}` : "",
            F.marketSources(data.sources),
        ].filter(Boolean).join(" · ");
    }

    // How many providers stand behind a number, with the spread between them
    // on hover. One source and three sources are different claims, and the
    // board has no other way to say which one it is making.
    // Adds the compare toggle (and injury flag) to a market row's player cell.
    // Stops the row's own click so adding to the tray does not also open the
    // drawer over the board you are picking from.
    function attachRowCompare(cell, player) {
        const badge = F.injuryBadge(player.injury_status);
        if (badge) {
            cell.appendChild(el("span", `injury-badge injury-badge--${badge.severity}`, badge.label));
        }
        if (!player.player_id) return;
        const button = el("button", "row-compare", inCompare(player.player_id) ? "✓" : "+");
        button.type = "button";
        button.setAttribute("aria-label", `Compare ${player.name || "player"}`);
        if (inCompare(player.player_id)) button.classList.add("row-compare--on");
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleCompare(player);
            const on = inCompare(player.player_id);
            button.classList.toggle("row-compare--on", on);
            button.textContent = on ? "✓" : "+";
        });
        cell.appendChild(button);
    }

    function seasonBookCell(books, values) {
        const list = books || [];
        const cell = el("td", "col-books", list.length ? String(list.length) : "—");
        if (list.length) {
            cell.title = list
                .map((book) => values && values[book] != null
                    ? `${book} ${F.seasonLine(values[book])}`
                    : book)
                .join("\n");
        }
        return cell;
    }

    async function loadSeasonFantasyLeaders() {
        if (!els.seasonFantasyLeaders) return;
        try {
            const params = new URLSearchParams({
                limit: "100",
                scoring: state.seasonFantasyScoring,
            });
            const data = await fetchJson(`${API_BASE}/season-fantasy-points?${params.toString()}`);
            state.seasonFantasyData = data;
            if (state.boardMode === "week") renderMarketFreshness(data.sources || []);
            else renderSeasonFantasyLeaders(data);
            if (els.memberStatus?.textContent === "Latest market") {
                els.memberTeam.textContent = F.formatAsOf(data.as_of) || "—";
            }
        } catch (err) {
            els.seasonFantasyLeaders.innerHTML = "";
            els.seasonFantasyNote.textContent = "";
            // This board is the page now, so its failure is the page's.
            showError("Could not load the market board.");
        }
    }

    // Text sorts A–Z on first click, numbers biggest-first — nobody opens a
    // points column hoping to see the smallest number.
    const MARKET_SORTS = {
        player: { value: (e) => (e.player || {}).name || "", text: true },
        yard_points: { value: (e) => e.yard_points },
        touchdown_points: { value: (e) => e.touchdown_points },
        reception_points: { value: (e) => e.reception_points },
        fantasy_points: { value: (e) => e.fantasy_points },
        projected_points: { value: (e) => e.projected_points },
        projection_delta: { value: (e) => e.projection_delta },
    };

    function sortMarketRows(rows) {
        const { key, dir } = state.seasonFantasySort;
        const sort = MARKET_SORTS[key];
        if (!sort) return rows;
        const sign = dir === "asc" ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const left = sort.value(a.entry);
            const right = sort.value(b.entry);
            // A player the market or the projection feed never covered has no
            // place at either end of the order, so blanks sink either way.
            const leftMissing = left == null || left === "";
            const rightMissing = right == null || right === "";
            if (leftMissing || rightMissing) return leftMissing - rightMissing;
            if (sort.text) return sign * String(left).localeCompare(String(right));
            if (left !== right) return sign * (left - right);
            // Ties keep the board's own ranking rather than shuffling.
            return a.overall - b.overall;
        });
    }

    function initMarketSort() {
        document.querySelectorAll("#market-board .col-sort").forEach((button) => {
            button.addEventListener("click", () => {
                const key = button.dataset.sort;
                const current = state.seasonFantasySort;
                const first = MARKET_SORTS[key].text ? "asc" : "desc";
                state.seasonFantasySort = {
                    key,
                    dir: current.key === key && current.dir === first
                        ? (first === "asc" ? "desc" : "asc")
                        : first,
                };
                writeUrlState();
                if (state.seasonFantasyData) renderSeasonFantasyLeaders(state.seasonFantasyData);
            });
        });
    }

    function syncMarketSortHeaders() {
        const { key, dir } = state.seasonFantasySort;
        document.querySelectorAll("#market-board .col-sort").forEach((button) => {
            const active = button.dataset.sort === key;
            button.classList.toggle("is-sorted", active);
            button.classList.toggle("is-asc", active && dir === "asc");
            const cell = button.closest("th");
            if (cell) cell.setAttribute("aria-sort", active ? (dir === "asc" ? "ascending" : "descending") : "none");
        });
    }

    function renderSeasonFantasyLeaders(data) {
        const all = data.leaders || [];
        const position = resolveSeasonPosition(all, state.seasonFantasyPosition);
        state.seasonFantasyPosition = position;
        renderSeasonPositionChips(els.seasonFantasyPositions, all, position, (pick) => {
            state.seasonFantasyPosition = pick;
            writeUrlState();
            renderSeasonFantasyLeaders(data);
        });

        // `overall` is fixed to the server's market-value ranking before any
        // local sort, so it keeps meaning "where this player sits on the
        // board" rather than "where this view happens to put him".
        const rows = sortMarketRows(all
            .map((entry, index) => ({ entry, overall: index + 1 }))
            .filter(({ entry }) => F.seasonPositionMatches(entry, position)));
        syncMarketSortHeaders();

        const visibleRows = state.marketExpanded ? rows : rows.slice(0, 10);
        els.seasonFantasyLeaders.innerHTML = "";
        visibleRows.forEach(({ entry, overall }, index) => {
            const player = entry.player || {};
            const tr = el("tr", "season-leader");
            tr.tabIndex = 0;
            tr.setAttribute("role", "button");
            tr.setAttribute("aria-label", `Open ${player.name || "player"} season lines`);
            tr.appendChild(el("td", "col-rank", index + 1));
            const who = el("td", "col-player");
            who.appendChild(el("span", "season-leader__name", player.name || player.player_id));
            const receptionDetail = data.scoring !== "std" && entry.projected_receptions != null
                ? ` · ${F.seasonLine(entry.projected_receptions)} rec proj`
                : "";
            const bookDetail = (entry.books || []).length
                ? ` · ${entry.books.length} source${entry.books.length === 1 ? "" : "s"}`
                : "";
            const sorted = state.seasonFantasySort;
            const boardOrder = sorted.key === "fantasy_points" && sorted.dir === "desc";
            const overallDetail = position === "ALL" && boardOrder ? "" : ` · ${overall} overall`;
            // A discarded category is a caveat about the total, not another
            // fact about the player, so it is marked rather than run in.
            const pairs = F.seasonPairDetail(entry.pairs_used, entry.partial_pairs, entry.missing_pairs);
            const scoredDetail = pairs.scored ? ` · ${pairs.scored}` : "";
            const meta = el("span", "season-leader__meta",
                `${player.position || ""} ${player.team || ""}${overallDetail}${scoredDetail}`.trim());
            // Directly after the categories it qualifies, ahead of the source
            // count, so it reads as a note on them rather than a trailing aside.
            if (pairs.missing) meta.appendChild(el("span", "season-leader__gap", ` · ${pairs.missing}`));
            if (bookDetail || receptionDetail) {
                meta.appendChild(document.createTextNode(`${bookDetail}${receptionDetail}`));
            }
            who.appendChild(meta);
            attachRowCompare(who, player);
            tr.appendChild(who);
            tr.appendChild(el("td", "col-proj col-detail", F.formatPoints(entry.yard_points)));
            tr.appendChild(el("td", "col-proj col-detail", F.formatPoints(entry.touchdown_points)));
            tr.appendChild(el("td", "col-proj col-detail", F.formatPoints(entry.reception_points)));
            tr.appendChild(el("td", "col-proj season-fantasy__total", F.formatPoints(entry.fantasy_points)));
            tr.appendChild(el("td", "col-proj season-fantasy__proj", F.formatPoints(entry.projected_points)));
            tr.appendChild(deltaCell(entry));
            const open = () => {
                if (player.player_id) openPlayer(player.player_id);
            };
            tr.addEventListener("click", open);
            tr.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open();
                }
            });
            els.seasonFantasyLeaders.appendChild(tr);
        });

        // "Consensus" is only true when more than one provider has a
        // season-long run; with one it is that provider's number, and saying
        // otherwise would overstate the column.
        if (els.seasonFantasyProjHead) {
            const src = data.projection_source;
            els.seasonFantasyProjHead.textContent = src ? providerFor(src).label : "Proj";
            els.seasonFantasyProjHead.title = Array.isArray(data.projection_providers)
                ? `Projected points, averaged across ${data.projection_providers.join(", ")}`
                : "Season-long projected points";
        }

        const positionMetric = position === "ALL" ? "" : ` · ${rows.length} of ${all.length} ${position}`;
        const excludedMetric = data.excluded_without_projection
            ? ` · ${data.excluded_without_projection} quoted player${data.excluded_without_projection === 1 ? "" : "s"} hidden — no reception projection`
            : "";
        els.seasonFantasyNote.textContent = rows.length
            ? `${visibleRows.length} of ${rows.length}${positionMetric}${excludedMetric} · ${F.formatAsOf(data.as_of) || "latest"}`
            : "";
        if (els.showAllMarket) {
            els.showAllMarket.hidden = rows.length <= 10;
            els.showAllMarket.textContent = state.marketExpanded ? "Show less" : `Show all ${rows.length}`;
            els.showAllMarket.setAttribute("aria-expanded", String(state.marketExpanded));
        }
        renderMarketFreshness(data.sources || []);
        if (!rows.length) renderMarketBoardEmpty(all.length, position);
    }

    // ── week board ──────────────────────────────────────────────────────────
    //
    // In-season the collector already snapshots weekly projections and rebuilds
    // the derived rankings every week, and /rankings already attaches the
    // opponent from the schedule and the movement since last week's board.
    // None of it was rendered: the page showed a season-long market board
    // straight through the games it exists to help with. This is that stored
    // data, nothing new collected.
    //
    // It is a second table rather than a re-columned market table. The two
    // share no column but the player, and the market table's widths are tuned
    // per column down to the phone breakpoints — re-columning it in place
    // would mean every one of those rules had to know which board it was in.

    function weekBoardAvailable() {
        return !!state.inSeason && state.week != null && state.week > 0;
    }

    function renderBoardMode() {
        if (!els.boardMode) return;
        const available = weekBoardAvailable();
        els.boardMode.hidden = !available;
        if (!available) {
            els.boardMode.innerHTML = "";
            return;
        }
        els.boardMode.innerHTML = "";
        [
            { key: "season", label: "Season" },
            { key: "week", label: `Week ${state.week}` },
        ].forEach((option) => {
            const chip = el("button", "chip", option.label);
            chip.type = "button";
            chip.dataset.board = option.key;
            chip.setAttribute("aria-pressed", String(option.key === state.boardMode));
            chip.addEventListener("click", () => setBoardMode(option.key));
            els.boardMode.appendChild(chip);
        });
    }

    // Clamps to the season board whenever there is no week to show, so an old
    // ?board=week link in the offseason lands on something real.
    function setBoardMode(mode) {
        const week = mode === "week" && weekBoardAvailable();
        state.boardMode = week ? "week" : "season";
        if (els.marketBoardEyebrow) {
            els.marketBoardEyebrow.textContent = week ? `Week ${state.week}` : "Season board";
        }
        if (els.marketBoardTitle) {
            els.marketBoardTitle.textContent = week ? "Week Board" : "Market Value";
        }
        if (els.marketTableWrap) els.marketTableWrap.hidden = week;
        if (els.weekBoardWrap) els.weekBoardWrap.hidden = !week;
        renderBoardMode();
        writeUrlState();
        renderActiveBoard();
    }

    function renderActiveBoard() {
        if (state.boardMode === "week") {
            if (state.weekBoard) renderWeekBoard();
            else loadWeekBoard();
            return;
        }
        if (state.seasonFantasyData) renderSeasonFantasyLeaders(state.seasonFantasyData);
    }

    async function loadWeekBoard() {
        if (!els.weekLeaders || !weekBoardAvailable()) return;
        try {
            const params = new URLSearchParams({
                scoring: state.seasonFantasyScoring,
                week: String(state.week),
                limit: "200",
            });
            if (state.season != null) params.set("season", state.season);
            const data = await fetchJson(`${API_BASE}/rankings?${params.toString()}`);
            state.weekBoard = normalizeWeekBoard(data);
        } catch (err) {
            state.weekBoard = { week: state.week, as_of: null, leaders: [] };
        }
        // A reply that lands after the reader has gone back to the season
        // board is kept, not drawn.
        if (state.boardMode === "week") renderWeekBoard();
    }

    // The rankings payload is flat — one player per row — while every board
    // helper here expects {player: {...}}. Reshaping on arrival keeps the
    // position chips, the injury badge and the compare tray working unchanged.
    function normalizeWeekBoard(data) {
        const leaders = (data.rankings || []).map((row) => ({
            player: {
                player_id: row.player_id,
                name: row.name,
                team: row.team,
                position: row.position,
                injury_status: row.injury_status,
            },
            rank: row.rank,
            projected_points: row.projected_points,
            prev_rank: row.prev_rank,
            opponent: row.opponent,
            home: row.home,
            bye: row.bye,
        }));
        return {
            season: data.season,
            week: data.week,
            as_of: data.as_of,
            source: data.source,
            leaders,
        };
    }

    // "@ BUF", "vs BUF", "BYE", or nothing when no schedule is loaded — the
    // API distinguishes a team absent from a loaded week (a bye) from a week
    // it has no schedule for at all, and so does this.
    function weekMatchupLabel(entry) {
        if (entry.bye) return "BYE";
        if (!entry.opponent) return "";
        return `${entry.home === false ? "@" : "vs"} ${entry.opponent}`;
    }

    function renderWeekBoard() {
        if (!els.weekLeaders) return;
        const data = state.weekBoard || { leaders: [] };
        const all = data.leaders || [];
        const position = resolveSeasonPosition(all, state.seasonFantasyPosition);
        state.seasonFantasyPosition = position;
        renderSeasonPositionChips(els.seasonFantasyPositions, all, position, (pick) => {
            state.seasonFantasyPosition = pick;
            writeUrlState();
            renderWeekBoard();
        });

        const rows = all
            .map((entry, index) => ({ entry, overall: index + 1 }))
            .filter(({ entry }) => F.seasonPositionMatches(entry, position));
        const visibleRows = state.marketExpanded ? rows : rows.slice(0, 10);

        els.weekLeaders.innerHTML = "";
        visibleRows.forEach(({ entry, overall }, index) => {
            const player = entry.player || {};
            const tr = el("tr", "season-leader");
            tr.tabIndex = 0;
            tr.setAttribute("role", "button");
            tr.setAttribute("aria-label", `Open ${player.name || "player"} season lines`);
            tr.appendChild(el("td", "col-rank", index + 1));

            const who = el("td", "col-player");
            who.appendChild(el("span", "season-leader__name", player.name || player.player_id));
            const matchup = weekMatchupLabel(entry);
            const overallDetail = position === "ALL" ? "" : ` · ${overall} overall`;
            const meta = el("span", "season-leader__meta",
                `${player.position || ""} ${player.team || ""}${overallDetail}`.trim());
            // The opponent is the reason to read a weekly board rather than a
            // season one, so it sits apart from the identity that precedes it.
            if (matchup) {
                const opponent = el("span", "season-leader__matchup", ` · ${matchup}`);
                if (entry.bye) opponent.classList.add("season-leader__matchup--bye");
                meta.appendChild(opponent);
            }
            who.appendChild(meta);
            attachRowCompare(who, player);
            tr.appendChild(who);

            tr.appendChild(el("td", "col-proj season-fantasy__total",
                F.formatPoints(entry.projected_points)));
            tr.appendChild(weekMoveCell(entry));

            const open = () => {
                if (player.player_id) openPlayer(player.player_id);
            };
            tr.addEventListener("click", open);
            tr.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open();
                }
            });
            els.weekLeaders.appendChild(tr);
        });

        if (els.weekProjHead) {
            els.weekProjHead.textContent = "Proj";
            els.weekProjHead.title = `Consensus projected points for week ${data.week ?? state.week}`;
        }
        const positionMetric = position === "ALL" ? "" : ` · ${rows.length} of ${all.length} ${position}`;
        els.seasonFantasyNote.textContent = rows.length
            ? `${visibleRows.length} of ${rows.length}${positionMetric} · Week ${data.week ?? state.week} · ${F.formatAsOf(data.as_of) || "latest"}`
            : "";
        if (els.showAllMarket) {
            els.showAllMarket.hidden = rows.length <= 10;
            els.showAllMarket.textContent = state.marketExpanded ? "Show less" : `Show all ${rows.length}`;
            els.showAllMarket.setAttribute("aria-expanded", String(state.marketExpanded));
        }
        if (!rows.length) renderWeekBoardEmpty(all.length, position);
    }

    // Rank movement against last week's board, which the API computes by
    // ranking the prior week the same way. A player who was not ranked then
    // has no move to report rather than a move of zero.
    function weekMoveCell(entry) {
        if (entry.prev_rank == null || entry.rank == null) {
            const blank = el("td", "col-proj season-fantasy__delta", "—");
            blank.title = "Not on last week's board";
            return blank;
        }
        const move = entry.prev_rank - entry.rank;
        const cell = el("td", "col-proj season-fantasy__delta", move === 0 ? "—" : F.formatSigned(move, 0));
        if (move !== 0) cell.classList.add(move > 0 ? "is-over" : "is-under");
        cell.title = `Was ${entry.prev_rank} last week`;
        return cell;
    }

    function renderWeekBoardEmpty(total, position) {
        const row = el("tr");
        const cell = el("td", "table-empty");
        cell.colSpan = 4;
        cell.textContent = total
            ? `No ${position} is projected for week ${state.week} yet.`
            : `Week ${state.week} projections have not been collected yet.`;
        row.appendChild(cell);
        els.weekLeaders.appendChild(row);
    }

    function renderMarketFreshness(sources) {
        if (!els.marketFreshness) return;
        els.marketFreshness.innerHTML = "";
        (sources || []).forEach((source) => {
            const item = el("li");
            const label = el("span", "freshness-source");
            const dot = el("span", "freshness-dot");
            const quoted = source.quoted_at ? new Date(source.quoted_at) : null;
            if (!quoted || Date.now() - quoted.getTime() > 7 * 86400000) dot.classList.add("is-stale");
            label.appendChild(dot);
            label.append(source.bookmaker || "Source");
            item.appendChild(label);
            item.appendChild(el("span", "freshness-time", F.formatAsOf(source.quoted_at) || "Unknown"));
            els.marketFreshness.appendChild(item);
        });
        if (!els.marketFreshness.childElementCount) {
            els.marketFreshness.appendChild(el("li", "empty-row", "Unavailable"));
        }
    }

    // How far the market sits from consensus. The signed number is the point
    // of the column; the percentage rides along in the tooltip because +30 on
    // a 320-point quarterback and +30 on a 95-point tight end are not the
    // same claim.
    function deltaCell(entry) {
        const delta = entry.projection_delta;
        if (delta == null) return el("td", "col-proj season-fantasy__delta");
        const cell = el("td", "col-proj season-fantasy__delta", F.formatSigned(delta, 1));
        cell.classList.add(delta >= 0 ? "is-over" : "is-under");
        const detail = entry.projected_points
            ? [`${F.formatSigned(delta, 1)} vs ${F.formatPoints(entry.projected_points)} projected`,
               `(${F.formatSigned((delta / entry.projected_points) * 100, 1)}%)`].join(" ")
            : "";
        // A total missing a category the projection still counts produces a
        // gap that looks like market disagreement and is not. Marked, not
        // hidden — it remains the closest comparison there is, and the reader
        // can see from the row which categories the market number is built on.
        const pairs = F.seasonPairDetail(entry.pairs_used, entry.partial_pairs, entry.missing_pairs);
        if (entry.edge_is_qualified) {
            cell.classList.add("is-qualified");
            cell.appendChild(el("span", "sr-only", ` (${pairs.missing})`));
        }
        const title = [detail, entry.edge_is_qualified
            ? `Market total covers ${pairs.scored || "nothing"} only — ${pairs.missing}, so this gap is partly missing data, not market disagreement.`
            : ""].filter(Boolean).join(" · ");
        if (title) cell.title = title;
        return cell;
    }

    // The board is the page's front door; a bare table with no rows reads as
    // broken rather than as "not collected yet".
    function renderMarketBoardEmpty(total, position) {
        const row = el("tr");
        const cell = el("td", "table-empty");
        cell.colSpan = 8;
        cell.textContent = total
            ? `No ${position} has a complete yardage and touchdown market pair yet.`
            : "No season markets have been collected yet. The research panels below and your league tools still work.";
        row.appendChild(cell);
        els.seasonFantasyLeaders.appendChild(row);
    }

    function initSeasonFantasyScoring() {
        if (!els.seasonFantasyScoring) return;
        const options = [
            { key: "std", label: "Standard" },
            { key: "half", label: "Half PPR" },
            { key: "ppr", label: "PPR" },
        ];
        options.forEach((option) => {
            const chip = el("button", "chip", option.label);
            chip.type = "button";
            chip.dataset.scoring = option.key;
            chip.setAttribute("aria-pressed", String(option.key === state.seasonFantasyScoring));
            chip.addEventListener("click", () => {
                state.seasonFantasyScoring = option.key;
                writeUrlState();
                els.seasonFantasyScoring.querySelectorAll(".chip").forEach((item) => {
                    item.setAttribute("aria-pressed", String(item.dataset.scoring === option.key));
                });
                loadSeasonFantasyLeaders();
                state.weekBoard = null;
                if (state.boardMode === "week") loadWeekBoard();
                loadMarketMovers();
                loadMemberSnapshot();
            });
            els.seasonFantasyScoring.appendChild(chip);
        });
    }

    async function loadSeasonOffenses() {
        if (!els.seasonOffenseYards || !els.seasonOffenseTouchdowns) return;
        try {
            const data = await fetchJson(`${API_BASE}/season-offenses?limit=10`);
            renderSeasonOffenseList(els.seasonOffenseYards, data.yards, "yards");
            renderSeasonOffenseList(els.seasonOffenseTouchdowns, data.touchdowns, "TDs");
            els.seasonOffensesNote.textContent = [
                `${(data.yards || []).length} yards · ${(data.touchdowns || []).length} TD`,
                F.marketSources(data.sources),
            ].filter(Boolean).join(" · ");
        } catch (err) {
            renderSeasonOffenseList(els.seasonOffenseYards, [], "yards");
            renderSeasonOffenseList(els.seasonOffenseTouchdowns, [], "TDs");
            els.seasonOffensesNote.textContent = "Team offense rankings are unavailable right now.";
        }
    }

    function renderSeasonOffenseList(target, rows, unit) {
        target.innerHTML = "";
        (rows || []).forEach((entry, index) => {
            const item = el("li", "season-offense");
            item.appendChild(el("span", "season-offense__rank", index + 1));
            item.appendChild(el("b", "season-offense__team", entry.team));
            const detail = el("span", "season-offense__detail");
            const source = entry.air_source === "receiving" ? "receiving fallback" : "passing";
            detail.textContent = `${F.seasonLine(entry.air)} air + ${F.seasonLine(entry.ground)} rush · ${source}`;
            item.appendChild(detail);
            item.appendChild(el("strong", "season-offense__total", `${F.seasonLine(entry.total)} ${unit}`));
            target.appendChild(item);
        });
        if (!rows || rows.length === 0) {
            target.appendChild(el("li", "season-offense-list__empty", "Not enough quoted markets yet."));
        }
    }

    // ── trending ────────────────────────────────────────────────────────

    function renderTrending(listEl, players) {
        listEl.innerHTML = "";
        if (!players || players.length === 0) {
            listEl.appendChild(el("li", "trending__empty", "—"));
            return;
        }
        players.forEach((player) => {
            const li = el("li", "trending__item");
            li.tabIndex = 0;
            li.setAttribute("role", "button");
            const name = el("span", "trending__name", player.name || player.player_id);
            const meta = el(
                "span",
                "trending__meta",
                `${F.positionLabel(player.position) || ""} ${player.team || ""}`.trim()
            );
            li.appendChild(name);
            li.appendChild(meta);
            const open = () => openPlayer(player.player_id);
            li.addEventListener("click", open);
            li.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                }
            });
            listEl.appendChild(li);
        });
    }

    async function loadDashboard() {
        try {
            const data = await fetchJson(`${API_BASE}/dashboard`);
            renderTrending(els.trendingAdd, data.trending_add);
            renderTrending(els.trendingDrop, data.trending_drop);
        } catch (err) {
            renderTrending(els.trendingAdd, []);
            renderTrending(els.trendingDrop, []);
        }
    }

    async function loadMarketMovers() {
        if (!els.marketMovers) return;
        try {
            const params = new URLSearchParams({
                scoring: state.seasonFantasyScoring,
                days: "7",
                limit: "5",
            });
            if (state.season != null) params.set("season", state.season);
            state.movers = await fetchJson(`${API_BASE}/season-fantasy-movers?${params}`);
            renderMarketMovers();
        } catch (err) {
            state.movers = null;
            renderMarketMovers();
        }
    }

    function renderMarketMovers() {
        els.marketMovers.innerHTML = "";
        const rows = state.movers ? (state.movers[state.moversView] || []) : [];
        rows.forEach((entry) => {
            const item = el("li");
            const left = el("span");
            left.appendChild(el("span", "mover-name", entry.player.name || entry.player.player_id));
            left.appendChild(el("span", "mover-value", ` ${F.formatPoints(entry.current_value)}`));
            item.appendChild(left);
            const delta = el("strong", "mover-delta", F.formatSigned(entry.delta, 1));
            if (entry.delta < 0) delta.classList.add("is-down");
            item.appendChild(delta);
            item.tabIndex = 0;
            item.setAttribute("role", "button");
            item.addEventListener("click", () => openPlayer(entry.player.player_id));
            item.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openPlayer(entry.player.player_id);
                }
            });
            els.marketMovers.appendChild(item);
        });
        if (!rows.length) els.marketMovers.appendChild(el("li", "empty-row", "No 7-day baseline"));
        els.marketMoversNote.textContent = state.movers?.baseline_as_of
            ? `Baseline ${F.formatAsOf(state.movers.baseline_as_of)}` : "";
    }

    async function loadMemberSnapshot() {
        if (!els.memberStatus || state.season == null) return;
        const params = new URLSearchParams({ season: state.season, scoring: state.seasonFantasyScoring });
        if (state.week != null) params.set("week", state.week);
        try {
            const data = await fetchJson(`${API_BASE}/league/me?${params}`);
            renderMemberSnapshot(data);
        } catch (err) {
            els.memberStatus.textContent = "Latest market";
            els.memberTeam.textContent = state.seasonFantasyData?.as_of
                ? F.formatAsOf(state.seasonFantasyData.as_of) : "—";
            els.memberMetrics.innerHTML = "";
            els.chooseTeam.hidden = true;
            els.teamSelect.hidden = true;
        }
    }

    function renderMemberSnapshot(data) {
        els.teamSelect.innerHTML = "";
        els.teamSelect.appendChild(new Option("Choose your team", ""));
        (data.teams || []).forEach((team) => {
            els.teamSelect.appendChild(new Option(team.name || team.abbrev, team.espn_team_id));
        });
        if (data.status !== "configured" || !data.snapshot) {
            els.memberStatus.textContent = "League snapshot";
            els.memberTeam.textContent = "Choose your team";
            els.memberMetrics.innerHTML = "";
            els.chooseTeam.hidden = false;
            els.teamSelect.hidden = true;
            return;
        }
        const snapshot = data.snapshot;
        const team = snapshot.team || {};
        els.memberStatus.textContent = team.owner_name || "Your team";
        els.memberTeam.textContent = team.name || team.abbrev || "Team";
        els.memberMetrics.innerHTML = "";
        const record = snapshot.record || {};
        const values = [
            `${record.wins || 0}–${record.losses || 0}${record.ties ? `–${record.ties}` : ""}`,
            snapshot.opponent ? `vs ${snapshot.opponent.abbrev || snapshot.opponent.name}` : (snapshot.is_bye ? "Bye" : ""),
            snapshot.power_rank ? `Power #${snapshot.power_rank}` : "",
            snapshot.waiver_rank ? `Waiver #${snapshot.waiver_rank}` : "",
            snapshot.starter_projection != null ? `${F.formatPoints(snapshot.starter_projection)} proj` : "",
        ].filter(Boolean);
        values.forEach((value) => els.memberMetrics.appendChild(el("span", null, value)));
        els.chooseTeam.hidden = false;
        els.chooseTeam.textContent = "Change team";
        els.teamSelect.value = String(data.selected_team_id);
        els.teamSelect.hidden = true;
    }

    async function saveMemberTeam() {
        const teamId = Number(els.teamSelect.value);
        if (!teamId || state.season == null) return;
        try {
            const response = await fetch(`${API_BASE}/league/me`, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ season: state.season, espn_team_id: teamId }),
            });
            if (!response.ok) throw new Error("Could not save team");
            renderMemberSnapshot(await response.json());
        } catch (err) {
            showError("Could not save your league team.");
        }
    }

    // ── betting: games, props, futures ──────────────────────────────────

    /* The group wraps game lines and player props behind one heading, so it
       stays hidden until at least one of them has something to show. */
    function syncMarketGroup() {
        els.marketGroup.hidden = els.gamesSection.hidden && els.propsSection.hidden;
        syncLiveMarkets();
    }

    // The zone has no content of its own, so an empty one is just a heading
    // over nothing — which is what the offseason looks like.
    function syncLiveMarkets() {
        if (!els.liveMarkets) return;
        const empty = els.marketGroup.hidden && els.futuresSection.hidden;
        els.liveMarkets.hidden = empty;
    }

    async function loadGames() {
        try {
            const params = new URLSearchParams();
            if (state.week != null) params.set("week", state.week);
            const data = await fetchJson(`${API_BASE}/games?${params.toString()}`);
            const withLines = (data.games || []).filter((g) => g.lines);
            if (withLines.length === 0) {
                els.gamesSection.hidden = true;
                return;
            }
            els.gamesAsOf.textContent = F.formatAsOf(data.as_of);
            els.gamesStrip.innerHTML = "";
            withLines.forEach((game) => els.gamesStrip.appendChild(gameCard(game)));
            els.gamesSection.hidden = false;
        } catch (err) { /* leave hidden */ } finally { syncMarketGroup(); }
    }

    function gameCard(game) {
        const card = el("div", "game-card");
        const head = el("div", "game-card__teams");
        head.appendChild(el("span", "game-card__team", `${game.away_team} @ ${game.home_team}`));
        card.appendChild(head);

        const lines = game.lines;
        const row = el("div", "game-card__lines");
        row.appendChild(lineCell("Spread", F.formatSpread(lines.spread_home), spreadMoveText(game)));
        row.appendChild(lineCell("Total", lines.total != null ? `O/U ${lines.total}` : "—"));
        const ml = lines.moneyline_home != null || lines.moneyline_away != null
            ? `${F.americanOdds(lines.moneyline_away)} / ${F.americanOdds(lines.moneyline_home)}`
            : "—";
        row.appendChild(lineCell("ML (A/H)", ml));
        card.appendChild(row);
        return card;
    }

    function spreadMoveText(game) {
        if (game.spread_move == null || game.spread_move === 0) return "";
        return `${F.formatSigned(game.spread_move, 1)} since open`;
    }

    function lineCell(label, value, sub) {
        const cell = el("div", "line-cell");
        cell.appendChild(el("span", "line-cell__label", label));
        cell.appendChild(el("span", "line-cell__value", value));
        if (sub) cell.appendChild(el("span", "line-cell__sub", sub));
        return cell;
    }

    async function loadProps() {
        try {
            const data = await fetchJson(`${API_BASE}/props`);
            const featured = data.featured || [];
            if (featured.length === 0) return;
            els.propsAsOf.textContent = F.formatAsOf(data.as_of);
            els.propGameTabs.innerHTML = "";
            featured.forEach((game, index) => {
                const label = `${game.away_team || "?"} @ ${game.home_team || "?"}`;
                const tab = el("button", "chip", label);
                tab.type = "button";
                tab.dataset.index = String(index);
                tab.setAttribute("aria-pressed", String(index === 0));
                tab.addEventListener("click", () => {
                    els.propGameTabs.querySelectorAll(".chip").forEach((c) =>
                        c.setAttribute("aria-pressed", String(c === tab)));
                    renderPropsBoard(game);
                });
                els.propGameTabs.appendChild(tab);
            });
            renderPropsBoard(featured[0]);
            els.propsSection.hidden = false;
        } catch (err) { /* leave hidden */ } finally { syncMarketGroup(); }
    }

    function renderPropsBoard(game) {
        els.propsBoard.innerHTML = "";
        (game.markets || []).forEach((market) => {
            const block = el("div", "prop-market");
            block.appendChild(el("h5", "prop-market__title", market.label));
            const table = el("table", "mini-table");
            const tbody = el("tbody");
            market.lines.slice(0, 8).forEach((line) => {
                const tr = el("tr");
                tr.appendChild(el("td", "mini-opp", line.player_name || "—"));
                const pt = market.market === "player_anytime_td" ? "" : (line.point != null ? String(line.point) : "—");
                tr.appendChild(el("td", "mini-week", pt));
                tr.appendChild(el("td", "mini-pts", F.americanOdds(line.price)));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            block.appendChild(table);
            els.propsBoard.appendChild(block);
        });
    }

    async function loadFutures() {
        try {
            const data = await fetchJson(`${API_BASE}/futures`);
            if (!data.outcomes || data.outcomes.length === 0) return;
            els.futuresAsOf.textContent = F.formatAsOf(data.as_of);
            renderFutures(data);
            els.futuresTabs.innerHTML = "";
            (data.markets || []).forEach((marketKey) => {
                const tab = el("button", "chip", futuresLabel(marketKey));
                tab.type = "button";
                tab.setAttribute("aria-pressed", String(marketKey === data.market));
                tab.addEventListener("click", async () => {
                    const next = await fetchJson(`${API_BASE}/futures?market=${encodeURIComponent(marketKey)}`);
                    els.futuresTabs.querySelectorAll(".chip").forEach((c) =>
                        c.setAttribute("aria-pressed", String(c === tab)));
                    renderFutures(next);
                });
                els.futuresTabs.appendChild(tab);
            });
            els.futuresSection.hidden = false;
            syncLiveMarkets();
        } catch (err) { /* leave hidden */ }
    }

    function futuresLabel(key) {
        return key
            .replace(/^americanfootball_nfl_/, "")
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function renderFutures(data) {
        els.futuresBody.innerHTML = "";
        (data.outcomes || []).forEach((row, index) => {
            const tr = el("tr");
            tr.appendChild(el("td", "col-rank", index + 1));
            tr.appendChild(el("td", "col-player", row.outcome));
            tr.appendChild(el("td", "col-proj", F.americanOdds(row.price)));
            els.futuresBody.appendChild(tr);
        });
    }

    // ── drawers and comparison ──────────────────────────────────────────

    function openMarkets(category, pushHistory = true) {
        if (!els.drawer.hidden) closeDrawer(false);
        if (!els.compareDrawer.hidden) closeCompare();
        rememberOverlayFocus();
        state.seasonPropsMarket = category || state.seasonPropsMarket || "season_pass_yds";
        els.marketsDrawer.hidden = false;
        document.body.classList.add("drawer-open");
        writeUrlState(pushHistory);
        loadSeasonPropLeaders(state.seasonPropsMarket);
        els.marketsClose.focus();
    }

    function closeMarkets(pushHistory = true) {
        if (!els.marketsDrawer || els.marketsDrawer.hidden) return;
        els.marketsDrawer.hidden = true;
        state.seasonPropsMarket = null;
        syncDrawerBody();
        writeUrlState(pushHistory);
        restoreOverlayFocus();
    }

    function inCompare(playerId) {
        return state.compare.some((p) => p.player_id === playerId);
    }

    function toggleCompare(player) {
        if (!player.player_id) return;
        if (inCompare(player.player_id)) {
            state.compare = state.compare.filter((p) => p.player_id !== player.player_id);
        } else {
            if (state.compare.length >= MAX_COMPARE) return;
            state.compare.push({ player_id: player.player_id, name: player.name });
        }
        renderCompareTray();
    }

    function renderCompareTray() {
        els.compareChips.innerHTML = "";
        state.compare.forEach((player) => {
            const chip = el("span", "compare-chip");
            chip.appendChild(el("span", "compare-chip__name", player.name || player.player_id));
            const remove = el("button", "compare-chip__x", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove ${player.name || "player"}`);
            remove.addEventListener("click", () => toggleCompare(player));
            chip.appendChild(remove);
            els.compareChips.appendChild(chip);
        });
        els.compareTray.hidden = state.compare.length === 0;
        els.compareGo.disabled = state.compare.length < 2;
        els.compareGo.textContent = `Compare (${state.compare.length})`;
    }

    async function openCompare() {
        if (state.compare.length < 2) return;
        closeMarkets(false);
        if (!els.drawer.hidden) closeDrawer(false);
        rememberOverlayFocus();
        els.compareDrawer.hidden = false;
        document.body.classList.add("drawer-open");
        els.compareSub.textContent = "Loading…";
        els.compareBody.innerHTML = "";
        els.compareDrawerClose.focus();
        // Same ppr|half|std vocabulary as the market board's toggle, applied
        // to a different subject — the reader's league format does not change
        // between the two, so one control is right.
        const params = new URLSearchParams({
            ids: state.compare.map((p) => p.player_id).join(","),
            scoring: state.seasonFantasyScoring,
        });
        try {
            const data = await fetchJson(`${API_BASE}/compare?${params.toString()}`);
            renderCompare(data);
            window.pgAnalytics?.track?.("fantasy_compare", { count: state.compare.length });
        } catch (err) {
            els.compareSub.textContent = "";
            els.compareBody.appendChild(el("p", "drawer__loading", "Could not load the comparison."));
        }
    }

    // The board's payload holds every quoted player, so absence from it is
    // the answer "this player has no season market", not a cache miss.
    function marketRowFor(playerId) {
        const leaders = (state.seasonFantasyData || {}).leaders || [];
        return leaders.find((entry) => (entry.player || {}).player_id === playerId) || null;
    }

    function renderCompare(data) {
        const provider = providerFor(data.source);
        const when = data.week === 0 ? `${data.season} season-long` : `Week ${data.week}`;
        els.compareSub.textContent = `${when} · ${data.scoring.toUpperCase()} · ${provider.label}`;
        els.compareBody.innerHTML = "";

        const players = data.players || [];
        if (players.length === 0) {
            els.compareBody.appendChild(el("p", "drawer__loading", "No players to compare."));
            return;
        }
        const best = Math.max(...players.map((p) => p.projected_points || 0));
        const bestMarket = Math.max(...players.map((p) => p.market?.total || 0));
        const grid = el("div", "compare-grid");
        grid.style.gridTemplateColumns = `repeat(${players.length}, minmax(0, 1fr))`;
        players.forEach((player) => {
            const col = el("div", "compare-col");
            col.appendChild(el("h3", "compare-col__name", player.name || player.player_id));
            const meta = [F.positionLabel(player.position), player.team, F.formatMatchup(player)]
                .filter(Boolean).join(" · ");
            col.appendChild(el("p", "compare-col__meta", meta));

            // Market value first: it is what this page ranks on. The rows are
            // already loaded for the board, so no second request is needed —
            // and a player absent from that payload has no market at all,
            // which is a fact worth stating rather than hiding.
            const marketEntry = player.market || marketRowFor(player.player_id);
            const marketWrap = el("div", "compare-col__proj");
            const marketValue = el("span", "compare-col__proj-value",
                marketEntry ? F.formatPoints(marketEntry.total ?? marketEntry.fantasy_points) : "—");
            if (marketEntry && (marketEntry.total ?? marketEntry.fantasy_points ?? 0) === bestMarket && bestMarket > 0) {
                marketValue.classList.add("is-best");
            }
            marketWrap.appendChild(marketValue);
            marketWrap.appendChild(el("span", "compare-col__proj-label",
                marketEntry ? "market pts" : "not quoted"));
            col.appendChild(marketWrap);

            if (marketEntry && (marketEntry.total ?? marketEntry.fantasy_points) != null) {
                // The gap note is the same either way: quoted_categories names
                // the raw markets behind the total, pairs_used names the
                // scoring categories, but a category the total is missing has
                // to show up in both shapes or the edge below reads as market
                // disagreement when it is missing data.
                const gaps = F.seasonPairDetail(
                    marketEntry.pairs_used, marketEntry.partial_pairs, marketEntry.missing_pairs);
                const scored = marketEntry.quoted_categories
                    ? marketEntry.quoted_categories.map((key) => key.replace(/^season_/, "").replaceAll("_", " ")).join(" · ")
                    : gaps.scored;
                const detail = [scored, gaps.missing].filter(Boolean).join(" · ");
                if (detail) col.appendChild(el("p", "compare-col__market-detail", detail));
                const edge = marketEntry.edge ?? marketEntry.projection_delta;
                const projection = marketEntry.projection ?? marketEntry.projected_points;
                if (edge != null) {
                    const delta = el("p", "compare-col__delta",
                        `${F.formatSigned(edge, 1)} vs ${F.formatPoints(projection)} season proj`);
                    delta.classList.add(edge >= 0 ? "is-over" : "is-under");
                    if (marketEntry.edge_is_qualified) {
                        delta.classList.add("is-qualified");
                        // `scored`, not `gaps.scored`: compare sends the raw
                        // quoted markets rather than the scoring categories,
                        // so the resolved string is the one with content.
                        delta.title = `Market total covers ${scored} only — ${gaps.missing}, so this gap is partly missing data, not market disagreement.`;
                    }
                    col.appendChild(delta);
                }
            }

            const projWrap = el("div", "compare-col__proj compare-col__proj--weekly");
            const projValue = el("span", "compare-col__proj-value", F.formatPoints(player.projected_points));
            if ((player.projected_points || 0) === best && best > 0) projValue.classList.add("is-best");
            projWrap.appendChild(projValue);
            projWrap.appendChild(el("span", "compare-col__proj-label",
                data.week === 0 ? "season proj" : `wk ${data.week} proj`));
            col.appendChild(projWrap);

            const badge = F.injuryBadge(player.injury_status);
            if (badge) {
                const chip = el("span", `injury-badge injury-badge--${badge.severity}`, badge.label);
                col.appendChild(chip);
            }

            const recent = player.recent_ppr || [];
            if (recent.length > 0) {
                col.appendChild(el("p", "compare-col__section", "Last games (PPR)"));
                const list = el("ul", "compare-col__games");
                recent.forEach((game) => {
                    const li = el("li", null,
                        `Wk ${game.week}${game.opponent ? ` vs ${game.opponent}` : ""}: ${F.formatPoints(game.fantasy_points_ppr)}`);
                    list.appendChild(li);
                });
                col.appendChild(list);
            }
            grid.appendChild(col);
        });
        els.compareBody.appendChild(grid);
    }

    function closeCompare() {
        els.compareDrawer.hidden = true;
        syncDrawerBody();
        restoreOverlayFocus();
    }

    // ── player drawer ───────────────────────────────────────────────────

    async function openPlayer(playerId, pushHistory = true) {
        if (!playerId) return;
        closeMarkets(false);
        if (!els.compareDrawer.hidden) closeCompare();
        rememberOverlayFocus();
        state.drawerPlayerId = playerId;
        els.drawer.hidden = false;
        document.body.classList.add("drawer-open");
        writeUrlState(pushHistory);
        els.drawerName.textContent = "—";
        els.drawerSub.textContent = "";
        els.drawerBody.innerHTML = '<p class="drawer__loading">Loading…</p>';
        els.drawerClose.focus();
        window.pgAnalytics?.track?.("fantasy_player_view", { player_id: playerId });

        try {
            // No source parameter: the server resolves Sleeper-first then any
            // provider, which is the same run the market board compares its
            // projection column against — so drawer and board agree by
            // construction rather than by passing the same value around.
            const player = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}`);
            if (state.drawerPlayerId !== playerId) return;
            renderPlayer(player);
        } catch (err) {
            if (state.drawerPlayerId !== playerId) return;
            els.drawerBody.innerHTML = "";
            els.drawerBody.appendChild(el("p", "drawer__loading", "Could not load this player."));
            return;
        }
        loadPlayerSeasonProps(playerId);
        loadPlayerMarketHistory(playerId);
        loadPlayerNews(playerId);
    }

    // News is fetched separately so a slow (or failed) ESPN lookup never
    // delays the projection/stats cards; the card just appears when ready.
    async function loadPlayerNews(playerId) {
        try {
            const news = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}/news`);
            if (state.drawerPlayerId !== playerId || els.drawer.hidden) return;
            const articles = news.articles || [];
            if (articles.length === 0) return;

            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Recent articles"));
            const list = el("ul", "news-list");
            articles.slice(0, 5).forEach((article) => {
                if (!/^https?:\/\//.test(article.url || "")) return;
                const item = el("li", "news-item");
                const link = el("a", "news-item__title", article.headline || "Untitled");
                link.href = article.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                item.appendChild(link);
                const meta = [F.formatArticleDate(article.published_at), article.byline]
                    .filter(Boolean)
                    .join(" · ");
                if (meta) item.appendChild(el("span", "news-item__meta", meta));
                list.appendChild(item);
            });
            if (!list.childElementCount) return;
            card.appendChild(list);
            els.drawerBody.appendChild(card);
        } catch (err) { /* drawer works without news */ }
    }

    function renderPlayer(player) {
        els.drawerName.textContent = player.name || "Unknown player";
        const bits = [F.positionLabel(player.position), player.team].filter(Boolean);
        const matchup = F.formatMatchup(player);
        if (matchup) bits.push(matchup);
        if (player.injury_status) bits.push(player.injury_status);
        els.drawerSub.textContent = bits.join(" · ");

        els.drawerBody.innerHTML = "";
        const actions = el("div", "drawer-actions");
        actions.appendChild(compareToggleButton(player));
        const rankings = el("a", "drawer-compare__btn", "Open Rankings");
        rankings.href = `/fantasy/rankings/?player=${encodeURIComponent(player.player_id)}`;
        actions.appendChild(rankings);
        els.drawerBody.appendChild(actions);
        const marketEntry = marketRowFor(player.player_id);
        if (marketEntry) {
            const card = el("div", "drawer-card drawer-card--value");
            card.appendChild(el("h3", "drawer-card__title", "Market value"));
            const grid = el("div", "proj-grid");
            grid.appendChild(statBlock("Market", F.formatPoints(marketEntry.fantasy_points)));
            grid.appendChild(statBlock("Projection", F.formatPoints(marketEntry.projected_points)));
            grid.appendChild(statBlock("Edge", F.formatSigned(marketEntry.projection_delta, 1)));
            card.appendChild(grid);
            els.drawerBody.appendChild(card);
        }
        // Reserved up front so the market card can sit first despite being
        // the last thing to arrive.
        els.drawerMarket = el("div", "drawer-market");
        els.drawerBody.appendChild(els.drawerMarket);
        els.drawerHistory = el("div", "drawer-history");
        els.drawerBody.appendChild(els.drawerHistory);

        if (player.projection) {
            const proj = player.projection;
            const card = el("div", "drawer-card");
            const projTitle = proj.week === 0 ? `${proj.season} season projection` : `Week ${proj.week} projection`;
            card.appendChild(el("h3", "drawer-card__title", projTitle));
            const grid = el("div", "proj-grid");
            grid.appendChild(statBlock("PPR", F.formatPoints(proj.pts_ppr)));
            grid.appendChild(statBlock("Half", F.formatPoints(proj.pts_half_ppr)));
            grid.appendChild(statBlock("Std", F.formatPoints(proj.pts_std)));
            card.appendChild(grid);
            const source = el("p", "projection-source");
            source.append("Projection by ");
            const provider = providerFor(proj.source);
            if (provider.url) {
                source.appendChild(providerLink(provider));
            } else {
                source.append(provider.label);
            }
            if (proj.source === "consensus" && Array.isArray(proj.providers)) {
                source.append(` (avg of ${proj.providers.join(", ")})`);
            }
            const asOf = F.formatAsOf(proj.as_of);
            if (asOf) source.append(` · ${asOf}`);
            card.appendChild(source);
            els.drawerBody.appendChild(card);
        }

        const spark = buildSparkline(player.projection_history);
        if (spark) {
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Projection movement"));
            card.appendChild(spark);
            els.drawerBody.appendChild(card);
        }

        const accuracy = buildAccuracy(player.projection_vs_actual);
        if (accuracy) {
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Projected vs actual"));
            card.appendChild(accuracy);
            els.drawerBody.appendChild(card);
        }

        const props = player.props || [];
        if (props.length > 0) {
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Player props"));
            const table = el("table", "mini-table");
            const tbody = el("tbody");
            props.forEach((prop) => {
                const tr = el("tr");
                tr.appendChild(el("td", "mini-opp", prop.label));
                tr.appendChild(el("td", "mini-week", prop.point != null ? String(prop.point) : ""));
                tr.appendChild(el("td", "mini-pts", F.americanOdds(prop.price)));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            card.appendChild(table);
            els.drawerBody.appendChild(card);
        }

        const games = player.recent_games || [];
        if (games.length > 0) {
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Recent games"));
            const table = el("table", "mini-table");
            const tbody = el("tbody");
            games.forEach((game) => {
                const tr = el("tr");
                tr.appendChild(el("td", "mini-week", `Wk ${game.week}`));
                tr.appendChild(el("td", "mini-opp", game.opponent ? `vs ${game.opponent}` : "—"));
                tr.appendChild(el("td", "mini-pts", `${F.formatPoints(game.fantasy_points_ppr)} pts`));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            card.appendChild(table);
            els.drawerBody.appendChild(card);
        }

        if (!player.projection && games.length === 0 && !spark && !accuracy && props.length === 0) {
            els.drawerBody.appendChild(el("p", "drawer__loading", "No projection or game data collected yet."));
        }
    }

    function compareToggleButton(player) {
        const wrap = el("div", "drawer-compare");
        const btn = el("button", "drawer-compare__btn", inCompare(player.player_id) ? "✓ In compare" : "+ Add to compare");
        btn.type = "button";
        if (inCompare(player.player_id)) btn.classList.add("is-on");
        btn.addEventListener("click", () => {
            toggleCompare({ player_id: player.player_id, name: player.name });
            const on = inCompare(player.player_id);
            btn.textContent = on ? "✓ In compare" : "+ Add to compare";
            btn.classList.toggle("is-on", on);
        });
        wrap.appendChild(btn);
        return wrap;
    }

    function statBlock(label, value) {
        const block = el("div", "proj-stat");
        block.appendChild(el("span", "proj-stat__value", value));
        block.appendChild(el("span", "proj-stat__label", label));
        return block;
    }

    function buildSparkline(history) {
        const values = (history || []).map((h) => h.pts_ppr).filter((v) => v != null);
        const spark = F.sparkline(values, 240, 56, 4);
        if (!spark) return null;

        const svgNs = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("viewBox", "0 0 240 56");
        svg.setAttribute("class", "sparkline");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", `Projection trend from ${F.formatPoints(spark.first)} to ${F.formatPoints(spark.last)} PPR points`);
        const line = document.createElementNS(svgNs, "polyline");
        line.setAttribute("points", spark.points);
        line.setAttribute("fill", "none");
        line.setAttribute("stroke", "currentColor");
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("stroke-linejoin", "round");
        svg.appendChild(line);

        const wrap = el("div", "sparkline-wrap");
        wrap.appendChild(svg);
        const caption = el("p", "sparkline-caption",
            `${F.formatPoints(spark.first)} → ${F.formatPoints(spark.last)} PPR across ${values.length} snapshots`);
        wrap.appendChild(caption);
        return wrap;
    }

    // Projected-vs-actual: a compact per-week table with paired bars. Only
    // weeks that have an actual result are worth charting.
    function buildAccuracy(series) {
        const rows = (series || []).filter((row) => row.actual != null);
        if (rows.length === 0) return null;
        const max = Math.max(
            ...rows.map((row) => Math.max(row.projected || 0, row.actual || 0)),
            1
        );
        const wrap = el("div", "accuracy");
        rows.slice(-8).forEach((row) => {
            const line = el("div", "accuracy__row");
            line.appendChild(el("span", "accuracy__week", `Wk ${row.week}`));
            const bars = el("div", "accuracy__bars");
            bars.appendChild(accuracyBar("proj", row.projected, max, "Proj"));
            bars.appendChild(accuracyBar("actual", row.actual, max, "Actual"));
            line.appendChild(bars);
            const diff = row.projected != null && row.actual != null
                ? row.actual - row.projected : null;
            const diffText = diff == null ? "" : F.formatSigned(diff, 1);
            const diffEl = el("span", "accuracy__diff", diffText);
            if (diff != null) diffEl.classList.add(diff >= 0 ? "is-up" : "is-down");
            line.appendChild(diffEl);
            wrap.appendChild(line);
        });
        const legend = el("p", "accuracy__legend");
        legend.appendChild(el("span", "accuracy__key accuracy__key--proj", "Projected"));
        legend.appendChild(el("span", "accuracy__key accuracy__key--actual", "Actual"));
        wrap.appendChild(legend);
        return wrap;
    }

    function accuracyBar(kind, value, max, label) {
        const track = el("div", `accuracy__bar accuracy__bar--${kind}`);
        const fill = el("div", "accuracy__fill");
        fill.style.width = `${Math.max(0, Math.min(100, ((value || 0) / max) * 100))}%`;
        fill.title = `${label}: ${F.formatPoints(value)}`;
        track.appendChild(fill);
        track.appendChild(el("span", "accuracy__value", F.formatPoints(value)));
        return track;
    }

    function closeDrawer(pushHistory = true) {
        els.drawer.hidden = true;
        state.drawerPlayerId = null;
        syncDrawerBody();
        writeUrlState(pushHistory);
        restoreOverlayFocus();
    }

    // ── header / state ──────────────────────────────────────────────────

    function renderWeekBadge() {
        const seasonLong = state.week === 0;
        if (seasonLong) {
            // "Season" over the year already says season-long; the badge is a
            // narrow column and the old third line wrapped to three rows in it.
            els.weekLabel.textContent = "Season";
            els.weekValue.textContent = state.season != null ? state.season : "—";
            els.seasonValue.textContent = "";
        } else {
            els.weekLabel.textContent = "Week";
            els.weekValue.textContent = state.week != null ? state.week : "—";
            els.seasonValue.textContent = state.season ? String(state.season) : "";
        }
    }

    function renderHeader(data) {
        state.inSeason = !!data.in_season;
        state.defaultWeek = data.default_week != null ? data.default_week : data.week;
        state.season = data.default_season != null ? data.default_season : data.season;
        // URL week wins if provided; otherwise the resolved default.
        if (state.week == null) {
            state.week = state.defaultWeek;
        }
        renderWeekBadge();
        // Re-applies ?board=week now that there is a week to apply it to, and
        // falls back to the season board when there is not.
        setBoardMode(state.boardMode);

        const seasonLong = state.week === 0;
        if (!data.in_season || data.is_fallback) {
            els.offseasonBanner.textContent = seasonLong
                ? `Offseason · ${state.season} season-long`
                : `Offseason · ${state.season || ""} Week ${state.week || "—"}`;
            els.offseasonBanner.hidden = false;
        }
    }

    function initCompareControls() {
        els.compareClear.addEventListener("click", () => {
            state.compare = [];
            renderCompareTray();
            // Repaint the board's row buttons from the payload already in hand.
            renderActiveBoard();
        });
        els.compareGo.addEventListener("click", openCompare);
        els.compareDrawerClose.addEventListener("click", closeCompare);
        els.compareBackdrop.addEventListener("click", closeCompare);
    }

    async function init() {
        const urlState = readUrlState();
        initSearch();
        initMarketSort();
        loadSeasonPropLeaders(state.seasonPropsMarket);
        initSeasonFantasyScoring();
        loadSeasonFantasyLeaders();
        loadSeasonOffenses();
        initCompareControls();
        renderCompareTray();
        els.showAllMarket.addEventListener("click", () => {
            state.marketExpanded = !state.marketExpanded;
            renderActiveBoard();
        });
        els.playerMarkets.addEventListener("click", () => openMarkets());
        els.marketsClose.addEventListener("click", () => closeMarkets());
        els.marketsBackdrop.addEventListener("click", () => closeMarkets());
        document.querySelectorAll("[data-movers]").forEach((button) => {
            button.addEventListener("click", () => {
                state.moversView = button.dataset.movers;
                document.querySelectorAll("[data-movers]").forEach((item) => {
                    const on = item === button;
                    item.classList.toggle("is-active", on);
                    item.setAttribute("aria-pressed", String(on));
                });
                renderMarketMovers();
            });
        });
        els.chooseTeam.addEventListener("click", () => {
            els.teamSelect.hidden = false;
            els.teamSelect.focus();
        });
        els.teamSelect.addEventListener("change", saveMemberTeam);
        els.drawerClose.addEventListener("click", closeDrawer);
        els.drawerBackdrop.addEventListener("click", closeDrawer);
        document.addEventListener("keydown", (e) => {
            trapDialogFocus(e);
            if (e.key !== "Escape") return;
            if (!els.marketsDrawer.hidden) closeMarkets();
            else if (!els.compareDrawer.hidden) closeCompare();
            else if (!els.drawer.hidden) closeDrawer();
        });
        window.addEventListener("popstate", () => {
            const params = new URLSearchParams(window.location.search);
            const player = params.get("player");
            const category = params.get("category");
            els.drawer.hidden = true;
            els.compareDrawer.hidden = true;
            els.marketsDrawer.hidden = true;
            state.drawerPlayerId = null;
            state.seasonPropsMarket = null;
            syncDrawerBody();
            if (player) openPlayer(player, false);
            else if (category) openMarkets(category, false);
        });

        try {
            const stateData = await fetchJson(`${API_BASE}/state`);
            renderHeader(stateData);
            loadMemberSnapshot();
            loadMarketMovers();
        } catch (err) {
            showError("Could not load the current NFL week.");
        }

        await Promise.all([
            loadDashboard(),
            loadGames(),
            loadProps(),
            loadFutures(),
        ]);

        if (urlState.player) openPlayer(urlState.player, false);
        else if (urlState.category) openMarkets(urlState.category, false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
