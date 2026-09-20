// Pure formatting/derivation helpers for the draft recap.
//
// Kept free of DOM/network so they can be unit-tested under node and reused
// by app.js (browser) via window.DraftFormat. No dependencies.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.DraftFormat = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const COMPONENT_LABELS = {
        adp_value: "Value vs ADP",
        starters: "Starting lineup",
        bench: "Bench",
        construction: "Roster build",
    };

    // What each sub-score is actually claiming, in the manager's own terms.
    const COMPONENT_BLURBS = {
        adp_value: "How much later than ADP this roster was assembled.",
        starters: "Points above replacement in the best legal starting lineup.",
        bench: "Surplus value sitting behind the starters.",
        construction: "Whether the roster can field a legal, unstacked lineup.",
    };

    const STATUS_LABELS = {
        not_drafted: "Not drafted yet",
        in_progress: "Draft in progress",
        complete: "Draft complete",
        unknown: "Draft status unknown",
    };

    // Grades are a curve across one league, so the colour ramp is too.
    const GRADE_TIERS = { A: "great", B: "good", C: "fair", D: "poor", F: "poor" };

    function gradeTier(grade) {
        if (!grade) return "fair";
        return GRADE_TIERS[String(grade).charAt(0).toUpperCase()] || "fair";
    }

    function statusLabel(status) {
        return STATUS_LABELS[status] || STATUS_LABELS.unknown;
    }

    function formatSigma(value) {
        if (value == null) return "—";
        const rounded = Number(value);
        if (!Number.isFinite(rounded)) return "—";
        return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}σ`;
    }

    function formatDelta(value) {
        if (value == null) return "—";
        const rounded = Number(value);
        if (!Number.isFinite(rounded)) return "—";
        if (Math.abs(rounded) < 0.05) return "even";
        return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
    }

    function formatPoints(value) {
        if (value == null) return "—";
        const number = Number(value);
        return Number.isFinite(number) ? number.toFixed(0) : "—";
    }

    function formatAdp(value) {
        if (value == null) return "—";
        const number = Number(value);
        return Number.isFinite(number) ? number.toFixed(1) : "—";
    }

    // A pick is a reach when it went before ADP, value when it went after.
    // The wording matters more than the sign: "reach" and "value" are what
    // the league actually argues about.
    function pickVerdict(pick) {
        if (!pick || !pick.adp_ranked || pick.adp_sigma == null) return null;
        const sigma = Number(pick.adp_sigma);
        if (!Number.isFinite(sigma)) return null;
        if (sigma <= -1.5) return "reach";
        if (sigma >= 1.5) return "value";
        return "chalk";
    }

    function componentLabel(key) {
        return COMPONENT_LABELS[key] || key;
    }

    function componentBlurb(key) {
        return COMPONENT_BLURBS[key] || "";
    }

    // A z-score maps onto a 0-100 bar. Three sigma each way covers everything
    // a ten-team league produces, and clamping keeps one outlier from
    // flattening every other bar on the card.
    function componentBarWidth(z) {
        const value = Number(z);
        if (!Number.isFinite(value)) return 50;
        return Math.max(0, Math.min(100, ((value + 3) / 6) * 100));
    }

    function roundLabel(pick) {
        if (!pick || !pick.round) return `Pick ${pick && pick.overall_pick}`;
        return `${pick.round}.${String(pick.round_pick || 0).padStart(2, "0")}`;
    }

    // The recap has to be able to say which ADP it graded against, including
    // the uncomfortable case where the only snapshot postdates the draft.
    function adpSourceNote(source) {
        if (!source) return "No ADP board was collected, so picks are ungraded against ADP.";
        const parts = [];
        if (source.total_drafts) {
            parts.push(`${source.total_drafts.toLocaleString()} drafts`);
        }
        if (source.start_date && source.end_date) {
            parts.push(`${source.start_date} to ${source.end_date}`);
        }
        if (source.teams) parts.push(`${source.teams}-team`);
        const label = source.format === "2qb" ? "2QB" : "half PPR";
        const sample = parts.length ? ` — ${parts.join(", ")}` : "";
        const timing = source.captured_before_draft
            ? ""
            : " Collected after the draft, so it may have moved since.";
        return `${label} ADP from Fantasy Football Calculator${sample}.${timing}`;
    }

    function sortPicks(picks, key, direction) {
        const factor = direction === "asc" ? 1 : -1;
        const value = (row) => {
            switch (key) {
                case "player":
                    return (row.player && row.player.name) || "";
                case "position":
                    return (row.player && row.player.position) || "";
                case "adp":
                    return row.adp == null ? Infinity : row.adp;
                case "sigma":
                    return row.adp_sigma == null ? -Infinity : row.adp_sigma;
                case "points":
                    return (row.points && row.points.best) == null
                        ? -Infinity
                        : row.points.best;
                default:
                    return row.overall_pick;
            }
        };
        return picks.slice().sort((a, b) => {
            const left = value(a);
            const right = value(b);
            if (typeof left === "string" || typeof right === "string") {
                return String(left).localeCompare(String(right)) * factor;
            }
            if (left === right) return a.overall_pick - b.overall_pick;
            return (left < right ? -1 : 1) * factor;
        });
    }

    function teamPicks(picks, teamId) {
        return (picks || []).filter((row) => row.espn_team_id === teamId);
    }

    // Which awards a given team won, so a grade card can show its own
    // trophies rather than making the reader scan the wall for them.
    function awardsForTeam(accolades, teamId) {
        return (accolades || []).filter(
            (award) => award.winner && award.winner.espn_team_id === teamId
        );
    }

    return {
        COMPONENT_LABELS,
        adpSourceNote,
        awardsForTeam,
        componentBarWidth,
        componentBlurb,
        componentLabel,
        formatAdp,
        formatDelta,
        formatPoints,
        formatSigma,
        gradeTier,
        pickVerdict,
        roundLabel,
        sortPicks,
        statusLabel,
        teamPicks,
    };
});
