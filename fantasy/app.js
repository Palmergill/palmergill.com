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
    const RANK_COLSPAN = 7;
    const MAX_COMPARE = 4;

    const state = {
        season: null,
        week: null,
        defaultWeek: null,
        inSeason: false,
        position: "ALL",
        scoring: "ppr",
        source: "sleeper",
        sources: [],
        drawerPlayerId: null,
        compare: [], // [{ player_id, name }]
    };

    const els = {
        weekLabel: document.getElementById("weekLabel"),
        weekValue: document.getElementById("weekValue"),
        seasonValue: document.getElementById("seasonValue"),
        offseasonBanner: document.getElementById("offseasonBanner"),
        errorBanner: document.getElementById("errorBanner"),
        weekSelect: document.getElementById("weekSelect"),
        playerSearch: document.getElementById("playerSearch"),
        searchResults: document.getElementById("searchResults"),
        positionChips: document.getElementById("positionChips"),
        scoringChips: document.getElementById("scoringChips"),
        sourceChips: document.getElementById("sourceChips"),
        rankingsSource: document.getElementById("rankingsSource"),
        rankingsAsOf: document.getElementById("rankingsAsOf"),
        rankBody: document.getElementById("rankBody"),
        trendingAdd: document.getElementById("trendingAdd"),
        trendingDrop: document.getElementById("trendingDrop"),
        gamesSection: document.getElementById("gamesSection"),
        gamesStrip: document.getElementById("gamesStrip"),
        gamesAsOf: document.getElementById("gamesAsOf"),
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

    function formatAsOf(iso) {
        if (!iso) return "";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        return `as of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
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

    function providerFor(sourceId) {
        return state.sources.find((source) => source.id === sourceId) || {
            id: sourceId,
            label: sourceId ? sourceId.replace(/\b\w/g, (char) => char.toUpperCase()) : "Unknown",
            url: null,
        };
    }

    // ── URL state (shareable deep links) ────────────────────────────────

    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        if (params.has("pos")) state.position = params.get("pos").toUpperCase();
        if (params.has("scoring")) state.scoring = params.get("scoring");
        if (params.has("source")) state.source = params.get("source");
        if (params.has("week")) {
            const week = Number(params.get("week"));
            if (Number.isInteger(week)) state.week = week;
        }
        return { player: params.get("player") };
    }

    function writeUrlState() {
        const params = new URLSearchParams();
        if (state.position && state.position !== "ALL") params.set("pos", state.position);
        if (state.scoring && state.scoring !== "ppr") params.set("scoring", state.scoring);
        if (state.source && state.source !== "sleeper") params.set("source", state.source);
        if (state.week != null && state.week !== state.defaultWeek) params.set("week", state.week);
        if (state.drawerPlayerId && !els.drawer.hidden) params.set("player", state.drawerPlayerId);
        const query = params.toString();
        const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
        window.history.replaceState(null, "", url);
    }

    // ── controls ────────────────────────────────────────────────────────

    function buildChips() {
        F.POSITIONS.forEach((pos) => {
            const chip = el("button", "chip", pos);
            chip.type = "button";
            chip.dataset.position = pos;
            chip.setAttribute("aria-pressed", String(pos === state.position));
            chip.addEventListener("click", () => {
                state.position = pos;
                syncChips();
                writeUrlState();
                loadRankings();
                window.pgAnalytics?.track?.("app_event", "fantasy_filter", { position: pos });
            });
            els.positionChips.appendChild(chip);
        });

        F.SCORINGS.forEach((scoring) => {
            const chip = el("button", "chip chip--scoring", scoring.label);
            chip.type = "button";
            chip.dataset.scoring = scoring.key;
            chip.setAttribute("aria-pressed", String(scoring.key === state.scoring));
            chip.addEventListener("click", () => {
                state.scoring = scoring.key;
                syncChips();
                writeUrlState();
                loadRankings();
            });
            els.scoringChips.appendChild(chip);
        });
    }

    function syncChips() {
        els.positionChips.querySelectorAll(".chip").forEach((chip) => {
            chip.setAttribute("aria-pressed", String(chip.dataset.position === state.position));
        });
        els.scoringChips.querySelectorAll(".chip").forEach((chip) => {
            chip.setAttribute("aria-pressed", String(chip.dataset.scoring === state.scoring));
        });
        els.sourceChips.querySelectorAll(".chip").forEach((chip) => {
            chip.setAttribute("aria-pressed", String(chip.dataset.source === state.source));
        });
    }

    function renderSourceChips(sources) {
        state.sources = sources;
        if (!sources.some((source) => source.id === state.source)) {
            state.source = sources[0]?.id || "sleeper";
        }
        els.sourceChips.innerHTML = "";
        sources.forEach((source) => {
            const chip = el("button", "chip chip--source", source.label);
            chip.type = "button";
            chip.dataset.source = source.id;
            chip.setAttribute("aria-pressed", String(source.id === state.source));
            if (source.id === "consensus" && source.blended) {
                chip.title = `Average of ${source.blended.join(", ")}`;
            }
            chip.addEventListener("click", () => {
                if (state.source === source.id) return;
                state.source = source.id;
                syncChips();
                writeUrlState();
                loadRankings();
                if (state.drawerPlayerId && !els.drawer.hidden) openPlayer(state.drawerPlayerId);
                window.pgAnalytics?.track?.("app_event", "fantasy_source", { source: source.id });
            });
            els.sourceChips.appendChild(chip);
        });
    }

    async function loadSources() {
        const params = new URLSearchParams();
        if (state.season != null) params.set("season", state.season);
        if (state.week != null) params.set("week", state.week);
        try {
            const data = await fetchJson(`${API_BASE}/projection-sources?${params.toString()}`);
            renderSourceChips(data.sources || []);
        } catch (err) {
            renderSourceChips([{ id: "sleeper", label: "Sleeper", url: "https://sleeper.com/" }]);
        }
    }

    // ── week switcher ───────────────────────────────────────────────────

    function buildWeekSelector() {
        els.weekSelect.innerHTML = "";
        const options = [{ value: 0, label: "Season-long" }];
        if (state.inSeason) {
            for (let week = 1; week <= 18; week += 1) {
                options.push({ value: week, label: `Week ${week}` });
            }
        } else if (state.defaultWeek && state.defaultWeek > 0) {
            // Offseason fallback to a prior in-season week: still let the user
            // browse that season's weeks.
            for (let week = 1; week <= 18; week += 1) {
                options.push({ value: week, label: `Week ${week}` });
            }
        }
        options.forEach((opt) => {
            const node = el("option", null, opt.label);
            node.value = String(opt.value);
            if (opt.value === state.week) node.selected = true;
            els.weekSelect.appendChild(node);
        });
        els.weekSelect.onchange = async () => {
            state.week = Number(els.weekSelect.value);
            writeUrlState();
            renderWeekBadge();
            await loadSources();
            syncChips();
            await Promise.all([loadRankings(), loadGames()]);
        };
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

    // ── rankings ────────────────────────────────────────────────────────

    async function loadRankings() {
        const requestedSource = state.source;
        const requestedWeek = state.week;
        els.rankBody.innerHTML = "";
        els.rankBody.appendChild(rowMessage("Loading rankings…"));
        const params = new URLSearchParams({
            position: F.positionQuery(state.position),
            scoring: state.scoring,
            limit: "100",
        });
        if (state.season != null) params.set("season", state.season);
        if (state.week != null) params.set("week", state.week); // 0 = season-long
        if (state.source) params.set("source", state.source);

        try {
            const data = await fetchJson(`${API_BASE}/rankings?${params.toString()}`);
            if (state.source !== requestedSource || state.week !== requestedWeek) return;
            renderRankings(data);
        } catch (err) {
            if (state.source !== requestedSource || state.week !== requestedWeek) return;
            els.rankBody.innerHTML = "";
            els.rankBody.appendChild(rowMessage("Rankings unavailable right now."));
            showError(err.message);
        }
    }

    function rowMessage(text) {
        const tr = el("tr");
        const td = el("td", "table-empty", text);
        td.colSpan = RANK_COLSPAN;
        tr.appendChild(td);
        return tr;
    }

    function renderRankings(data) {
        els.rankingsSource.innerHTML = "";
        if (data.source) {
            const provider = providerFor(data.source);
            els.rankingsSource.append("Projections by ");
            if (provider.url) {
                els.rankingsSource.appendChild(providerLink(provider));
            } else {
                els.rankingsSource.append(provider.label);
            }
        }
        els.rankingsAsOf.textContent = formatAsOf(data.as_of);
        els.rankBody.innerHTML = "";

        const rows = data.rankings || [];
        if (rows.length === 0) {
            els.rankBody.appendChild(rowMessage("No rankings for this filter yet."));
            return;
        }
        rows.forEach((row) => {
            const tr = el("tr", "rank-row");
            tr.tabIndex = 0;
            tr.setAttribute("role", "button");
            tr.appendChild(el("td", "col-rank", row.rank));
            tr.appendChild(moveCell(row));
            tr.appendChild(playerCell(row));
            tr.appendChild(el("td", "col-pos", F.positionLabel(row.position) || "—"));
            tr.appendChild(el("td", "col-team", row.team || "—"));
            tr.appendChild(opponentCell(row));
            tr.appendChild(el("td", "col-proj", F.formatPoints(row.projected_points)));
            const open = () => openPlayer(row.player_id);
            tr.addEventListener("click", open);
            tr.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                }
            });
            els.rankBody.appendChild(tr);
        });
    }

    function moveCell(row) {
        const td = el("td", "col-move");
        const delta = F.rankDelta(row.prev_rank, row.rank);
        if (!delta) {
            // No prior-week rank: newly ranked this week (dot), or season-long
            // view where movement doesn't apply (blank).
            if ("prev_rank" in row && row.prev_rank == null) {
                const dot = el("span", "move move--new", "NEW");
                dot.title = "Newly ranked this week";
                td.appendChild(dot);
            }
            return td;
        }
        if (delta.direction === "same") {
            td.appendChild(el("span", "move move--same", "–"));
        } else {
            const glyph = delta.direction === "up" ? "▲" : "▼";
            const span = el("span", `move move--${delta.direction}`, `${glyph}${delta.amount}`);
            span.title = `${delta.direction === "up" ? "Up" : "Down"} ${delta.amount} vs last week`;
            td.appendChild(span);
        }
        return td;
    }

    function playerCell(row) {
        const td = el("td", "col-player");
        td.appendChild(el("span", "player-name", row.name || "—"));
        const badge = F.injuryBadge(row.injury_status);
        if (badge) {
            const chip = el("span", `injury-badge injury-badge--${badge.severity}`, badge.code);
            chip.title = badge.label;
            td.appendChild(chip);
        }
        const compareBtn = el("button", "row-compare", inCompare(row.player_id) ? "✓" : "+");
        compareBtn.type = "button";
        compareBtn.title = inCompare(row.player_id) ? "Remove from compare" : "Add to compare";
        compareBtn.setAttribute("aria-label", compareBtn.title);
        if (inCompare(row.player_id)) compareBtn.classList.add("row-compare--on");
        compareBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleCompare({ player_id: row.player_id, name: row.name });
            compareBtn.textContent = inCompare(row.player_id) ? "✓" : "+";
            compareBtn.classList.toggle("row-compare--on", inCompare(row.player_id));
            compareBtn.title = inCompare(row.player_id) ? "Remove from compare" : "Add to compare";
        });
        td.appendChild(compareBtn);
        return td;
    }

    function opponentCell(row) {
        const text = F.formatMatchup(row);
        const td = el("td", "col-opp", text || "—");
        if (text === "BYE") td.classList.add("col-opp--bye");
        return td;
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

    // ── betting: games, props, futures ──────────────────────────────────

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
            els.gamesAsOf.textContent = formatAsOf(data.as_of);
            els.gamesStrip.innerHTML = "";
            withLines.forEach((game) => els.gamesStrip.appendChild(gameCard(game)));
            els.gamesSection.hidden = false;
        } catch (err) { /* leave hidden */ }
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
            els.propsAsOf.textContent = formatAsOf(data.as_of);
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
        } catch (err) { /* leave hidden */ }
    }

    function renderPropsBoard(game) {
        els.propsBoard.innerHTML = "";
        (game.markets || []).forEach((market) => {
            const block = el("div", "prop-market");
            block.appendChild(el("h3", "prop-market__title", market.label));
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
            els.futuresAsOf.textContent = formatAsOf(data.as_of);
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

    // ── compare tray + drawer ───────────────────────────────────────────

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
        els.compareDrawer.hidden = false;
        document.body.classList.add("drawer-open");
        els.compareSub.textContent = "Loading…";
        els.compareBody.innerHTML = "";
        els.compareDrawerClose.focus();
        const params = new URLSearchParams({
            ids: state.compare.map((p) => p.player_id).join(","),
            scoring: state.scoring,
        });
        if (state.source) params.set("source", state.source);
        try {
            const data = await fetchJson(`${API_BASE}/compare?${params.toString()}`);
            renderCompare(data);
            window.pgAnalytics?.track?.("app_event", "fantasy_compare", { count: state.compare.length });
        } catch (err) {
            els.compareSub.textContent = "";
            els.compareBody.appendChild(el("p", "drawer__loading", "Could not load the comparison."));
        }
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
        const grid = el("div", "compare-grid");
        grid.style.gridTemplateColumns = `repeat(${players.length}, minmax(0, 1fr))`;
        players.forEach((player) => {
            const col = el("div", "compare-col");
            col.appendChild(el("h3", "compare-col__name", player.name || player.player_id));
            const meta = [F.positionLabel(player.position), player.team, F.formatMatchup(player)]
                .filter(Boolean).join(" · ");
            col.appendChild(el("p", "compare-col__meta", meta));

            const projWrap = el("div", "compare-col__proj");
            const projValue = el("span", "compare-col__proj-value", F.formatPoints(player.projected_points));
            if ((player.projected_points || 0) === best && best > 0) projValue.classList.add("is-best");
            projWrap.appendChild(projValue);
            projWrap.appendChild(el("span", "compare-col__proj-label", "proj pts"));
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
        if (els.drawer.hidden) document.body.classList.remove("drawer-open");
    }

    // ── player drawer ───────────────────────────────────────────────────

    async function openPlayer(playerId) {
        if (!playerId) return;
        const requestedSource = state.source;
        state.drawerPlayerId = playerId;
        els.drawer.hidden = false;
        document.body.classList.add("drawer-open");
        writeUrlState();
        els.drawerName.textContent = "—";
        els.drawerSub.textContent = "";
        els.drawerBody.innerHTML = '<p class="drawer__loading">Loading…</p>';
        els.drawerClose.focus();
        window.pgAnalytics?.track?.("app_event", "fantasy_player_view", { player_id: playerId });

        try {
            const params = new URLSearchParams({ source: state.source });
            const player = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}?${params.toString()}`);
            if (state.drawerPlayerId !== playerId || state.source !== requestedSource) return;
            renderPlayer(player);
        } catch (err) {
            if (state.drawerPlayerId !== playerId || state.source !== requestedSource) return;
            els.drawerBody.innerHTML = "";
            els.drawerBody.appendChild(el("p", "drawer__loading", "Could not load this player."));
            return;
        }
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
        els.drawerBody.appendChild(compareToggleButton(player));

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
            const asOf = formatAsOf(proj.as_of);
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

    function closeDrawer() {
        els.drawer.hidden = true;
        state.drawerPlayerId = null;
        if (els.compareDrawer.hidden) document.body.classList.remove("drawer-open");
        writeUrlState();
    }

    // ── header / state ──────────────────────────────────────────────────

    function renderWeekBadge() {
        const seasonLong = state.week === 0;
        if (seasonLong) {
            els.weekLabel.textContent = "Season";
            els.weekValue.textContent = state.season != null ? state.season : "—";
            els.seasonValue.textContent = "season-long rankings";
        } else {
            els.weekLabel.textContent = "Week";
            els.weekValue.textContent = state.week != null ? state.week : "—";
            els.seasonValue.textContent = state.season ? `${state.season} season` : "";
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

        const seasonLong = state.week === 0;
        if (!data.in_season || data.is_fallback) {
            let message;
            if (seasonLong) {
                message = `It's the NFL offseason — showing season-long rankings for the upcoming ${state.season} season. Weekly rankings start in September.`;
            } else {
                const season = data.season || "";
                const showing = state.season && state.week ? `Showing ${state.season} Week ${state.week} data.` : "";
                message = `It's the NFL offseason${season ? ` (${season})` : ""} — new-season games start in September. ${showing}`.trim();
            }
            els.offseasonBanner.textContent = message;
            els.offseasonBanner.hidden = false;
        }
    }

    function initCompareControls() {
        els.compareClear.addEventListener("click", () => {
            state.compare = [];
            renderCompareTray();
            loadRankings();
        });
        els.compareGo.addEventListener("click", openCompare);
        els.compareDrawerClose.addEventListener("click", closeCompare);
        els.compareBackdrop.addEventListener("click", closeCompare);
    }

    async function init() {
        const urlState = readUrlState();
        buildChips();
        initSearch();
        initCompareControls();
        renderCompareTray();
        els.drawerClose.addEventListener("click", closeDrawer);
        els.drawerBackdrop.addEventListener("click", closeDrawer);
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (!els.compareDrawer.hidden) closeCompare();
            else if (!els.drawer.hidden) closeDrawer();
        });

        try {
            const stateData = await fetchJson(`${API_BASE}/state`);
            renderHeader(stateData);
            buildWeekSelector();
            await loadSources();
            syncChips();
        } catch (err) {
            showError("Could not load the current NFL week.");
            renderSourceChips([{ id: "sleeper", label: "Sleeper", url: "https://sleeper.com/" }]);
        }

        await Promise.all([
            loadRankings(),
            loadDashboard(),
            loadGames(),
            loadProps(),
            loadFutures(),
        ]);

        if (urlState.player) openPlayer(urlState.player);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
