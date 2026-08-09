// League hub controller. Pure formatting lives in format.js (LeagueFormat);
// this file only fetches, holds view state, and renders.
(function () {
    "use strict";

    const F = window.LeagueFormat;
    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/league`;

    const state = {
        season: null,
        mode: null,
        week: null,
        scoreWeek: null,
        algorithm: "composite",
        teamId: null,
        overview: null,
        // Bumped on every context change. A response that resolves with a
        // stale generation is discarded — switching season fires several
        // requests at once, so out-of-order replies are the normal case.
        generation: 0,
    };

    const byId = (id) => document.getElementById(id);
    const els = {
        leagueName: byId("leagueName"),
        leagueLede: byId("leagueLede"),
        modeLabel: byId("modeLabel"),
        seasonValue: byId("seasonValue"),
        freshnessValue: byId("freshnessValue"),
        errorBanner: byId("errorBanner"),
        modeBanner: byId("modeBanner"),
        signedOutView: byId("signedOutView"),
        emptyView: byId("emptyView"),
        leagueView: byId("leagueView"),
        signInLink: byId("signInLink"),
        seasonChips: byId("seasonChips"),
        leagueSections: byId("leagueSections"),
        standings: byId("standings"),
        standingsNote: byId("standingsNote"),
        algorithmChips: byId("algorithmChips"),
        powerWeek: byId("powerWeek"),
        powerRankings: byId("powerRankings"),
        powerNote: byId("powerNote"),
        scoreboardWeek: byId("scoreboardWeek"),
        scoreboard: byId("scoreboard"),
        teamsGrid: byId("teamsGrid"),
        teamView: byId("teamView"),
        teamBack: byId("teamBack"),
        teamLogo: byId("teamLogo"),
        teamName: byId("teamName"),
        teamOwner: byId("teamOwner"),
        teamStats: byId("teamStats"),
        teamPower: byId("teamPower"),
        teamOverviewBody: byId("teamOverviewBody"),
        teamOverviewMeta: byId("teamOverviewMeta"),
        teamOverviewRefresh: byId("teamOverviewRefresh"),
        teamResults: byId("teamResults"),
        teamRoster: byId("teamRoster"),
        rosterNote: byId("rosterNote"),
    };

    class ForbiddenError extends Error {}

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, { credentials: "include", ...options });
        if (response.status === 403) {
            throw new ForbiddenError("Sign in to view the league hub.");
        }
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.detail || `Request failed with ${response.status}`);
        }
        return response.json();
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function appendInline(parent, text) {
        String(text).split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
            if (/^\*\*[^*]+\*\*$/.test(part)) {
                parent.appendChild(el("strong", null, part.slice(2, -2)));
            } else if (part) {
                parent.appendChild(document.createTextNode(part));
            }
        });
    }

    // Team overviews can come from the model, so render only the small safe
    // Markdown subset the chat panel supports. Raw HTML is always text.
    function renderMarkdown(container, text) {
        container.replaceChildren();
        String(text || "").split(/\n{2,}/).forEach((block) => {
            const lines = block.split("\n");
            const isList = lines.every((line) => line.trim().startsWith("- ") || !line.trim());
            const node = el(isList ? "ul" : "p", isList ? "team-overview__list" : null);
            if (isList) {
                lines.filter((line) => line.trim().startsWith("- ")).forEach((line) => {
                    const item = el("li");
                    appendInline(item, line.trim().slice(2));
                    node.appendChild(item);
                });
            } else {
                lines.forEach((line, index) => {
                    if (index) node.appendChild(document.createElement("br"));
                    appendInline(node, line);
                });
            }
            container.appendChild(node);
        });
    }

    function setView(name) {
        els.signedOutView.hidden = name !== "signedOut";
        els.emptyView.hidden = name !== "empty";
        els.leagueView.hidden = name !== "league";
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = false;
    }

    function clearError() {
        els.errorBanner.hidden = true;
    }

    function handleFailure(error) {
        if (error instanceof ForbiddenError) {
            // Preserve where they were headed so login can bounce them back.
            const next = `${window.location.pathname}${window.location.search}`;
            els.signInLink.href = `/login/?next=${encodeURIComponent(next)}`;
            setView("signedOut");
            return true;
        }
        showError(error.message || "Something went wrong.");
        return false;
    }

    // ── url state ───────────────────────────────────────────────────────

    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        const season = parseInt(params.get("season"), 10);
        const week = parseInt(params.get("week"), 10);
        const team = parseInt(params.get("team"), 10);
        if (Number.isFinite(season)) state.season = season;
        if (Number.isFinite(week)) state.week = week;
        if (Number.isFinite(team)) state.teamId = team;
        const algo = params.get("algo");
        if (algo) state.algorithm = algo;
    }

    function writeUrlState(replace) {
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        if (state.teamId) {
            params.set("team", state.teamId);
        } else {
            if (state.week) params.set("week", state.week);
            if (state.algorithm && state.algorithm !== "composite") {
                params.set("algo", state.algorithm);
            }
        }
        const query = params.toString();
        const url = query ? `?${query}` : window.location.pathname;
        if (replace) {
            window.history.replaceState({}, "", url);
        } else {
            window.history.pushState({}, "", url);
        }
    }

    // ── rendering ───────────────────────────────────────────────────────

    function renderSeasonChips(seasons) {
        els.seasonChips.replaceChildren();
        seasons.forEach((season) => {
            const chip = el("button", "chip", F.seasonLabel(season.season, season.status));
            chip.type = "button";
            if (!season.available) {
                chip.disabled = true;
                chip.classList.add("chip--disabled");
                chip.title = "This season is private in ESPN's league settings.";
            } else {
                chip.addEventListener("click", () => selectSeason(season.season));
            }
            if (season.season === state.season) {
                chip.classList.add("chip--active");
                chip.setAttribute("aria-current", "true");
            }
            els.seasonChips.appendChild(chip);
        });
    }

    function renderHeader(overview) {
        els.leagueName.textContent = overview.name || "League Hub";
        els.seasonValue.textContent = overview.season || "—";
        els.modeLabel.textContent = F.modeLabel(overview.mode) || "Season";
        els.freshnessValue.textContent = F.formatAsOf(overview.freshness.league_sync);

        if (overview.mode === "preseason") {
            els.modeBanner.textContent =
                "The season hasn't kicked off yet — rosters are drafted, but no games have been played. Standings and power rankings appear after week 1.";
            els.modeBanner.hidden = false;
        } else {
            els.modeBanner.hidden = true;
        }
    }

    function teamCell(team) {
        const wrap = el("div", "team-cell");
        if (team.logo_url) {
            const logo = el("img", "team-cell__logo");
            logo.src = team.logo_url;
            logo.alt = "";
            logo.loading = "lazy";
            wrap.appendChild(logo);
        }
        const text = el("div", "team-cell__text");
        const link = el("button", "team-cell__name", team.name || "—");
        link.type = "button";
        link.addEventListener("click", () => selectTeam(team.espn_team_id));
        text.appendChild(link);
        if (team.owner_name) text.appendChild(el("span", "team-cell__owner", team.owner_name));
        wrap.appendChild(text);
        return wrap;
    }

    function renderStandings(payload, overview) {
        els.standings.replaceChildren();
        const groups = F.groupByDivision(payload.teams, overview.divisions);
        const showDivisions = groups.length > 1;

        groups.forEach((group) => {
            if (showDivisions) {
                els.standings.appendChild(el("h3", "standings__division", group.division_name));
            }
            const table = el("table", "rank-table");
            const head = el("thead");
            const headRow = el("tr");
            ["", "Team", "W-L", "PCT", "PF", "PA", "DIFF", "PPG", "Streak"].forEach((label) => {
                headRow.appendChild(el("th", null, label));
            });
            head.appendChild(headRow);
            table.appendChild(head);

            const body = el("tbody");
            group.teams.forEach((team) => {
                const row = el("tr");
                row.appendChild(
                    el("td", "cell-seed", F.seedLabel(team.playoff_seed, overview.playoff_team_count))
                );
                const nameCell = el("td");
                nameCell.appendChild(teamCell(team));
                row.appendChild(nameCell);
                row.appendChild(el("td", null, F.recordLabel(team.wins, team.losses, team.ties)));
                row.appendChild(el("td", null, F.formatPct(F.winPct(team.wins, team.losses, team.ties))));
                row.appendChild(el("td", null, F.formatPoints(team.points_for)));
                row.appendChild(el("td", null, F.formatPoints(team.points_against)));
                row.appendChild(el("td", null, F.formatSigned(team.point_differential)));
                row.appendChild(
                    el("td", null, F.formatPoints(F.pointsPerGame(team.points_for, team.games_played)))
                );
                row.appendChild(el("td", null, F.streakLabel(team.streak_length, team.streak_type)));
                body.appendChild(row);
            });
            table.appendChild(body);
            els.standings.appendChild(table);
        });

        els.standingsNote.textContent = payload.teams.length
            ? `${payload.teams.length} teams`
            : "";
    }

    function renderAlgorithmChips(algorithms) {
        els.algorithmChips.replaceChildren();
        algorithms.forEach((algorithm) => {
            const chip = el("button", "chip", F.algorithmLabel(algorithm));
            chip.type = "button";
            if (algorithm === state.algorithm) {
                chip.classList.add("chip--active");
                chip.setAttribute("aria-current", "true");
            }
            chip.addEventListener("click", () => {
                state.algorithm = algorithm;
                writeUrlState(true);
                loadPowerRankings();
            });
            els.algorithmChips.appendChild(chip);
        });
    }

    function fillWeekSelect(select, weeks, selected) {
        select.replaceChildren();
        weeks.forEach((week) => {
            const option = el("option", null, `Week ${week}`);
            option.value = week;
            if (week === selected) option.selected = true;
            select.appendChild(option);
        });
        select.disabled = weeks.length === 0;
    }

    function renderPowerRankings(payload) {
        els.powerRankings.replaceChildren();
        if (!payload.rankings.length) {
            els.powerRankings.appendChild(
                el("p", "empty-note", "No completed games yet this season.")
            );
            els.powerNote.textContent = "";
            return;
        }

        payload.rankings.forEach((team) => {
            const row = el("article", "power-row");
            row.appendChild(el("span", "power-row__rank", String(team.rank)));

            const movement = F.rankMovement(team.rank_delta);
            const move = el("span", `power-row__move power-row__move--${movement.direction}`, movement.label);
            row.appendChild(move);

            const main = el("div", "power-row__main");
            const nameButton = el("button", "power-row__name", team.name || "—");
            nameButton.type = "button";
            nameButton.addEventListener("click", () => selectTeam(team.espn_team_id));
            main.appendChild(nameButton);
            main.appendChild(
                el(
                    "span",
                    "power-row__meta",
                    `${F.recordLabel(team.wins, team.losses, team.ties)} · ${F.formatPoints(team.points_for)} PF`
                )
            );
            row.appendChild(main);

            const track = el("div", "power-bar");
            const fill = el("div", "power-bar__fill");
            fill.style.width = `${F.powerBar(team.score)}%`;
            track.appendChild(fill);
            row.appendChild(track);

            const ranks = (team.history || []).map((point) => point.rank);
            const path = F.sparkline(ranks, 72, 22, 3);
            if (path) {
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("class", "spark");
                svg.setAttribute("viewBox", "0 0 72 22");
                svg.setAttribute("aria-hidden", "true");
                const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
                line.setAttribute("d", path);
                svg.appendChild(line);
                row.appendChild(svg);
            }

            els.powerRankings.appendChild(row);
        });

        els.powerNote.textContent = `Through week ${payload.week}`;
    }

    function renderScoreboard(payload) {
        els.scoreboard.replaceChildren();
        if (!payload.matchups.length) {
            els.scoreboard.appendChild(el("p", "empty-note", "No matchups for this week."));
            return;
        }

        payload.matchups.forEach((matchup) => {
            const card = el("article", "matchup");
            if (matchup.playoff_tier && matchup.playoff_tier !== "NONE") {
                card.appendChild(
                    el("span", "matchup__tier", matchup.playoff_tier.replace(/_/g, " ").toLowerCase())
                );
            }

            if (matchup.is_bye) {
                card.classList.add("matchup--bye");
                card.appendChild(el("p", "matchup__bye", `${matchup.home.name || "—"} — bye`));
                els.scoreboard.appendChild(card);
                return;
            }

            [matchup.home, matchup.away].forEach((side, index) => {
                if (!side) return;
                const isWinner =
                    matchup.is_complete &&
                    ((index === 0 && matchup.winner === "HOME") ||
                        (index === 1 && matchup.winner === "AWAY"));
                const line = el("div", `matchup__side${isWinner ? " matchup__side--win" : ""}`);
                const nameButton = el("button", "matchup__name", side.name || "—");
                nameButton.type = "button";
                nameButton.addEventListener("click", () => selectTeam(side.espn_team_id));
                line.appendChild(nameButton);
                line.appendChild(el("span", "matchup__score", F.formatPoints(side.points)));
                card.appendChild(line);
            });

            if (!matchup.is_complete) {
                card.appendChild(el("span", "matchup__pending", "Not played"));
            }
            els.scoreboard.appendChild(card);
        });
    }

    function renderTeamsGrid(payload) {
        els.teamsGrid.replaceChildren();
        payload.teams.forEach((team) => {
            const card = el("button", "team-card");
            card.type = "button";
            card.addEventListener("click", () => selectTeam(team.espn_team_id));
            if (team.logo_url) {
                const logo = el("img", "team-card__logo");
                logo.src = team.logo_url;
                logo.alt = "";
                logo.loading = "lazy";
                card.appendChild(logo);
            }
            card.appendChild(el("span", "team-card__name", team.name || "—"));
            if (team.owner_name) card.appendChild(el("span", "team-card__owner", team.owner_name));
            card.appendChild(
                el("span", "team-card__record", F.recordLabel(team.wins, team.losses, team.ties))
            );
            els.teamsGrid.appendChild(card);
        });
    }

    function statItem(label, value) {
        const wrap = document.createDocumentFragment();
        wrap.appendChild(el("dt", null, label));
        wrap.appendChild(el("dd", null, value));
        return wrap;
    }

    function renderTeamDetail(detail) {
        els.teamName.textContent = detail.name || "—";
        els.teamOwner.textContent = detail.owner_name || "";
        if (detail.logo_url) {
            els.teamLogo.src = detail.logo_url;
            els.teamLogo.hidden = false;
        } else {
            els.teamLogo.hidden = true;
        }

        els.teamStats.replaceChildren();
        els.teamStats.appendChild(
            statItem("Record", F.recordLabel(detail.wins, detail.losses, detail.ties))
        );
        els.teamStats.appendChild(statItem("Points for", F.formatPoints(detail.points_for)));
        els.teamStats.appendChild(statItem("Points against", F.formatPoints(detail.points_against)));
        els.teamStats.appendChild(
            statItem("Per game", F.formatPoints(F.pointsPerGame(detail.points_for, detail.games_played)))
        );

        els.teamPower.replaceChildren();
        const ranks = (detail.power_history || []).map((point) => point.rank);
        const path = F.sparkline(ranks, 112, 34, 3);
        if (path) {
            const latest = detail.power_history[detail.power_history.length - 1];
            els.teamPower.appendChild(el("span", "team-power__label", `Power #${latest.rank}`));
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 112 34");
            svg.setAttribute("aria-label", "Power-rank history");
            const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
            line.setAttribute("d", path);
            svg.appendChild(line);
            els.teamPower.appendChild(svg);
        }

        els.teamResults.replaceChildren();
        detail.results.forEach((result) => {
            const item = el("li", "result");
            item.appendChild(el("span", "result__week", `Wk ${result.week}`));
            if (result.is_bye) {
                item.appendChild(el("span", "result__outcome result__outcome--bye", "BYE"));
                els.teamResults.appendChild(item);
                return;
            }
            // Modifier comes from a fixed set, never from the display text —
            // the pending state renders an em-dash, which is not a class name.
            const outcome = result.outcome;
            const modifier = { W: "w", L: "l", T: "t" }[outcome] || "pending";
            item.appendChild(
                el("span", `result__outcome result__outcome--${modifier}`, outcome || "—")
            );
            item.appendChild(
                el(
                    "span",
                    "result__score",
                    `${F.formatPoints(result.points)}–${F.formatPoints(result.opponent_points)}`
                )
            );
            item.appendChild(
                el("span", "result__opponent", result.opponent ? result.opponent.name || "—" : "—")
            );
            els.teamResults.appendChild(item);
        });
    }

    function rosterGroup(title, entries) {
        const section = el("div", "roster-group");
        section.appendChild(el("h4", "roster-group__title", title));
        const list = el("ul", "roster");
        entries.forEach((entry) => {
            const item = el("li", `roster__row${entry.matched ? "" : " roster__row--unmatched"}`);
            item.appendChild(el("span", "roster__slot", entry.lineup_slot || "—"));
            const main = el("div", "roster__main");
            main.appendChild(el("span", "roster__name", entry.name || "—"));
            const meta = [entry.position, entry.pro_team].filter(Boolean).join(" · ");
            main.appendChild(el("span", "roster__meta", meta));
            if (entry.matched) {
                const detail = [];
                if (entry.projection && entry.projection.pts_ppr != null) {
                    detail.push(`Proj ${F.formatPoints(entry.projection.pts_ppr)}`);
                }
                if (entry.ranking && entry.ranking.rank != null) {
                    const position = entry.ranking.position === "DEF" ? "DST" : entry.ranking.position;
                    detail.push(`${position || "PPR"} #${entry.ranking.rank}`);
                }
                const actual = (entry.recent_actuals || [])[0];
                if (actual && actual.fantasy_points_ppr != null) {
                    detail.push(`Last ${F.formatPoints(actual.fantasy_points_ppr)}`);
                }
                if (detail.length) main.appendChild(el("span", "roster__data", detail.join(" · ")));
                const prop = (entry.props || [])[0];
                if (prop) {
                    const point = prop.point == null ? "" : ` ${prop.point}`;
                    main.appendChild(el("span", "roster__prop", `${prop.label}${point}`));
                }
            }
            item.appendChild(main);
            const badge = F.injuryBadge(entry.injury_status);
            if (badge) item.appendChild(el("span", "roster__injury", badge));
            list.appendChild(item);
        });
        section.appendChild(list);
        return section;
    }

    function renderRoster(payload) {
        els.teamRoster.replaceChildren();
        if (!payload.entries.length) {
            els.teamRoster.appendChild(el("p", "empty-note", "No roster snapshot yet."));
            els.rosterNote.textContent = "";
            return;
        }
        const groups = F.splitRoster(payload.entries);
        if (groups.starters.length) {
            els.teamRoster.appendChild(rosterGroup("Starters", groups.starters));
        }
        if (groups.bench.length) els.teamRoster.appendChild(rosterGroup("Bench", groups.bench));
        if (groups.ir.length) els.teamRoster.appendChild(rosterGroup("Injured reserve", groups.ir));
        const notes = [F.formatAsOf(payload.as_of)];
        if (payload.player_data && payload.player_data.season) {
            const week = payload.player_data.week === 0
                ? "season-long"
                : `week ${payload.player_data.week}`;
            notes.push(`${payload.player_data.season} ${week} player data`);
        }
        els.rosterNote.textContent = notes.filter(Boolean).join(" · ");
    }

    function renderTeamOverview(payload) {
        // "missing" means nothing has been written for this team/week yet.
        // Generating costs a model call, so it stays an explicit choice
        // rather than something a page view triggers.
        if (payload.status === "missing") {
            els.teamOverviewBody.replaceChildren(
                el("p", "empty-note", "No overview written for this team yet.")
            );
            els.teamOverviewMeta.textContent = "";
            els.teamOverviewRefresh.textContent = "Write overview";
            return;
        }

        renderMarkdown(els.teamOverviewBody, payload.overview_md || "No overview available.");
        const source = payload.source === "model" ? "Model summary" : "Local summary";
        const parts = [source, `Week ${payload.week}`];
        if (payload.status === "stale") {
            parts.push("team data has changed");
        } else if (!payload.cache_hit) {
            parts.push("updated");
        }
        els.teamOverviewMeta.textContent = parts.join(" · ");
        els.teamOverviewRefresh.textContent =
            payload.status === "stale" ? "Refresh overview" : "Check for updates";
    }

    // ── loading ─────────────────────────────────────────────────────────

    function stale(generation) {
        return generation !== state.generation;
    }

    async function loadPowerRankings() {
        const generation = state.generation;
        const params = new URLSearchParams({ algorithm: state.algorithm });
        if (state.season) params.set("season", state.season);
        if (state.week) params.set("week", state.week);
        try {
            const payload = await fetchJson(`${API_BASE}/power-rankings?${params}`);
            if (stale(generation)) return;
            state.week = payload.week;
            fillWeekSelect(els.powerWeek, payload.available_weeks, payload.week);
            renderAlgorithmChips(state.overview.algorithms);
            renderPowerRankings(payload);
        } catch (error) {
            if (!stale(generation)) handleFailure(error);
        }
    }

    async function loadScoreboard() {
        const generation = state.generation;
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        if (state.scoreWeek) params.set("week", state.scoreWeek);
        try {
            const payload = await fetchJson(`${API_BASE}/scoreboard?${params}`);
            if (stale(generation)) return;
            state.scoreWeek = payload.week;
            fillWeekSelect(els.scoreboardWeek, payload.available_weeks, payload.week);
            renderScoreboard(payload);
        } catch (error) {
            if (!stale(generation)) handleFailure(error);
        }
    }

    async function loadTeam() {
        const generation = state.generation;
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        els.teamOverviewBody.replaceChildren();
        els.teamOverviewMeta.textContent = "";
        try {
            const [detail, roster] = await Promise.all([
                fetchJson(`${API_BASE}/teams/${state.teamId}?${params}`),
                fetchJson(`${API_BASE}/teams/${state.teamId}/roster?${params}`),
            ]);
            if (stale(generation)) return;
            renderTeamDetail(detail);
            renderRoster(roster);
            loadTeamOverview(false);
        } catch (error) {
            if (!stale(generation)) handleFailure(error);
        }
    }

    // write=false is a plain read and never generates; write=true POSTs and
    // may spend a model call, so it only ever runs from an explicit click.
    async function loadTeamOverview(write) {
        const generation = state.generation;
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        els.teamOverviewRefresh.disabled = true;
        els.teamOverviewMeta.textContent = write ? "Writing…" : "Loading…";
        try {
            const payload = await fetchJson(`${API_BASE}/teams/${state.teamId}/overview?${params}`, {
                method: write ? "POST" : "GET",
            });
            if (stale(generation)) return;
            renderTeamOverview(payload);
        } catch (error) {
            if (!stale(generation)) {
                els.teamOverviewMeta.textContent = "";
                els.teamOverviewBody.replaceChildren(
                    el("p", "empty-note", error.message || "Overview unavailable.")
                );
            }
        } finally {
            if (!stale(generation)) els.teamOverviewRefresh.disabled = false;
        }
    }

    function applyRoute() {
        const showingTeam = Boolean(state.teamId);
        els.teamView.hidden = !showingTeam;
        els.leagueSections.hidden = showingTeam;
        if (showingTeam) loadTeam();
    }

    async function loadSeason() {
        const generation = ++state.generation;
        clearError();
        try {
            const params = state.season ? `?season=${state.season}` : "";
            const overview = await fetchJson(`${API_BASE}/overview${params}`);
            if (stale(generation)) return;

            if (!overview.season) {
                setView("empty");
                return;
            }

            state.overview = overview;
            state.season = overview.season;
            state.mode = overview.mode;
            setView("league");
            renderHeader(overview);
            renderSeasonChips(overview.seasons);
            writeUrlState(true);

            const standings = await fetchJson(`${API_BASE}/standings?season=${state.season}`);
            if (stale(generation)) return;
            renderStandings(standings, overview);
            renderTeamsGrid(standings);

            // In the preseason the standings are all zeroes and the schedule
            // is unplayed, so lead with the teams and their drafted rosters
            // instead of boards that have nothing in them yet.
            els.leagueSections.classList.toggle("is-preseason", overview.mode === "preseason");

            await Promise.all([loadPowerRankings(), loadScoreboard()]);
            applyRoute();
        } catch (error) {
            if (!stale(generation)) handleFailure(error);
        }
    }

    // ── navigation ──────────────────────────────────────────────────────

    function selectSeason(season) {
        if (season === state.season) return;
        state.season = season;
        state.week = null;
        state.scoreWeek = null;
        state.teamId = null;
        writeUrlState(false);
        loadSeason();
    }

    function selectTeam(teamId) {
        state.teamId = teamId;
        writeUrlState(false);
        state.generation += 1;
        applyRoute();
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function clearTeam() {
        state.teamId = null;
        writeUrlState(false);
        state.generation += 1;
        applyRoute();
    }

    function bindEvents() {
        els.teamBack.addEventListener("click", clearTeam);
        els.teamOverviewRefresh.addEventListener("click", () => loadTeamOverview(true));

        els.powerWeek.addEventListener("change", (event) => {
            state.week = parseInt(event.target.value, 10);
            writeUrlState(true);
            loadPowerRankings();
        });

        els.scoreboardWeek.addEventListener("change", (event) => {
            state.scoreWeek = parseInt(event.target.value, 10);
            loadScoreboard();
        });

        window.addEventListener("popstate", () => {
            state.season = null;
            state.week = null;
            state.teamId = null;
            state.algorithm = "composite";
            readUrlState();
            loadSeason();
        });
    }

    function init() {
        readUrlState();
        bindEvents();
        loadSeason();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
