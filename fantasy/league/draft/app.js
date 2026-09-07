// Draft recap controller. Pure formatting lives in format.js (DraftFormat);
// this file only fetches, holds view state, and renders.
(function () {
    "use strict";

    const F = window.DraftFormat;
    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy/league`;

    const state = {
        season: null,
        recap: null,
        sort: { key: "pick", direction: "asc" },
        teamFilter: null,
        expanded: new Set(),
        notes: {},
        // Bumped on every context change. A response that resolves with a
        // stale generation is discarded — switching season fires several
        // requests at once, so out-of-order replies are the normal case.
        generation: 0,
    };

    const byId = (id) => document.getElementById(id);
    const els = {
        draftLede: byId("draftLede"),
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
        draftView: byId("draftView"),
        seasonChips: byId("seasonChips"),
        awardsGrid: byId("awardsGrid"),
        accoladesNote: byId("accoladesNote"),
        gradesGrid: byId("gradesGrid"),
        gradesNote: byId("gradesNote"),
        boardNote: byId("boardNote"),
        boardFilters: byId("boardFilters"),
        pickRows: byId("pickRows"),
        callouts: byId("callouts"),
        methodBody: byId("methodBody"),
    };

    class ForbiddenError extends Error {}

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, { credentials: "include", ...options });
        if (response.status === 403) {
            throw new ForbiddenError("Sign in to view the draft recap.");
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

    // Draft notes can come from the model, so render only the small safe
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
        els.draftView.hidden = name !== "draft";
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

    // ── awards ──────────────────────────────────────────────────────────

    const FEATURED = ["vegas_favourite", "espn_favourite", "sleeper_favourite"];

    function awardCard(award, featured) {
        const card = el("article", `award${featured ? " award--featured" : ""}`);
        card.appendChild(el("h3", "award__label", award.label));
        card.appendChild(el("p", "award__blurb", award.blurb));

        const winner = el("div", "award__winner");
        winner.appendChild(
            el("span", "award__team", award.winner.team || "Unknown team")
        );
        if (award.winner.player) {
            winner.appendChild(
                el(
                    "span",
                    "award__detail",
                    `${award.winner.player} · pick ${award.winner.overall_pick}`
                )
            );
        }
        winner.appendChild(el("span", "award__value", award.winner.display));
        card.appendChild(winner);

        if (award.runner_up) {
            const runner = award.runner_up;
            card.appendChild(
                el(
                    "p",
                    "award__runner",
                    `Runner-up: ${runner.team || "—"}${
                        runner.player ? ` (${runner.player})` : ""
                    } · ${runner.display}`
                )
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
                item.appendChild(el("span", null, row.team || row.player || "—"));
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
                el("p", "empty-note", "No accolades yet — the board is still filling in.")
            );
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

    function pickLine(pick, prefix) {
        if (!pick) return null;
        return el(
            "p",
            "grade__pick",
            `${prefix}: ${pick.player.name} at ${pick.overall_pick} (${F.formatSigma(
                pick.adp_sigma
            )})`
        );
    }

    function gradeCard(row, recap) {
        const card = el("article", "grade");
        card.dataset.team = row.espn_team_id;

        const head = el("div", "grade__head");
        const letter = el("span", `grade__letter grade__letter--${F.gradeTier(row.grade)}`, row.grade);
        head.appendChild(letter);
        const titles = el("div", "grade__titles");
        titles.appendChild(el("h3", "grade__team", row.team || "Unknown team"));
        if (row.owner) titles.appendChild(el("span", "grade__owner", row.owner));
        head.appendChild(titles);

        const toggle = el("button", "button button--quiet grade__toggle", "Details");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        head.appendChild(toggle);
        card.appendChild(head);

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

        const best = pickLine(row.best_pick, "Best value");
        if (best) body.appendChild(best);
        const worst = pickLine(row.worst_pick, "Biggest reach");
        if (worst) body.appendChild(worst);

        if (row.construction_notes && row.construction_notes.length) {
            const list = el("ul", "grade__notes");
            row.construction_notes.forEach((note) => list.appendChild(el("li", null, note)));
            body.appendChild(list);
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
        }

        toggle.addEventListener("click", () => {
            body.hidden = !body.hidden;
            toggle.setAttribute("aria-expanded", String(!body.hidden));
            if (body.hidden) state.expanded.delete(row.espn_team_id);
            else state.expanded.add(row.espn_team_id);
        });

        card.appendChild(body);
        return card;
    }

    function renderGrades(recap) {
        els.gradesGrid.replaceChildren();
        (recap.grades || []).forEach((row) => {
            els.gradesGrid.appendChild(gradeCard(row, recap));
        });
        const ungraded = (recap.grades || []).reduce(
            (total, row) => total + (row.unranked_picks || 0),
            0
        );
        els.gradesNote.textContent = ungraded
            ? `${ungraded} picks were not on the ADP board`
            : "Graded on a curve across the league";
    }

    async function writeNote(teamId, container, button) {
        button.disabled = true;
        const original = button.textContent;
        button.textContent = "Writing…";
        try {
            const payload = await fetchJson(
                `${API_BASE}/draft/notes/${teamId}?season=${state.season}`,
                { method: "POST" }
            );
            state.notes[teamId] = payload;
            renderMarkdown(container, payload.note_md || "No recap available.");
            button.textContent = "Rewrite";
        } catch (error) {
            container.replaceChildren(
                el("p", "grade__error", error.message || "Could not write a recap.")
            );
            button.textContent = original;
        } finally {
            button.disabled = false;
        }
    }

    // ── the board ───────────────────────────────────────────────────────

    function renderPicks(recap) {
        els.pickRows.replaceChildren();
        const teams = new Map((recap.teams || []).map((t) => [t.espn_team_id, t.name]));
        let picks = recap.picks || [];
        if (state.teamFilter) {
            picks = F.teamPicks(picks, state.teamFilter);
        }
        const sorted = F.sortPicks(picks, state.sort.key, state.sort.direction);

        sorted.forEach((pick) => {
            const verdict = F.pickVerdict(pick);
            const tr = el("tr", verdict ? `pick pick--${verdict}` : "pick");
            tr.appendChild(el("td", "col-rank", F.roundLabel(pick)));
            tr.appendChild(el("td", "col-team", teams.get(pick.espn_team_id) || "—"));

            const who = el("td", "col-player");
            who.appendChild(el("span", "pick__name", pick.player.name || "—"));
            const meta = [pick.player.pro_team, pick.player.bye ? `bye ${pick.player.bye}` : null]
                .filter(Boolean)
                .join(" · ");
            if (meta) who.appendChild(el("span", "pick__meta", meta));
            if (pick.autopicked) who.appendChild(el("span", "pick__flag", "autopick"));
            if (pick.keeper) who.appendChild(el("span", "pick__flag", "keeper"));
            tr.appendChild(who);

            tr.appendChild(el("td", "col-pos", pick.player.position || "—"));
            tr.appendChild(el("td", "col-adp", F.formatAdp(pick.adp)));

            const sigma = el("td", "col-sigma", F.formatSigma(pick.adp_sigma));
            if (!pick.adp_ranked) {
                sigma.textContent = "unlisted";
                sigma.classList.add("col-sigma--unlisted");
            }
            tr.appendChild(sigma);

            tr.appendChild(el("td", "col-proj", F.formatPoints(pick.points && pick.points.best)));
            els.pickRows.appendChild(tr);
        });

        els.boardNote.textContent = `${sorted.length} of ${(recap.picks || []).length} picks`;
    }

    function renderFilters(recap) {
        els.boardFilters.replaceChildren();
        const all = el("button", `chip${state.teamFilter ? "" : " chip--active"}`, "All teams");
        all.type = "button";
        all.addEventListener("click", () => {
            state.teamFilter = null;
            renderFilters(recap);
            renderPicks(recap);
        });
        els.boardFilters.appendChild(all);

        (recap.teams || []).forEach((team) => {
            const active = state.teamFilter === team.espn_team_id;
            const chip = el("button", `chip${active ? " chip--active" : ""}`, team.name || "—");
            chip.type = "button";
            chip.addEventListener("click", () => {
                state.teamFilter = active ? null : team.espn_team_id;
                renderFilters(recap);
                renderPicks(recap);
            });
            els.boardFilters.appendChild(chip);
        });
    }

    function bindSorting() {
        document.querySelectorAll(".col-sort").forEach((button) => {
            button.addEventListener("click", () => {
                const key = button.dataset.sort;
                if (state.sort.key === key) {
                    state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
                } else {
                    state.sort.key = key;
                    // Pick order reads forwards; every value column reads best first.
                    state.sort.direction = key === "pick" || key === "adp" ? "asc" : "desc";
                }
                if (state.recap) renderPicks(state.recap);
            });
        });
    }

    // ── callouts and method ─────────────────────────────────────────────

    function renderCallouts(recap) {
        els.callouts.replaceChildren();
        const callouts = recap.callouts || {};

        if (callouts.first_qb) {
            const card = el("article", "callout");
            card.appendChild(el("h3", null, "First quarterback off the board"));
            card.appendChild(
                el(
                    "p",
                    null,
                    `${callouts.first_qb.player} at pick ${callouts.first_qb.overall_pick}` +
                        (callouts.first_qb.team ? ` — ${callouts.first_qb.team}` : "")
                )
            );
            if (callouts.superflex) {
                card.appendChild(
                    el(
                        "p",
                        "callout__note",
                        `${callouts.qb_count} quarterbacks went in total, in a league that starts one in the flex.`
                    )
                );
            }
            els.callouts.appendChild(card);
        }

        const runs = callouts.positional_runs || [];
        if (runs.length) {
            const card = el("article", "callout");
            card.appendChild(el("h3", null, "Positional runs"));
            const list = el("ol", "compact-list");
            runs.forEach((run) => {
                const item = el("li");
                item.appendChild(
                    el("span", null, `${run.count} ${run.position}s`)
                );
                item.appendChild(
                    el("span", "compact-list__value", `picks ${run.from_pick}–${run.to_pick}`)
                );
                list.appendChild(item);
            });
            card.appendChild(list);
            els.callouts.appendChild(card);
        }

        if (!els.callouts.childElementCount) {
            els.callouts.appendChild(el("p", "empty-note", "Nothing notable on the board yet."));
        }
    }

    function renderMethod(recap) {
        els.methodBody.replaceChildren();
        const method = recap.method || {};

        els.methodBody.appendChild(el("p", null, method.relative || ""));
        els.methodBody.appendChild(el("p", null, method.adp_caveat || ""));
        els.methodBody.appendChild(el("p", null, F.adpSourceNote(recap.adp_source)));

        if (method.weights) {
            const list = el("ul", "method__list");
            Object.entries(method.weights).forEach(([key, weight]) => {
                list.appendChild(
                    el(
                        "li",
                        null,
                        `${F.componentLabel(key)} — ${Math.round(weight * 100)}%. ${F.componentBlurb(key)}`
                    )
                );
            });
            els.methodBody.appendChild(list);
        }

        if (method.starting_slots && method.starting_slots.length) {
            els.methodBody.appendChild(
                el(
                    "p",
                    null,
                    `Starting lineup: ${method.starting_slots.join(", ")}. Replacement level is read off this, not a generic baseline.`
                )
            );
        }
        if (method.replacement_points) {
            const list = el("ul", "method__list");
            Object.entries(method.replacement_points).forEach(([position, points]) => {
                list.appendChild(el("li", null, `${position} replacement — ${F.formatPoints(points)} pts`));
            });
            els.methodBody.appendChild(list);
        }
    }

    // ── load ────────────────────────────────────────────────────────────

    function renderStatus(recap) {
        els.statusValue.textContent = F.statusLabel(recap.status);
        els.statusSeason.textContent = recap.season || "";
        els.noticeBanner.hidden = recap.status !== "in_progress";
        if (recap.status === "in_progress") {
            els.noticeBanner.textContent =
                "The draft is still running. Grades and accolades update as picks land.";
        }
    }

    async function load() {
        const generation = ++state.generation;
        try {
            const params = state.season ? `?season=${state.season}` : "";
            const recap = await fetchJson(`${API_BASE}/draft${params}`);
            if (generation !== state.generation) return;

            state.recap = recap;
            state.season = recap.season;
            renderStatus(recap);

            if (!recap.picks || !recap.picks.length) {
                els.emptyTitle.textContent =
                    recap.status === "in_progress" ? "Draft under way" : "No draft yet";
                els.emptyBody.textContent =
                    recap.status === "in_progress"
                        ? "The draft room is open. This page fills in as picks land — check back in a few minutes."
                        : "This page fills in on its own once the draft board has picks on it.";
                setView("empty");
                return;
            }

            renderAwards(recap);
            renderGrades(recap);
            renderFilters(recap);
            renderPicks(recap);
            renderCallouts(recap);
            renderMethod(recap);
            setView("draft");
        } catch (error) {
            handleFailure(error);
        }
    }

    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        const season = parseInt(params.get("season"), 10);
        if (Number.isFinite(season)) state.season = season;
    }

    readUrlState();
    bindSorting();
    load();
})();
