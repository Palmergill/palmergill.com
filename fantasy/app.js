// Fantasy dashboard controller. Vanilla JS, no build step. Reads the P1
// fantasy API and renders the rankings board, trending panels, and a player
// detail slide-over. Formatting/derivation lives in format.js (FantasyFormat).
(function () {
    "use strict";

    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy`;
    const F = window.FantasyFormat;

    const state = {
        season: null,
        week: null,
        position: "ALL",
        scoring: "ppr",
        drawerPlayerId: null,
    };

    const els = {
        weekLabel: document.getElementById("weekLabel"),
        weekValue: document.getElementById("weekValue"),
        seasonValue: document.getElementById("seasonValue"),
        offseasonBanner: document.getElementById("offseasonBanner"),
        errorBanner: document.getElementById("errorBanner"),
        positionChips: document.getElementById("positionChips"),
        scoringChips: document.getElementById("scoringChips"),
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
    }

    // ── rankings ────────────────────────────────────────────────────────

    async function loadRankings() {
        els.rankBody.innerHTML = "";
        els.rankBody.appendChild(rowMessage("Loading rankings…"));
        const params = new URLSearchParams({
            position: F.positionQuery(state.position),
            scoring: state.scoring,
            limit: "100",
        });
        if (state.season != null) params.set("season", state.season);
        if (state.week != null) params.set("week", state.week); // 0 = season-long

        try {
            const data = await fetchJson(`${API_BASE}/rankings?${params.toString()}`);
            renderRankings(data);
        } catch (err) {
            els.rankBody.innerHTML = "";
            els.rankBody.appendChild(rowMessage("Rankings unavailable right now."));
            showError(err.message);
        }
    }

    function rowMessage(text) {
        const tr = el("tr");
        const td = el("td", "table-empty", text);
        td.colSpan = 5;
        tr.appendChild(td);
        return tr;
    }

    function renderRankings(data) {
        els.rankingsSource.textContent = data.source ? `source: ${data.source}` : "";
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
            tr.appendChild(el("td", "col-player", row.name || "—"));
            tr.appendChild(el("td", "col-pos", F.positionLabel(row.position) || "—"));
            tr.appendChild(el("td", "col-team", row.team || "—"));
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
            const data = await fetchJson(`${API_BASE}/games`);
            const withLines = (data.games || []).filter((g) => g.lines);
            if (withLines.length === 0) return; // section stays hidden (e.g. offseason)
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
            .replace(/\bwinner\b/, "winner")
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

    // ── player drawer ───────────────────────────────────────────────────

    async function openPlayer(playerId) {
        if (!playerId) return;
        state.drawerPlayerId = playerId;
        els.drawer.hidden = false;
        document.body.classList.add("drawer-open");
        els.drawerName.textContent = "—";
        els.drawerSub.textContent = "";
        els.drawerBody.innerHTML = '<p class="drawer__loading">Loading…</p>';
        els.drawerClose.focus();
        window.pgAnalytics?.track?.("app_event", "fantasy_player_view", { player_id: playerId });

        try {
            const player = await fetchJson(`${API_BASE}/players/${encodeURIComponent(playerId)}`);
            if (state.drawerPlayerId !== playerId) return;
            renderPlayer(player);
        } catch (err) {
            if (state.drawerPlayerId !== playerId) return;
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
        if (player.injury_status) bits.push(player.injury_status);
        els.drawerSub.textContent = bits.join(" · ");

        els.drawerBody.innerHTML = "";

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
            els.drawerBody.appendChild(card);
        }

        const spark = buildSparkline(player.projection_history);
        if (spark) {
            const card = el("div", "drawer-card");
            card.appendChild(el("h3", "drawer-card__title", "Projection movement"));
            card.appendChild(spark);
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

        if (!player.projection && games.length === 0 && !spark && props.length === 0) {
            els.drawerBody.appendChild(el("p", "drawer__loading", "No projection or game data collected yet."));
        }
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

    function closeDrawer() {
        els.drawer.hidden = true;
        document.body.classList.remove("drawer-open");
    }

    // ── header / state ──────────────────────────────────────────────────

    function renderHeader(data) {
        state.season = data.default_season != null ? data.default_season : data.season;
        state.week = data.default_week != null ? data.default_week : data.week;
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

    async function init() {
        buildChips();
        els.drawerClose.addEventListener("click", closeDrawer);
        els.drawerBackdrop.addEventListener("click", closeDrawer);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !els.drawer.hidden) closeDrawer();
        });

        try {
            const stateData = await fetchJson(`${API_BASE}/state`);
            renderHeader(stateData);
        } catch (err) {
            showError("Could not load the current NFL week.");
        }

        await Promise.all([
            loadRankings(),
            loadDashboard(),
            loadGames(),
            loadProps(),
            loadFutures(),
        ]);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
