// League hub controller. Pure formatting lives in format.js (LeagueFormat);
// this file only fetches, holds view state, and renders.
(function () {
    "use strict";

    const F = window.LeagueFormat;
    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/league`;
    const LEAGUE_SCORING = "half";
    const LEAGUE_SCORING_LABEL = "Half PPR";
    const LEAGUE_PROJECTION_FIELD = "pts_half_ppr";
    const LEAGUE_ACTUAL_FIELD = "fantasy_points_half";

    const state = {
        season: null,
        mode: null,
        week: null,
        scoreWeek: null,
        algorithm: "composite",
        // Which measure the ledger's switchable column is showing. On a
        // phone this is the only column, so it is worth keeping in the URL.
        column: "record",
        teamId: null,
        overview: null,
        ledger: null,
        ledgerRequest: 0,
        myTeamId: null,
        // Bumped on every context change. A response that resolves with a
        // stale generation is discarded — switching season fires several
        // requests at once, so out-of-order replies are the normal case.
        generation: 0,
    };

    const byId = (id) => document.getElementById(id);
    const els = {
        leagueName: byId("leagueName"),
        leagueSub: byId("leagueSub"),
        mastheadEyebrow: byId("mastheadEyebrow"),
        modeBadge: byId("modeBadge"),
        teamBadge: byId("teamBadge"),
        modeLabel: byId("modeLabel"),
        seasonValue: byId("seasonValue"),
        weekValue: byId("weekValue"),
        freshnessValue: byId("freshnessValue"),
        errorBanner: byId("errorBanner"),
        modeBanner: byId("modeBanner"),
        signedOutView: byId("signedOutView"),
        emptyView: byId("emptyView"),
        leagueView: byId("leagueView"),
        signInLink: byId("signInLink"),
        seasonChips: byId("seasonChips"),
        leagueSections: byId("leagueSections"),
        ledger: byId("ledger"),
        ledgerColumns: byId("ledgerColumns"),
        ledgerNote: byId("ledgerNote"),
        ledgerFootnote: byId("ledgerFootnote"),
        powerAlgorithm: byId("powerAlgorithm"),
        chartsBoard: document.querySelector('[data-board="charts"]'),
        charts: byId("charts"),
        chartsNote: byId("chartsNote"),
        scoreboardWeek: byId("scoreboardWeek"),
        scoreboard: byId("scoreboard"),
        teamsGrid: byId("teamsGrid"),
        freeAgents: byId("freeAgents"),
        freeAgentsNote: byId("freeAgentsNote"),
        myTeamStrip: byId("myTeamStrip"),
        myTeamName: byId("myTeamName"),
        myTeamMeta: byId("myTeamMeta"),
        myTeamAdvice: byId("myTeamAdvice"),
        myTeamMoves: byId("myTeamMoves"),
        teamView: byId("teamView"),
        teamBack: byId("teamBack"),
        teamLede: byId("teamLede"),
        teamColophon: byId("teamColophon"),
        roomsLede: byId("roomsLede"),
        teamOverviewMeta: byId("teamOverviewMeta"),
        teamOverviewRefresh: byId("teamOverviewRefresh"),
        teamResults: byId("teamResults"),
        teamRoster: byId("teamRoster"),
        rosterNote: byId("rosterNote"),
        lineupCard: byId("lineupCard"),
        lineupMeta: byId("lineupMeta"),
        lineupTotals: byId("lineupTotals"),
        lineupChanges: byId("lineupChanges"),
        lineupNote: byId("lineupNote"),
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
            const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
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
        const column = params.get("col");
        if (column && F.LEDGER_COLUMNS.some((entry) => entry.key === column)) {
            state.column = column;
        }
    }

    function writeUrlState(replace, hash = "") {
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        if (state.teamId) {
            params.set("team", state.teamId);
        } else {
            if (state.week) params.set("week", state.week);
            if (state.algorithm && state.algorithm !== "composite") {
                params.set("algo", state.algorithm);
            }
            if (state.column && state.column !== "record") {
                params.set("col", state.column);
            }
        }
        const query = params.toString();
        const suffix = hash.startsWith("#") ? hash : "";
        const url = `${query ? `?${query}` : window.location.pathname}${suffix}`;
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
        els.weekValue.textContent = overview.latest_week
            ? `Week ${overview.latest_week}`
            : "Preseason";
        els.freshnessValue.textContent = F.formatAsOf(overview.freshness.league_sync);

        if (overview.mode === "preseason") {
            els.modeBanner.textContent =
                "The season hasn't kicked off yet — rosters are drafted, but no games have been played. Every column in the table fills in from week 1.";
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

    // ── the ledger ──────────────────────────────────────────────────────

    // Scales are computed once per payload rather than per row: every chart
    // in a column has to share an axis or the bars are not comparable, which
    // is the whole point of putting them in one table.
    function ledgerScales(teams) {
        return {
            luckMax: F.maxAbs(teams.map((team) => team.luck)),
            efficiency: F.niceAxis(
                teams.map((team) => team.lineup && team.lineup.efficiency),
                0.02
            ),
            scoring: F.niceAxis(
                teams.reduce((values, team) => {
                    const scoring = team.scoring || {};
                    return values.concat([scoring.low, scoring.high]);
                }, []),
                10
            ),
        };
    }

    function sparkSvg(ranks, width, height, pad) {
        const path = F.sparkline(ranks, width, height, pad);
        if (!path) return null;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "spark");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("aria-hidden", "true");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line.setAttribute("d", path);
        svg.appendChild(line);
        return svg;
    }

    function meterEl(percent) {
        const track = el("div", "meter");
        const fill = el("div", "meter__fill");
        fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
        track.appendChild(fill);
        return track;
    }

    // The chart that rides in the row. Polarity always reads from which side
    // of the zero rule a bar sits on, and a value the measure could not be
    // computed for draws nothing rather than a bar of length zero — those
    // look identical and mean opposite things.
    function ledgerChart(team, columnKey, scales) {
        const column = F.ledgerColumn(columnKey);
        if (column.chart === "diverging") {
            const bar = F.divergingBar(team.luck, scales.luckMax);
            const track = el("div", "dv");
            track.appendChild(el("div", "dv__zero"));
            if (bar.side !== "zero") {
                const fill = el("div", `dv__bar dv__bar--${bar.side}`);
                fill.style.width = `${bar.width}%`;
                track.appendChild(fill);
            }
            return track;
        }
        if (column.chart === "dot") {
            const axis = scales.efficiency;
            const value = team.lineup && team.lineup.efficiency;
            const position = axis ? F.dotPosition(value, axis.min, axis.max) : null;
            if (position === null) return null;
            const track = el("div", "dot");
            track.appendChild(el("div", "dot__line"));
            const point = el("div", "dot__pt");
            point.style.left = `${position}%`;
            track.appendChild(point);
            return track;
        }
        if (column.chart === "range") {
            const axis = scales.scoring;
            const scoring = team.scoring || {};
            const band = axis ? F.rangeBand(scoring.low, scoring.high, axis.min, axis.max) : null;
            if (!band) return null;
            const track = el("div", "rng");
            const span = el("div", "rng__span");
            span.style.left = `${band.left}%`;
            span.style.width = `${band.width}%`;
            track.appendChild(span);
            const median = F.dotPosition(scoring.median, axis.min, axis.max);
            if (median !== null) {
                const point = el("div", "rng__med");
                point.style.left = `${median}%`;
                track.appendChild(point);
            }
            return track;
        }
        if (column.chart === "meter") {
            const value = F.ledgerValue(team, columnKey);
            if (value === null || value === undefined) return null;
            return meterEl(value * 100);
        }
        if (column.chart === "spark") {
            const ranks = ((team.power && team.power.history) || []).map((point) => point.rank);
            return sparkSvg(ranks, 72, 22, 3);
        }
        return null;
    }

    function renderColumnChips() {
        els.ledgerColumns.replaceChildren();
        F.LEDGER_COLUMNS.forEach((column) => {
            const chip = el("button", "chip", column.label);
            chip.type = "button";
            if (column.key === state.column) {
                chip.classList.add("chip--active");
                chip.setAttribute("aria-current", "true");
            }
            chip.addEventListener("click", () => selectColumn(column.key));
            els.ledgerColumns.appendChild(chip);
        });
    }

    function renderAlgorithmSelect(algorithms) {
        els.powerAlgorithm.replaceChildren();
        (algorithms || []).forEach((algorithm) => {
            const option = el("option", null, F.algorithmLabel(algorithm));
            option.value = algorithm;
            if (algorithm === state.algorithm) option.selected = true;
            els.powerAlgorithm.appendChild(option);
        });
        els.powerAlgorithm.disabled = !(algorithms || []).length;
    }

    function ledgerHeadRow() {
        const row = el("tr");
        row.appendChild(el("th", null, ""));
        row.appendChild(el("th", null, "Team"));
        [
            ["record", "W-L"],
            ["points_for", "PF"],
            ["all_play", "All-play"],
            ["expected", "xW"],
            ["luck", "Luck"],
            ["lineup", "Lineup"],
            ["scoring", "Range"],
            ["power", "Power"],
            ["odds", "Odds"],
            ["form", "Form"],
        ].forEach(([key, label]) => {
            const cell = el("th", null, label);
            cell.dataset.key = key;
            if (key === state.column) cell.classList.add("is-active");
            row.appendChild(cell);
        });
        return row;
    }

    function valueCell(key, text) {
        const cell = el("td", "ledger__cell", text);
        cell.dataset.key = key;
        if (key === state.column) cell.classList.add("is-active");
        return cell;
    }

    function renderLedger(payload) {
        const teams = payload.teams || [];
        els.ledger.replaceChildren();
        if (!teams.length) {
            els.ledger.appendChild(el("p", "empty-note", "No teams collected for this season."));
            els.ledgerNote.textContent = "";
            return;
        }

        const scales = ledgerScales(teams);
        const ordered = F.sortLedger(teams, state.column);
        const table = el("table", "rank-table ledger-table");
        const head = el("thead");
        head.appendChild(ledgerHeadRow());
        table.appendChild(head);

        const body = el("tbody");
        ordered.forEach((team, index) => {
            const row = el("tr");
            if (state.myTeamId && team.espn_team_id === state.myTeamId) {
                row.classList.add("ledger-row--mine");
            }
            row.appendChild(el("td", "cell-seed", String(index + 1)));

            const nameCell = el("td", "ledger__team");
            nameCell.dataset.key = "team";
            nameCell.appendChild(teamCell(team));
            // Mobile only: the chosen column's context and chart move into
            // the identity cell, because a phone shows one column at a time.
            nameCell.appendChild(el("span", "ledger__meta", F.ledgerMeta(team, state.column)));
            const chart = ledgerChart(team, state.column, scales);
            if (chart) {
                const holder = el("div", "ledger__chart");
                holder.appendChild(chart);
                nameCell.appendChild(holder);
            }
            row.appendChild(nameCell);

            row.appendChild(valueCell("record", F.ledgerText(team, "record")));
            row.appendChild(valueCell("points_for", F.ledgerText(team, "points_for")));
            row.appendChild(valueCell("all_play", F.ledgerText(team, "all_play")));
            row.appendChild(
                valueCell(
                    "expected",
                    team.expected_wins === null || team.expected_wins === undefined
                        ? "—"
                        : Number(team.expected_wins).toFixed(1)
                )
            );

            const luckCell = valueCell("luck", F.ledgerText(team, "luck"));
            if (team.luck > 0) luckCell.classList.add("cell-above");
            if (team.luck < 0) luckCell.classList.add("cell-below");
            row.appendChild(luckCell);

            row.appendChild(valueCell("lineup", F.ledgerText(team, "lineup")));
            row.appendChild(valueCell("scoring", F.ledgerText(team, "scoring")));

            const powerCell = valueCell("power", F.ledgerText(team, "power"));
            const movement = F.rankMovement(team.power && team.power.rank_delta);
            powerCell.appendChild(
                el("span", `ledger__move ledger__move--${movement.direction}`, movement.label)
            );
            row.appendChild(powerCell);

            const oddsCell = valueCell("odds", "");
            const odds = team.playoff && team.playoff.odds;
            if (odds === null || odds === undefined) {
                oddsCell.textContent = "—";
            } else {
                const wrap = el("div", "ledger__odds");
                wrap.appendChild(meterEl(odds * 100));
                wrap.appendChild(el("span", "ledger__odds-value", `${Math.round(odds * 100)}%`));
                oddsCell.appendChild(wrap);
            }
            row.appendChild(oddsCell);

            const formCell = valueCell("form", "");
            const spark = sparkSvg(
                ((team.power && team.power.history) || []).map((point) => point.rank),
                60,
                20,
                3
            );
            if (spark) formCell.appendChild(spark);
            row.appendChild(formCell);

            body.appendChild(row);
        });
        table.appendChild(body);
        els.ledger.appendChild(table);

        els.ledgerNote.textContent = payload.power_week
            ? `${teams.length} teams · power through week ${payload.power_week}`
            : `${teams.length} teams`;

        const rating = payload.manager_rating || {};
        const excluded = rating.excluded_slots || [];
        const exclusionNote = excluded.length
            ? ` ${excluded.join("/")} is excluded because its aggregate actuals are not in the weekly player feed.`
            : "";
        els.ledgerFootnote.textContent = rating.available
            ? `Lineup is the share of each week's best legal lineup a manager actually started, ` +
              `over ${rating.weeks.length} scored week${rating.weeks.length === 1 ? "" : "s"}. ` +
              `League average ${(rating.league_average * 100).toFixed(1)}%.` + exclusionNote
            : LINEUP_UNAVAILABLE[rating.reason] || "";
    }

    // Why a column is blank, in the reader's terms. A metric that silently
    // shows nothing is indistinguishable from one that is broken.
    const LINEUP_UNAVAILABLE = {
        no_lineup_settings:
            "Lineup efficiency needs this league's roster settings, which have not been collected yet.",
        no_roster_snapshots:
            "Lineup efficiency needs stored weekly rosters. None have been collected for this season.",
        no_actuals:
            "Lineup efficiency needs each player's actual points, which have not been collected for this season.",
        no_scorable_weeks:
            "No week has a full set of starter results yet, so lineup efficiency cannot be scored.",
    };

    // ── the season charts ───────────────────────────────────────────────

    function chartRow(team, valueText, chart, highlight) {
        const row = el("div", "chart-row");
        if (highlight) row.classList.add("chart-row--mine");
        const name = el("button", "chart-row__name", team.name || "—");
        name.type = "button";
        name.addEventListener("click", () => selectTeam(team.espn_team_id));
        row.appendChild(name);
        const holder = el("div", "chart-row__track");
        if (chart) holder.appendChild(chart);
        row.appendChild(holder);
        row.appendChild(el("span", "chart-row__value", valueText));
        return row;
    }

    function chartPanel(title, lede, rows, axis) {
        const panel = el("section", "chart");
        panel.appendChild(el("h3", "chart__title", title));
        panel.appendChild(el("p", "chart__lede", lede));
        rows.forEach((row) => panel.appendChild(row));
        if (axis) {
            const scale = el("div", "chart__axis");
            scale.appendChild(el("span", null, axis[0]));
            scale.appendChild(el("span", null, axis[1]));
            panel.appendChild(scale);
        }
        return panel;
    }

    function renderCharts(payload) {
        const teams = payload.teams || [];
        els.charts.replaceChildren();
        const scored = teams.filter((team) => (team.all_play || {}).games);
        if (!scored.length) {
            els.chartsBoard.hidden = true;
            return;
        }
        els.chartsBoard.hidden = false;
        const scales = ledgerScales(teams);

        els.charts.appendChild(
            chartPanel(
                "Luck index",
                "Wins minus expected wins. Left of the line is below, right is above.",
                F.sortLedger(scored, "luck").map((team) =>
                    chartRow(
                        team,
                        F.ledgerText(team, "luck"),
                        ledgerChart(team, "luck", scales),
                        team.espn_team_id === state.myTeamId
                    )
                )
            )
        );

        const rated = scored.filter(
            (team) => team.lineup && team.lineup.efficiency !== null && team.lineup.efficiency !== undefined
        );
        if (rated.length) {
            const axis = scales.efficiency;
            els.charts.appendChild(
                chartPanel(
                    "Manager rating",
                    "Points started as a share of the best legal lineup that week.",
                    F.sortLedger(rated, "lineup").map((team) =>
                        chartRow(
                            team,
                            F.ledgerText(team, "lineup"),
                            ledgerChart(team, "lineup", scales),
                            team.espn_team_id === state.myTeamId
                        )
                    ),
                    axis
                        ? [`${(axis.min * 100).toFixed(0)}%`, `${(axis.max * 100).toFixed(0)}%`]
                        : null
                )
            );
        }

        const axis = scales.scoring;
        els.charts.appendChild(
            chartPanel(
                "Weekly range",
                "Lowest to highest week, with the median. Long bars are boom-or-bust.",
                F.sortLedger(scored, "scoring").map((team) =>
                    chartRow(
                        team,
                        F.formatPoints(team.scoring && team.scoring.median),
                        ledgerChart(team, "scoring", scales),
                        team.espn_team_id === state.myTeamId
                    )
                ),
                axis ? [String(axis.min), String(axis.max)] : null
            )
        );

        els.chartsNote.textContent = `${scored.length} teams with completed games`;
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

    // ── the team as a document ──────────────────────────────────────────
    //
    // A team page is a detail view about one roster, but it is also the only
    // page on this site that gets a paragraph written about it every week.
    // So it opens on the writing, with the record set beside it the way a
    // colophon sits beside a lede, and the numbers that used to be a header
    // card become the facts under that lede.

    function fact(label, value, sub) {
        const wrap = el("div", "masthead__fact");
        wrap.appendChild(el("dt", null, label));
        const dd = el("dd", null, value);
        if (sub) dd.appendChild(el("small", null, sub));
        wrap.appendChild(dd);
        return wrap;
    }

    // The masthead carries whichever thing the page is currently about.
    // Two mastheads stacked would mean neither is the loudest.
    function renderTeamMasthead(detail) {
        const season = (detail && detail.season) || state.season || "";
        const played = (detail && detail.games_played) || 0;
        els.mastheadEyebrow.textContent = played
            ? `Team dossier · ${season} · through ${played} game${played === 1 ? "" : "s"}`
            : `Team dossier · ${season}`;
        els.leagueName.textContent = (detail && detail.name) || "—";
        els.leagueSub.textContent = (detail && detail.owner_name) || "";
        els.leagueSub.hidden = !els.leagueSub.textContent;

        els.teamBadge.replaceChildren();
        if (!detail) return;
        els.teamBadge.appendChild(
            fact("Record", F.recordLabel(detail.wins, detail.losses, detail.ties))
        );
        els.teamBadge.appendChild(fact("Points for", F.formatPoints(detail.points_for)));
        els.teamBadge.appendChild(fact("Against", F.formatPoints(detail.points_against)));
        els.teamBadge.appendChild(
            fact(
                "Per game",
                F.formatPoints(F.pointsPerGame(detail.points_for, detail.games_played))
            )
        );
    }

    // Which of the two fact lists the masthead is showing. Called before the
    // team payload lands so the league's numbers are never left standing
    // under a team's name.
    function setMastheadMode(showingTeam) {
        els.modeBadge.hidden = showingTeam;
        els.teamBadge.hidden = !showingTeam;
        els.freshnessValue.hidden = showingTeam;
        if (!showingTeam) {
            els.leagueSub.hidden = true;
            els.teamBadge.replaceChildren();
            if (state.overview) renderHeader(state.overview);
        }
    }

    // Where this team sits among the ten on one ledger column. The ledger is
    // already loaded — it is fetched before the route is applied and stays in
    // state — so none of these six facts costs a request.
    function ledgerRank(rows, key, teamId) {
        const ranked = F.sortLedger(rows, key).filter(
            (row) => F.ledgerValue(row, key) !== null
        );
        const index = ranked.findIndex((row) => row.espn_team_id === teamId);
        return index === -1 ? null : { rank: index + 1, of: ranked.length };
    }

    function rankSub(rows, key, teamId) {
        const placing = ledgerRank(rows, key, teamId);
        return placing ? `${F.ordinal(placing.rank)} of ${placing.of}` : "";
    }

    function renderColophon(detail) {
        els.teamColophon.replaceChildren();
        const rows = (state.ledger && state.ledger.teams) || [];
        const row = rows.find((entry) => entry.espn_team_id === detail.espn_team_id);
        const history = detail.power_history || [];
        const latest = history.length ? history[history.length - 1] : null;

        els.teamColophon.appendChild(
            fact(
                "Record",
                F.recordLabel(detail.wins, detail.losses, detail.ties),
                rankSub(rows, "record", detail.espn_team_id)
            )
        );
        els.teamColophon.appendChild(
            fact(
                "Power",
                latest ? `#${latest.rank}` : "—",
                history.length > 1 ? `from #${history[0].rank} in week ${history[0].week}` : ""
            )
        );
        els.teamColophon.appendChild(
            fact(
                "Points for",
                F.formatPoints(detail.points_for),
                `${F.formatPoints(F.pointsPerGame(detail.points_for, detail.games_played))} per game`
            )
        );
        els.teamColophon.appendChild(
            fact(
                "Against",
                F.formatPoints(detail.points_against),
                `${F.formatPoints(F.pointsPerGame(detail.points_against, detail.games_played))} per game`
            )
        );
        // The last two come off the ledger. When the ledger failed — it is
        // fetched alongside the team and its errors are deliberately quiet —
        // they print a dash rather than a plausible zero.
        els.teamColophon.appendChild(
            fact(
                "All-play",
                row ? F.ledgerText(row, "all_play") : "—",
                row ? rankSub(rows, "all_play", detail.espn_team_id) : ""
            )
        );
        els.teamColophon.appendChild(
            fact(
                "Lineup",
                row ? F.ledgerText(row, "lineup") : "—",
                row && row.luck !== null && row.luck !== undefined
                    ? `${F.formatSigned(row.luck)} wins on luck`
                    : ""
            )
        );
    }

    // ── the season, week by week ────────────────────────────────────────

    function seasonRow(result, scale) {
        const row = el("div", `season__wk${result.is_bye ? " season__wk--bye" : ""}`);
        row.appendChild(el("span", "season__n", `Wk ${result.week}`));

        if (result.is_bye) {
            row.appendChild(el("span", "season__outcome season__outcome--bye", "BYE"));
            row.appendChild(el("span", "season__opp dim", "—"));
            row.appendChild(el("span", "season__score dim", "—"));
            row.appendChild(el("span", "dv"));
            return row;
        }

        // Modifier comes from a fixed set, never from the display text — the
        // pending state renders an em-dash, which is not a class name.
        const modifier = { W: "w", L: "l", T: "t" }[result.outcome] || "pending";
        row.appendChild(
            el("span", `season__outcome season__outcome--${modifier}`, result.outcome || "—")
        );

        const opponent = result.opponent || {};
        const opp = el("span", "season__opp");
        opp.appendChild(document.createTextNode(opponent.name || "—"));
        if (opponent.wins !== null && opponent.wins !== undefined) {
            opp.appendChild(
                el(
                    "small",
                    null,
                    ` · ${F.recordLabel(opponent.wins, opponent.losses, opponent.ties)}`
                )
            );
        }
        row.appendChild(opp);

        row.appendChild(
            el(
                "span",
                "season__score",
                result.points === null || result.points === undefined
                    ? "—"
                    : `${F.formatPoints(result.points)}–${F.formatPoints(result.opponent_points)}`
            )
        );

        // One scale across the season: a margin bar is only readable against
        // the other weeks on the same axis. A week not yet played draws no
        // axis at all — divergingBar reports a missing margin and a genuine
        // tie identically, and a lone zero rule under an unplayed week reads
        // as a result that has not happened.
        const holder = el("div", "dv");
        if (result.margin !== null && result.margin !== undefined) {
            holder.appendChild(el("div", "dv__zero"));
            const bar = F.divergingBar(result.margin, scale);
            if (bar.side !== "zero") {
                const fill = el("div", `dv__bar dv__bar--${bar.side}`);
                fill.style.width = `${bar.width}%`;
                holder.appendChild(fill);
            }
        }
        row.appendChild(holder);
        return row;
    }

    function renderTeamDetail(detail) {
        renderTeamMasthead(detail);
        renderColophon(detail);

        els.teamResults.replaceChildren();
        const results = detail.results || [];
        if (!results.length) {
            els.teamResults.appendChild(el("p", "empty-note", "No games recorded yet."));
            return;
        }
        const scale = F.maxAbs(results.map((result) => result.margin));
        results.forEach((result) => els.teamResults.appendChild(seasonRow(result, scale)));
    }

    // ── the roster, by room ─────────────────────────────────────────────

    function playerRow(entry, line, measured) {
        const item = el("li", `roster__row${entry.matched ? "" : " roster__row--unmatched"}`);
        item.appendChild(el("span", "roster__slot", entry.lineup_slot || "—"));

        const main = el("div", "roster__main");
        main.appendChild(el("span", "roster__name", entry.name || "—"));
        const meta = [entry.position, entry.pro_team].filter(Boolean).join(" · ");
        main.appendChild(el("span", "roster__meta", meta));
        if (entry.matched) {
            const detail = [];
            if (entry.projection && entry.projection[LEAGUE_PROJECTION_FIELD] != null) {
                detail.push(`Proj ${F.formatPoints(entry.projection[LEAGUE_PROJECTION_FIELD])}`);
            }
            if (entry.ranking && entry.ranking.rank != null) {
                const position = entry.ranking.position === "DEF" ? "DST" : entry.ranking.position;
                detail.push(`${position || LEAGUE_SCORING_LABEL} #${entry.ranking.rank}`);
            }
            const actual = (entry.recent_actuals || [])[0];
            if (actual && actual[LEAGUE_ACTUAL_FIELD] != null) {
                detail.push(`Last ${F.formatPoints(actual[LEAGUE_ACTUAL_FIELD])}`);
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
        // Season points per game, in a room that has any. A dash means "this
        // player has not played", which is only worth saying where the rest
        // of the room has numbers — an unmeasurable room gets no column at
        // all rather than one dash per name.
        if (measured) {
            const played = line && line.points_per_game != null;
            item.appendChild(
                el(
                    "span",
                    `roster__ppg${played ? "" : " dim"}`,
                    played ? F.formatPoints(line.points_per_game) : "—"
                )
            );
        }
        return item;
    }

    // The bar is the room against the league at the same position, with a
    // tick where the league average falls. Position, not length alone, is
    // what makes "above average" readable.
    // Each room's axis runs to 1.6x the league average at that position,
    // which puts the average tick at the same place in every room unless a
    // room is strong enough to run past it. That fixed anchor is the point:
    // it is what lets you compare a quarterback room to a tight end room by
    // eye, when the two positions score nothing like the same number.
    function roomStrength(room) {
        const best = Math.max(
            room.points_per_game || 0,
            (room.league_average || 0) * 1.6,
            1
        );
        const wrap = el("div", "room__strength");
        const track = el("div", "meter");
        const fill = el("div", "meter__fill");
        fill.style.width = `${Math.min(100, (room.points_per_game / best) * 100)}%`;
        track.appendChild(fill);
        if (room.league_average != null) {
            const tick = el("div", "meter__avg");
            tick.style.left = `${Math.min(100, (room.league_average / best) * 100)}%`;
            track.appendChild(tick);
        }
        wrap.appendChild(track);
        wrap.appendChild(
            el(
                "span",
                "room__scale",
                `${F.formatPoints(room.points_per_game)} / ${F.formatPoints(room.league_average)} avg`
            )
        );
        return wrap;
    }

    function roomSection(group, measure, production) {
        const section = el("div", "room");
        const head = el("div", "room__head");
        head.appendChild(el("h3", null, group.label));
        if (measure && measure.rank) {
            const rank = el("span", "room__rank");
            rank.appendChild(el("b", null, F.ordinal(measure.rank)));
            rank.appendChild(document.createTextNode(` of ${measure.teams}`));
            head.appendChild(rank);
        }
        section.appendChild(head);

        const measured = Boolean(measure && measure.points_per_game != null);
        if (measured) section.appendChild(roomStrength(measure));

        const list = el("ul", "roster");
        group.entries.forEach((entry) =>
            list.appendChild(playerRow(entry, production[entry.player_id], measured))
        );
        section.appendChild(list);
        return section;
    }

    function renderRoster(payload, rooms) {
        els.teamRoster.replaceChildren();
        if (!payload.entries.length) {
            els.teamRoster.appendChild(el("p", "empty-note", "No roster snapshot yet."));
            els.rosterNote.textContent = "";
            els.roomsLede.textContent = "";
            return;
        }

        // The measurement is optional. Without it the rooms still group and
        // still list, they just carry no bar and no rank.
        const measures = {};
        const production = {};
        ((rooms && rooms.rooms) || []).forEach((room) => {
            measures[room.position] = room;
            Object.keys(room.players || {}).forEach((playerId) => {
                production[playerId] = room.players[playerId];
            });
        });
        els.roomsLede.textContent = rooms && rooms.available
            ? "Season points per game, for the players on this roster now, against the league average at each position."
            : "";

        F.groupByPosition(payload.entries).forEach((group) => {
            els.teamRoster.appendChild(
                roomSection(group, measures[group.position], production)
            );
        });

        const notes = [F.formatAsOf(payload.as_of)];
        if (payload.player_data && payload.player_data.season) {
            const week = payload.player_data.week === 0
                ? "season-long"
                : `week ${payload.player_data.week}`;
            notes.push(`${payload.player_data.season} ${week} player data`);
        }
        els.rosterNote.textContent = notes.filter(Boolean).join(" · ");
    }

    // ── start/sit ───────────────────────────────────────────────────────
    //
    // The roster read already joins every spot to the week's projection and
    // the league already stores its lineup slot counts, so the best legal
    // lineup is arithmetic on data the hub was fetching anyway. The card
    // shows the decision, not the assignment: who belongs in and who belongs
    // out. Those are separate sets because a multi-slot lineup does not imply
    // a legal or meaningful one-for-one swap pairing.

    function renderLineup(payload) {
        // A league whose lineup settings were never collected has no lineup to
        // grade, and a card that says nothing is worse than no card.
        if (!payload || payload.available === false || !(payload.slots || []).length) {
            els.lineupCard.hidden = true;
            return;
        }
        els.lineupCard.hidden = false;

        const week = payload.week === 0 ? "season-long" : `week ${payload.week}`;
        els.lineupMeta.textContent = `Best legal lineup for ${week}, on ${LEAGUE_SCORING_LABEL} projections`;

        els.lineupTotals.replaceChildren();
        els.lineupTotals.appendChild(lineupTotal("Started", F.formatPoints(payload.current.total)));
        els.lineupTotals.appendChild(lineupTotal("Best possible", F.formatPoints(payload.optimal.total)));
        const gain = lineupTotal(
            "On the bench",
            payload.gain != null && payload.gain > 0 ? `+${F.formatPoints(payload.gain)}` : "—"
        );
        if (payload.gain != null && payload.gain > 0) gain.classList.add("lineup__total--gain");
        els.lineupTotals.appendChild(gain);

        const starts = payload.starts || [];
        const sits = payload.sits || [];
        els.lineupChanges.replaceChildren();
        if (!starts.length && !sits.length) {
            const complete = !payload.unprojected_starters && !payload.unfilled_slots;
            els.lineupChanges.appendChild(
                el(
                    "li",
                    "lineup__ok",
                    complete
                        ? "This is the best lineup this roster can field."
                        : "A complete lineup comparison is not available."
                )
            );
        }
        starts.forEach((player) => els.lineupChanges.appendChild(lineupChange("Start", player)));
        sits.forEach((player) => els.lineupChanges.appendChild(lineupChange("Sit", player)));

        const notes = [];
        if (payload.unprojected_starters) {
            const count = payload.unprojected_starters;
            notes.push(
                `${count} starter${count === 1 ? " has" : "s have"} no projection this week, ` +
                    "so the overall gain cannot be calculated"
            );
        }
        if (payload.unfilled_slots) {
            notes.push(`${payload.unfilled_slots} slot${payload.unfilled_slots === 1 ? "" : "s"} could not be filled`);
        }
        notes.push(F.formatAsOf(payload.projection_as_of || payload.as_of));
        els.lineupNote.textContent = notes.filter(Boolean).join(" · ");
    }

    function lineupTotal(label, value) {
        const wrap = el("div", "lineup__total");
        wrap.appendChild(el("dt", null, label));
        wrap.appendChild(el("dd", null, value));
        return wrap;
    }

    function lineupSide(label, player) {
        const side = el("div", `lineup__side lineup__side--${label.toLowerCase()}`);
        side.appendChild(el("span", "lineup__label", label));
        side.appendChild(el("span", "lineup__name", player.name || "—"));
        const meta = [player.position, player.pro_team].filter(Boolean).join(" · ");
        const points = player.projected_points == null
            ? "no projection"
            : F.formatPoints(player.projected_points);
        side.appendChild(el("span", "lineup__points", [meta, points].filter(Boolean).join(" · ")));
        return side;
    }

    function lineupChange(label, player) {
        const item = el("li", "lineup__change");
        item.appendChild(el("span", "lineup__slot", player.slot || "—"));
        item.appendChild(lineupSide(label, player));
        return item;
    }

    function renderTeamOverview(payload) {
        // "missing" means nothing has been written for this team/week yet.
        // Generating costs a model call, so it stays an explicit choice
        // rather than something a page view triggers.
        if (payload.status === "missing") {
            els.teamLede.replaceChildren(
                el("p", "empty-note", "No overview written for this team yet.")
            );
            els.teamOverviewMeta.textContent = "";
            els.teamOverviewRefresh.textContent = "Write overview";
            return;
        }

        renderMarkdown(els.teamLede, payload.overview_md || "No overview available.");
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

    async function loadLedger() {
        const generation = state.generation;
        const request = ++state.ledgerRequest;
        const params = new URLSearchParams({ algorithm: state.algorithm });
        if (state.season) params.set("season", state.season);
        try {
            const payload = await fetchJson(`${API_BASE}/ledger?${params}`);
            if (stale(generation) || request !== state.ledgerRequest) return;
            state.ledger = payload;
            renderAlgorithmSelect(payload.algorithms);
            renderColumnChips();
            renderLedger(payload);
            renderCharts(payload);
        } catch (error) {
            if (stale(generation) || request !== state.ledgerRequest) return;
            // Being signed out is a whole-page condition; anything else is
            // this board's problem alone. The ledger is also fetched while a
            // team page is open, and a failure there should not put an error
            // banner over a view the table is not even on.
            if (error instanceof ForbiddenError) {
                handleFailure(error);
                return;
            }
            state.ledger = null;
            els.ledger.replaceChildren(el("p", "empty-note", "The table is unavailable right now."));
            els.ledgerNote.textContent = "";
            els.ledgerFootnote.textContent = "";
            els.chartsBoard.hidden = true;
        }
    }

    // Switching column re-sorts and redraws from the payload already in
    // hand; only the power *method* costs a request, because the ranks
    // themselves are computed server-side.
    function selectColumn(key) {
        if (key === state.column) return;
        state.column = key;
        writeUrlState(true);
        renderColumnChips();
        if (state.ledger) {
            renderLedger(state.ledger);
            renderCharts(state.ledger);
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

    // ── your team ───────────────────────────────────────────────────────
    //
    // The hub knew all twelve teams and not which one was yours, so start/sit
    // — advice about one specific roster — was reachable only by recognising
    // your own name in the Teams grid. /league/me already stores the mapping
    // for the dashboard hero; this is the same read, used where the advice is.

    async function loadMyTeam() {
        const generation = state.generation;
        const params = new URLSearchParams({ scoring: LEAGUE_SCORING });
        if (state.season) params.set("season", state.season);
        try {
            const me = await fetchJson(`${API_BASE}/me?${params}`);
            if (stale(generation)) return;
            if (me.status !== "configured" || !me.snapshot || !me.selected_team_id) {
                state.myTeamId = null;
                els.myTeamStrip.hidden = true;
                return;
            }
            // The ledger highlights your row, so it needs to know which one
            // is yours before it draws.
            state.myTeamId = me.selected_team_id;
            renderMyTeam(me);
            // Advice is a second request and a nice-to-have: the strip is
            // already useful as a shortcut without it.
            const lineupParams = new URLSearchParams(params);
            lineupParams.set("scoring", LEAGUE_SCORING);
            const lineup = await fetchJson(
                `${API_BASE}/teams/${me.selected_team_id}/lineup?${lineupParams}`
            ).catch(() => null);
            if (stale(generation)) return;
            renderMyTeamAdvice(lineup, me.selected_team_id);
        } catch (error) {
            if (!stale(generation)) {
                state.myTeamId = null;
                els.myTeamStrip.hidden = true;
            }
        }
    }

    function teamHref(teamId) {
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        params.set("team", String(teamId));
        return `/fantasy/league/?${params}`;
    }

    function renderMyTeam(me) {
        const snapshot = me.snapshot;
        const team = snapshot.team || {};
        els.myTeamStrip.hidden = false;
        els.myTeamName.textContent = team.name || team.abbrev || "Your team";
        els.myTeamName.href = teamHref(me.selected_team_id);
        const record = snapshot.record || {};
        els.myTeamMeta.textContent = [
            F.recordLabel(record.wins, record.losses, record.ties),
            snapshot.is_bye
                ? "Bye"
                : snapshot.opponent
                    ? `vs ${snapshot.opponent.name || snapshot.opponent.abbrev}`
                    : "",
            snapshot.power_rank ? `Power #${snapshot.power_rank}` : "",
        ].filter(Boolean).join(" · ");
    }

    function renderMyTeamAdvice(lineup, teamId) {
        // Same rule the start/sit card follows: no advice is better than
        // advice assembled from a season the projections do not cover.
        els.myTeamMoves.replaceChildren();
        if (!lineup || lineup.available === false || lineup.gain == null) {
            els.myTeamAdvice.hidden = true;
            return;
        }
        els.myTeamAdvice.hidden = false;
        els.myTeamAdvice.href = teamHref(teamId);
        els.myTeamAdvice.textContent = lineup.gain > 0
            ? `Your lineup leaves ${F.formatPoints(lineup.gain)} on the bench →`
            : "Your lineup is the best one available →";
        els.myTeamAdvice.classList.toggle("my-team__advice--gain", lineup.gain > 0);

        // Starts and sits are listed as two sets rather than paired swaps,
        // because the lineup read deliberately does not pair them: with
        // overlapping FLEX seats a change is not always one player for one.
        const moves = []
            .concat((lineup.starts || []).map((player) => ["Start", player]))
            .concat((lineup.sits || []).map((player) => ["Sit", player]));
        moves.slice(0, 4).forEach(([label, player]) => {
            const item = el("li", `my-team__move my-team__move--${label.toLowerCase()}`);
            item.appendChild(el("span", "my-team__move-label", label));
            item.appendChild(el("span", "my-team__move-name", player.name || "—"));
            item.appendChild(
                el(
                    "span",
                    "my-team__move-points",
                    player.projected_points == null
                        ? "—"
                        : F.formatPoints(player.projected_points)
                )
            );
            els.myTeamMoves.appendChild(item);
        });
    }

    function scrollToRequestedBoard(hash = window.location.hash) {
        if (!hash || hash.length < 2) return;
        let id;
        try {
            id = decodeURIComponent(hash.slice(1));
        } catch (_error) {
            return;
        }
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ block: "start" });
    }

    // ── free agents ─────────────────────────────────────────────────────
    //
    // Every other waiver list on the internet ranks the player pool. This one
    // subtracts twelve rosters from it, which is the only version of the
    // question anybody actually asks. The hub stores all twelve, so the
    // subtraction is a set difference rather than a guess.

    async function loadFreeAgents() {
        const generation = state.generation;
        const params = new URLSearchParams({ scoring: LEAGUE_SCORING, limit: "25" });
        if (state.season) params.set("season", state.season);
        try {
            const payload = await fetchJson(`${API_BASE}/free-agents?${params}`);
            if (stale(generation)) return;
            renderFreeAgents(payload);
        } catch (error) {
            if (stale(generation)) return;
            // A read that failed is a different thing from a league where
            // everyone is rostered, and an empty list would read as the
            // second. The board stays, and says which one this is.
            els.freeAgents.replaceChildren();
            els.freeAgentsNote.textContent = "Unavailable right now.";
        }
    }

    function renderFreeAgents(payload) {
        els.freeAgents.replaceChildren();
        // Same rule the start/sit card follows: with no roster snapshot to
        // subtract, or rankings from a different season than the one being
        // browsed, there is no claim to make and the board says nothing by
        // not being there.
        const board = els.freeAgents.closest(".board");
        if (!payload || payload.available === false) {
            if (board) board.hidden = true;
            els.freeAgentsNote.textContent = "";
            return;
        }
        if (board) board.hidden = false;

        if (!payload.entries.length) {
            els.freeAgents.appendChild(
                el("li", "empty-note", "Every ranked player is on a roster.")
            );
            els.freeAgentsNote.textContent = "";
            return;
        }

        payload.entries.forEach((entry) => {
            const item = el("li", "free-agent");
            item.appendChild(el("span", "free-agent__rank", `#${entry.rank}`));
            const main = el("div", "free-agent__main");
            main.appendChild(el("span", "free-agent__name", entry.name || "—"));
            const meta = [entry.position, entry.team].filter(Boolean).join(" · ");
            main.appendChild(el("span", "free-agent__meta", meta));
            item.appendChild(main);
            if (entry.trending_adds) {
                // Sleeper's whole user base, not this league — a measure of how
                // contested the pickup is, not of whether he is good.
                const hot = el("span", "free-agent__trend", `+${F.compactCount(entry.trending_adds)} adds`);
                hot.title = `${entry.trending_adds.toLocaleString()} Sleeper adds in the last day`;
                item.appendChild(hot);
            }
            item.appendChild(
                el("span", "free-agent__points", F.formatPoints(entry.projected_points))
            );
            const badge = F.injuryBadge(entry.injury_status);
            if (badge) item.appendChild(el("span", "roster__injury", badge));
            els.freeAgents.appendChild(item);
        });

        const week = payload.week === 0 ? "season-long" : `week ${payload.week}`;
        els.freeAgentsNote.textContent = [
            `${payload.rostered} players rostered`,
            `${week} ${LEAGUE_SCORING_LABEL} projections`,
            // The exclusion is only as fresh as the last league sync, and a
            // stale claim here is the difference between a waiver and a laugh.
            `rosters ${F.formatAsOf(payload.roster_as_of) || "unknown"}`,
        ].join(" · ");
    }

    async function loadTeam() {
        const generation = state.generation;
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        // Clear the whole view, not only the overview: without this the
        // previous team's roster and results sit under the new team's name
        // for as long as the fetch takes.
        els.teamLede.replaceChildren();
        els.teamOverviewMeta.textContent = "";
        els.teamColophon.replaceChildren();
        els.teamResults.replaceChildren();
        els.teamRoster.replaceChildren();
        els.rosterNote.textContent = "";
        els.roomsLede.textContent = "";
        els.lineupCard.hidden = true;
        try {
            const lineupParams = new URLSearchParams(params);
            // The roster list below prints Half PPR projections, so the lineup that
            // grades them has to be scored the same way.
            lineupParams.set("scoring", LEAGUE_SCORING);
            const [detail, roster, lineup, rooms] = await Promise.all([
                fetchJson(`${API_BASE}/teams/${state.teamId}?${params}`),
                fetchJson(`${API_BASE}/teams/${state.teamId}/roster?${params}`),
                fetchJson(`${API_BASE}/teams/${state.teamId}/lineup?${lineupParams}`).catch(
                    // Advice is the one part of this page that can be missing
                    // without the page being broken.
                    () => null
                ),
                // Nor is the league-wide measurement: without it the rooms
                // still group and list, they just carry no bar and no rank.
                fetchJson(`${API_BASE}/teams/${state.teamId}/rooms?${params}`).catch(
                    () => null
                ),
            ]);
            if (stale(generation)) return;
            renderTeamDetail(detail);
            renderRoster(roster, rooms);
            renderLineup(lineup);
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
                els.teamLede.replaceChildren(
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
        // Swap the masthead before the fetch, not after it: the league's
        // record must never stand for a frame under a team's name.
        setMastheadMode(showingTeam);
        if (showingTeam) {
            renderTeamMasthead(null);
            loadTeam();
        }
    }

    async function loadSeason() {
        const generation = ++state.generation;
        const requestedHash = window.location.hash;
        state.myTeamId = null;
        els.myTeamStrip.hidden = true;
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
            writeUrlState(true, requestedHash);

            const standings = await fetchJson(`${API_BASE}/standings?season=${state.season}`);
            if (stale(generation)) return;
            renderTeamsGrid(standings);

            // The ledger is the page; it loads before the boards under it so
            // the table is readable while the rest fills in.
            await loadMyTeam();
            await Promise.all([loadLedger(), loadScoreboard(), loadFreeAgents()]);
            applyRoute();
            // A cross-link from the dashboard's Waiver Pulse lands on the
            // free-agent board, which anchors immediately but fills in late.
            scrollToRequestedBoard(requestedHash);
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

        els.powerAlgorithm.addEventListener("change", (event) => {
            state.algorithm = event.target.value;
            writeUrlState(true);
            loadLedger();
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
            state.column = "record";
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
