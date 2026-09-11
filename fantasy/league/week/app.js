// Weekly recap controller. Pure formatting lives in format.js (WeekFormat);
// this file only fetches, holds view state, and renders. Deliberately the
// same shape as league/draft/app.js — same fetch guard, same generation
// counter, same note lifecycle — because the two pages are one room apart.
(function () {
    "use strict";

    const F = window.WeekFormat;
    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/league`;

    const state = {
        season: null,
        week: null,
        recap: null,
        sort: { key: "grade", direction: "desc" },
        expanded: new Set(),
        notes: {},
        // Bumped on every context change. A response that resolves with a
        // stale generation is discarded — switching week fires several
        // requests at once, so out-of-order replies are the normal case.
        generation: 0,
    };

    const byId = (id) => document.getElementById(id);
    const els = {
        statusLabel: byId("statusLabel"),
        statusValue: byId("statusValue"),
        statusSeason: byId("statusSeason"),
        errorBanner: byId("errorBanner"),
        noticeBanner: byId("noticeBanner"),
        signedOutView: byId("signedOutView"),
        signInLink: byId("signInLink"),
        emptyView: byId("emptyView"),
        emptyTitle: byId("emptyTitle"),
        emptyBody: byId("emptyBody"),
        weekView: byId("weekView"),
        seasonBar: byId("seasonBar"),
        seasonChips: byId("seasonChips"),
        weekChips: byId("weekChips"),
        scoreboard: byId("scoreboard"),
        slateNote: byId("slateNote"),
        awardsGrid: byId("awardsGrid"),
        accoladesNote: byId("accoladesNote"),
        gradesGrid: byId("gradesGrid"),
        gradesNote: byId("gradesNote"),
        tableNote: byId("tableNote"),
        teamRows: byId("teamRows"),
        lineupNote: byId("lineupNote"),
        callouts: byId("callouts"),
        methodBody: byId("methodBody"),
    };

    class ForbiddenError extends Error {}

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, { credentials: "include", ...options });
        if (response.status === 403) {
            throw new ForbiddenError("Sign in to view the weekly recap.");
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

    function stat(list, label, value) {
        list.appendChild(el("dt", null, label));
        list.appendChild(el("dd", null, value));
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

    // Week notes can come from the model, so render only the small safe
    // Markdown subset the league hub supports. Raw HTML is always text.
    function renderMarkdown(container, text) {
        container.replaceChildren();
        String(text || "").split(/\n{2,}/).forEach((block) => {
            const paragraph = el("p");
            block.split("\n").forEach((line, index) => {
                if (index) paragraph.appendChild(document.createElement("br"));
                appendInline(paragraph, line);
            });
            container.appendChild(paragraph);
        });
    }

    function setView(name) {
        els.signedOutView.hidden = name !== "signedOut";
        els.emptyView.hidden = name !== "empty";
        els.weekView.hidden = name !== "week";
        els.seasonBar.hidden = name === "signedOut";
    }

    function writeUrlState(replace) {
        const params = new URLSearchParams();
        if (state.season) params.set("season", state.season);
        if (state.week) params.set("week", state.week);
        const query = params.toString();
        const url = query ? `?${query}` : window.location.pathname;
        window.history[replace ? "replaceState" : "pushState"]({}, "", url);
    }

    function reset() {
        state.expanded.clear();
        state.notes = {};
    }

    function selectSeason(season) {
        if (season === state.season) return;
        state.season = season;
        // A week number does not carry across seasons: week 9 of 2024 has
        // nothing to do with week 9 of 2026, so let the API pick again.
        state.week = null;
        reset();
        writeUrlState(false);
        load();
    }

    function selectWeek(week) {
        if (week === state.week) return;
        state.week = week;
        reset();
        writeUrlState(false);
        load();
    }

    function renderSeasonChips(seasons) {
        els.seasonChips.replaceChildren();
        (seasons || []).forEach((season) => {
            const label = `${season.season}${season.available ? "" : " · private"}`;
            const chip = el("button", "chip", label);
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

    function renderWeekChips(recap) {
        els.weekChips.replaceChildren();
        const played = new Set(recap.played_weeks || []);
        (recap.available_weeks || []).forEach((week) => {
            const chip = el("button", "chip", `Wk ${week}`);
            chip.type = "button";
            // A week nobody has played has nothing to recap. It stays visible
            // so the length of the season is legible, and stays unpressable
            // so a click cannot land on an empty page.
            if (!played.has(week)) {
                chip.disabled = true;
                chip.classList.add("chip--disabled");
                chip.title = "Not played yet.";
            } else {
                chip.addEventListener("click", () => selectWeek(week));
            }
            if (week === recap.week) {
                chip.classList.add("chip--active");
                chip.setAttribute("aria-current", "true");
            }
            els.weekChips.appendChild(chip);
        });
    }

    function showError(message) {
        els.errorBanner.textContent = message;
        els.errorBanner.hidden = false;
    }

    function handleFailure(error) {
        if (error instanceof ForbiddenError) {
            // Preserve where they were headed so login can bounce them back.
            const next = `${window.location.pathname}${window.location.search}`;
            els.signInLink.href = `/login/?next=${encodeURIComponent(next)}`;
            setView("signedOut");
            return;
        }
        showError(error.message || "Something went wrong.");
    }

    // ── the slate ───────────────────────────────────────────────────────

    function scoreSide(side, isWinner) {
        const row = el("div", `score__side${isWinner ? " score__side--won" : ""}`);
        row.appendChild(el("span", "score__team", (side && side.name) || "—"));
        row.appendChild(
            el("span", "score__points", F.formatPoints(side && side.points))
        );
        return row;
    }

    function renderScoreboard(recap) {
        els.scoreboard.replaceChildren();
        const played = (recap.matchups || []).filter((row) => row.is_complete);
        if (!played.length) {
            els.scoreboard.appendChild(
                el("p", "empty-note", "No results on the board yet.")
            );
            return;
        }
        played.forEach((matchup) => {
            const card = el("article", "score");
            if (!matchup.away) {
                card.appendChild(scoreSide(matchup.home, false));
                card.appendChild(el("p", "score__meta", "Bye"));
                els.scoreboard.appendChild(card);
                return;
            }
            const homeWon = (matchup.home.points || 0) >= (matchup.away.points || 0);
            card.appendChild(scoreSide(matchup.home, homeWon));
            card.appendChild(scoreSide(matchup.away, !homeWon));
            card.appendChild(
                el(
                    "p",
                    "score__meta",
                    matchup.margin
                        ? `Won by ${F.formatPoints(matchup.margin)}`
                        : "Tied"
                )
            );
            els.scoreboard.appendChild(card);
        });
        els.slateNote.textContent = `${played.length} of ${(recap.matchups || []).length} games final`;
    }

    // ── awards ──────────────────────────────────────────────────────────

    const FEATURED = ["top_score", "best_manager", "player_of_the_week"];

    function awardCard(award, featured) {
        const card = el("article", `award${featured ? " award--featured" : ""}`);
        card.appendChild(el("h3", "award__label", award.label));
        card.appendChild(el("p", "award__blurb", award.blurb));

        const winner = el("div", "award__winner");
        // A player award leads with the player; a team award leads with the
        // team. Either way the second line says who it belongs to.
        winner.appendChild(
            el(
                "span",
                "award__team",
                award.winner.player || award.winner.team || "Unknown team"
            )
        );
        const detail = [award.winner.player ? award.winner.team : null, award.winner.detail]
            .filter(Boolean)
            .join(" · ");
        if (detail) winner.appendChild(el("span", "award__detail", detail));
        winner.appendChild(el("span", "award__value", award.winner.display));
        card.appendChild(winner);

        if (award.runner_up) {
            const runner = award.runner_up;
            const who = runner.player || runner.team || "—";
            card.appendChild(
                el("p", "award__runner", `Runner-up: ${who} · ${runner.display}`)
            );
        }
        if (award.note) card.appendChild(el("p", "award__note", award.note));

        // The full ordering behind the winner, so a card can be argued with.
        if (award.standings && award.standings.length > 2) {
            const details = el("details", "award__standings");
            details.appendChild(el("summary", null, "Full order"));
            const list = el("ol", "compact-list");
            award.standings.forEach((row) => {
                const item = el("li");
                item.appendChild(el("span", null, row.player || row.team || "—"));
                item.appendChild(el("span", "compact-list__value", row.display));
                list.appendChild(item);
            });
            details.appendChild(list);
            card.appendChild(details);
        }
        return card;
    }

    function renderAwards(recap) {
        els.awardsGrid.replaceChildren();
        const awards = recap.accolades || [];
        if (!awards.length) {
            els.awardsGrid.appendChild(
                el("p", "empty-note", "No accolades yet — the week is still filling in.")
            );
            els.accoladesNote.textContent = "";
            return;
        }
        const featured = awards.filter((a) => FEATURED.includes(a.key));
        const rest = awards.filter((a) => !FEATURED.includes(a.key));
        featured.forEach((award) => els.awardsGrid.appendChild(awardCard(award, true)));
        rest.forEach((award) => els.awardsGrid.appendChild(awardCard(award, false)));
        els.accoladesNote.textContent = `${awards.length} awards handed out`;
    }

    // ── grades ──────────────────────────────────────────────────────────

    function componentBar(key, component) {
        const row = el("div", "component");
        const head = el("div", "component__head");
        head.appendChild(el("span", "component__label", F.componentLabel(key)));
        head.appendChild(
            el("span", "component__z", `${component.z > 0 ? "+" : ""}${component.z}`)
        );
        row.appendChild(head);

        const track = el("div", "component__track");
        const fill = el("div", "component__fill");
        fill.style.width = `${F.componentBarWidth(component.z)}%`;
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(
            el(
                "span",
                "component__blurb",
                `${F.componentBlurb(key)} Worth ${Math.round(component.weight * 100)}%.`
            )
        );
        return row;
    }

    function playerLine(entry, prefix) {
        if (!entry) return null;
        const projected =
            entry.projected == null ? "" : ` (projected ${F.formatPoints(entry.projected)})`;
        return el(
            "p",
            "grade__pick",
            `${prefix}: ${entry.name} ${F.formatPoints(entry.points)}${projected}`
        );
    }

    function gradeCard(row, recap) {
        const card = el("article", "grade");
        card.dataset.team = row.espn_team_id;

        const head = el("div", "grade__head");
        head.appendChild(
            el("span", `grade__letter grade__letter--${F.gradeTier(row.grade)}`, row.grade)
        );
        const titles = el("div", "grade__titles");
        titles.appendChild(el("h3", "grade__team", row.team || "Unknown team"));
        titles.appendChild(el("span", "grade__owner", F.resultLine(row)));
        head.appendChild(titles);

        const toggle = el("button", "button button--quiet grade__toggle", "Details");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        head.appendChild(toggle);
        card.appendChild(head);

        const stats = el("dl", "grade__stats");
        stat(stats, "Points", F.formatPoints(row.points));
        stat(stats, "vs proj", F.formatSigned(row.vs_projection));
        stat(stats, "Lineup", F.formatPercent(row.efficiency));
        stat(stats, "All-play", F.formatAllPlay(row.all_play));
        card.appendChild(stats);

        const movement = F.movementLabel(row.power);
        if (movement) card.appendChild(el("p", "grade__power", movement));

        const trophies = F.awardsForTeam(recap.accolades, row.espn_team_id);
        if (trophies.length) {
            const list = el("ul", "grade__trophies");
            trophies.forEach((award) => list.appendChild(el("li", null, award.label)));
            card.appendChild(list);
        }

        const body = el("div", "grade__body");
        body.hidden = !state.expanded.has(row.espn_team_id);
        toggle.setAttribute("aria-expanded", String(!body.hidden));

        Object.entries(row.components).forEach(([key, component]) => {
            body.appendChild(componentBar(key, component));
        });

        const best = playerLine(row.best_starter, "Carried by");
        if (best) body.appendChild(best);
        const worst = playerLine(row.worst_starter, "Quietest starter");
        if (worst) body.appendChild(worst);

        if (row.should_have_started && row.should_have_started.length) {
            const list = el("ul", "grade__notes");
            row.should_have_started.forEach((entry) => {
                list.appendChild(
                    el(
                        "li",
                        null,
                        `${entry.name} would have started: ${F.formatPoints(entry.points)} from the bench`
                    )
                );
            });
            body.appendChild(list);
        }
        if (row.unscored_starters) {
            body.appendChild(
                el(
                    "p",
                    "grade__pick",
                    `${row.unscored_starters} starter(s) have no line in the stat feed, so this lineup is ungraded.`
                )
            );
        }

        const note = el("div", "grade__note");
        const noteBody = el("div", "grade__note-body");
        noteBody.setAttribute("aria-live", "polite");
        const write = el("button", "button button--quiet", "Write recap");
        write.type = "button";
        write.addEventListener("click", () => writeNote(row.espn_team_id, noteBody, write));
        note.appendChild(noteBody);
        note.appendChild(write);
        body.appendChild(note);

        const stored = state.notes[row.espn_team_id];
        if (stored && stored.note_md) {
            renderMarkdown(noteBody, stored.note_md);
            write.textContent = "Rewrite";
            write.dataset.hasNote = "true";
        }

        toggle.addEventListener("click", () => {
            body.hidden = !body.hidden;
            toggle.setAttribute("aria-expanded", String(!body.hidden));
            if (body.hidden) state.expanded.delete(row.espn_team_id);
            else {
                state.expanded.add(row.espn_team_id);
                if (!Object.prototype.hasOwnProperty.call(state.notes, row.espn_team_id)) {
                    loadStoredNote(row.espn_team_id, noteBody, write);
                }
            }
        });

        card.appendChild(body);
        return card;
    }

    function noteParams() {
        const params = new URLSearchParams();
        if (state.season) params.set("season", String(state.season));
        if (state.week) params.set("week", String(state.week));
        return params;
    }

    async function loadStoredNote(teamId, container, button) {
        const generation = state.generation;
        button.disabled = true;
        try {
            const payload = await fetchJson(
                `${API_BASE}/week/notes/${teamId}?${noteParams()}`
            );
            if (generation !== state.generation) return;
            state.notes[teamId] = payload;
            if (payload.note_md) {
                renderMarkdown(container, payload.note_md);
                button.textContent = "Rewrite";
                button.dataset.hasNote = "true";
            }
        } catch (_error) {
            // A note is optional. Keep generation available even if its read
            // endpoint is temporarily unavailable.
        } finally {
            if (generation === state.generation) button.disabled = false;
        }
    }

    async function writeNote(teamId, container, button) {
        button.disabled = true;
        const original = button.textContent;
        const force = button.dataset.hasNote === "true";
        button.textContent = "Writing…";
        try {
            const params = noteParams();
            if (force) params.set("force", "true");
            const payload = await fetchJson(
                `${API_BASE}/week/notes/${teamId}?${params}`,
                { method: "POST" }
            );
            state.notes[teamId] = payload;
            renderMarkdown(container, payload.note_md || "No recap available.");
            button.textContent = "Rewrite";
            button.dataset.hasNote = "true";
        } catch (error) {
            container.replaceChildren(
                el("p", "grade__error", error.message || "Could not write a recap.")
            );
            button.textContent = original;
        } finally {
            button.disabled = false;
        }
    }

    function renderGrades(recap) {
        els.gradesGrid.replaceChildren();
        (recap.grades || []).forEach((row) => {
            els.gradesGrid.appendChild(gradeCard(row, recap));
        });
        const ungraded = (recap.grades || []).filter(
            (row) => row.efficiency == null
        ).length;
        els.gradesNote.textContent = ungraded
            ? `${ungraded} lineup(s) could not be scored`
            : "Graded on a curve across the league";
    }

    // ── the table ───────────────────────────────────────────────────────

    function renderTable(recap) {
        els.teamRows.replaceChildren();
        const rows = F.sortTeams(
            recap.grades || [],
            state.sort.key,
            state.sort.direction
        );
        rows.forEach((row) => {
            const tr = el("tr", row.result ? `team team--${row.result}` : "team");
            tr.appendChild(el("td", "col-team", row.team || "—"));
            tr.appendChild(el("td", "col-result", F.resultLine(row) || "—"));
            tr.appendChild(el("td", "col-num", F.formatPoints(row.points)));
            tr.appendChild(el("td", "col-num", F.formatSigned(row.vs_projection)));
            tr.appendChild(el("td", "col-num", F.formatPoints(row.optimal)));
            tr.appendChild(el("td", "col-num", F.formatPercent(row.efficiency)));
            tr.appendChild(el("td", "col-num", F.formatPoints(row.points_left)));
            tr.appendChild(el("td", "col-num", F.formatAllPlay(row.all_play)));
            els.teamRows.appendChild(tr);
        });
        els.tableNote.textContent = `${rows.length} teams`;
        els.lineupNote.textContent = F.lineupNote(recap.lineups);
    }

    function bindSorting() {
        document.querySelectorAll(".col-sort").forEach((button) => {
            button.addEventListener("click", () => {
                const key = button.dataset.sort;
                if (state.sort.key === key) {
                    state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
                } else {
                    state.sort.key = key;
                    // A name reads forwards; every value column reads best first.
                    state.sort.direction = key === "team" ? "asc" : "desc";
                }
                if (state.recap) renderTable(state.recap);
            });
        });
    }

    // ── callouts and method ─────────────────────────────────────────────

    function renderCallouts(recap) {
        els.callouts.replaceChildren();
        const callouts = recap.callouts || {};

        if (callouts.scoring) {
            const scoring = callouts.scoring;
            const card = el("article", "callout");
            card.appendChild(el("h3", null, "What a normal score was"));
            card.appendChild(
                el(
                    "p",
                    null,
                    `${F.formatPoints(scoring.median)} was the middle of the league, ` +
                        `between ${F.formatPoints(scoring.low)} and ${F.formatPoints(scoring.high)}.`
                )
            );
            card.appendChild(
                el(
                    "p",
                    "callout__note",
                    `${F.formatPoints(scoring.spread)} points separated first from last across ${scoring.teams} teams.`
                )
            );
            els.callouts.appendChild(card);
        }

        if (callouts.expectation) {
            const card = el("article", "callout");
            card.appendChild(el("h3", null, "Against the projections"));
            card.appendChild(
                el(
                    "p",
                    null,
                    `${callouts.expectation.beat} of ${callouts.expectation.of} teams beat the board.`
                )
            );
            els.callouts.appendChild(card);
        }

        if (callouts.movers && callouts.movers.length) {
            const card = el("article", "callout");
            card.appendChild(el("h3", null, "Power ranking movement"));
            const list = el("ol", "compact-list");
            callouts.movers.forEach((mover) => {
                const item = el("li");
                item.appendChild(el("span", null, mover.team || "—"));
                item.appendChild(
                    el(
                        "span",
                        "compact-list__value",
                        `${mover.rank_delta > 0 ? "▲" : "▼"}${Math.abs(mover.rank_delta)} to ${mover.rank}`
                    )
                );
                list.appendChild(item);
            });
            card.appendChild(list);
            els.callouts.appendChild(card);
        }

        if (!els.callouts.childElementCount) {
            els.callouts.appendChild(
                el("p", "empty-note", "Nothing notable on the board yet.")
            );
        }
    }

    function renderMethod(recap) {
        els.methodBody.replaceChildren();
        const method = recap.method || {};

        els.methodBody.appendChild(el("p", null, method.relative || ""));

        if (method.weights) {
            const list = el("ul", "method__list");
            Object.entries(method.weights).forEach(([key, weight]) => {
                const blurb = (method.components || {})[key] || F.componentBlurb(key);
                list.appendChild(
                    el("li", null, `${F.componentLabel(key)} — ${Math.round(weight * 100)}%. ${blurb}`)
                );
            });
            els.methodBody.appendChild(list);
        }

        els.methodBody.appendChild(el("p", null, method.lineup_caveat || ""));
        if (!method.lineup_available && method.lineup_reason) {
            els.methodBody.appendChild(
                el("p", null, F.LINEUP_REASONS[method.lineup_reason] || "")
            );
        }
        els.methodBody.appendChild(el("p", null, method.projection_caveat || ""));
        if (method.roster_as_of) {
            els.methodBody.appendChild(
                el(
                    "p",
                    null,
                    `Rosters last collected ${new Date(method.roster_as_of).toLocaleString()}.`
                )
            );
        }
    }

    // ── load ────────────────────────────────────────────────────────────

    function renderStatus(recap) {
        els.statusValue.textContent = F.weekLabel(recap.week);
        els.statusSeason.textContent = `${recap.season || ""} · ${F.statusLabel(recap.status)}`;
        els.noticeBanner.hidden = recap.status !== "in_progress";
        if (recap.status === "in_progress") {
            els.noticeBanner.textContent =
                "Games are still being played. Grades and accolades update as results land.";
        }
    }

    async function load() {
        const generation = ++state.generation;
        try {
            const params = new URLSearchParams();
            if (state.season) params.set("season", state.season);
            if (state.week) params.set("week", state.week);
            const query = params.toString() ? `?${params}` : "";
            const [seasonPayload, recap] = await Promise.all([
                fetchJson(`${API_BASE}/seasons`),
                fetchJson(`${API_BASE}/week${query}`),
            ]);
            if (generation !== state.generation) return;

            state.recap = recap;
            state.season = recap.season;
            state.week = recap.week;
            renderStatus(recap);
            renderSeasonChips(seasonPayload.seasons);
            renderWeekChips(recap);
            writeUrlState(true);

            if (!recap.grades || !recap.grades.length) {
                els.emptyTitle.textContent =
                    recap.status === "in_progress" ? "Week under way" : "No week to recap yet";
                els.emptyBody.textContent =
                    recap.status === "in_progress"
                        ? "Games are being played. This page fills in as results land — check back after the games."
                        : "This page fills in on its own once a week has been played.";
                setView("empty");
                return;
            }

            renderScoreboard(recap);
            renderAwards(recap);
            renderGrades(recap);
            renderTable(recap);
            renderCallouts(recap);
            renderMethod(recap);
            setView("week");
        } catch (error) {
            handleFailure(error);
        }
    }

    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        const season = parseInt(params.get("season"), 10);
        const week = parseInt(params.get("week"), 10);
        state.season = Number.isFinite(season) ? season : null;
        state.week = Number.isFinite(week) ? week : null;
    }

    readUrlState();
    bindSorting();
    window.addEventListener("popstate", () => {
        reset();
        readUrlState();
        load();
    });
    load();
})();
