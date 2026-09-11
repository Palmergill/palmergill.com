// Pure formatting/derivation helpers for the weekly recap.
//
// Kept free of DOM/network so they can be unit-tested under node and reused
// by app.js (browser) via window.WeekFormat. No dependencies. Structurally the
// sibling of league/draft/format.js: the two recaps are rooms in the same
// hub, and a number should not be spelled two ways between them.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.WeekFormat = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const COMPONENT_LABELS = {
        scoring: "Points scored",
        management: "Lineup set",
        matchup: "The result",
    };

    // What each sub-score is actually claiming, in the manager's own terms.
    const COMPONENT_BLURBS = {
        scoring: "What the starting lineup actually put on the board.",
        management: "The share of this roster's best legal lineup that started.",
        matchup: "Margin against the team the schedule handed you.",
    };

    const STATUS_LABELS = {
        complete: "Final",
        in_progress: "In progress",
        not_played: "Not played yet",
        unknown: "Status unknown",
    };

    // Why a lineup could not be graded, in words rather than a reason code.
    const LINEUP_REASONS = {
        no_lineup_settings:
            "The league's starting lineup was never collected, so nothing can be " +
            "said about who should have started.",
        no_roster_snapshot:
            "No roster snapshot was stored for this week, so there is no lineup " +
            "to measure against the best one available.",
        no_actuals:
            "No player results were collected for this week, so bench points " +
            "cannot be counted.",
        no_scorable_lineups:
            "Every lineup this week had a starter the stat feed does not cover, " +
            "so no efficiency is claimed.",
    };

    // Grades are a curve across one league, so the colour ramp is too.
    const GRADE_TIERS = { A: "great", B: "good", C: "fair", D: "poor", F: "poor" };

    const RESULT_VERBS = { win: "Won", loss: "Lost", tie: "Tied", bye: "Bye" };

    function gradeTier(grade) {
        if (!grade) return "fair";
        return GRADE_TIERS[String(grade).charAt(0).toUpperCase()] || "fair";
    }

    function statusLabel(status) {
        return STATUS_LABELS[status] || STATUS_LABELS.unknown;
    }

    function weekLabel(week) {
        return week == null ? "—" : `Week ${week}`;
    }

    function formatPoints(value) {
        if (value == null) return "—";
        const number = Number(value);
        return Number.isFinite(number) ? number.toFixed(1) : "—";
    }

    function formatSigned(value) {
        if (value == null) return "—";
        const number = Number(value);
        if (!Number.isFinite(number)) return "—";
        if (Math.abs(number) < 0.05) return "even";
        return `${number > 0 ? "+" : ""}${number.toFixed(1)}`;
    }

    function formatPercent(value) {
        if (value == null) return "—";
        const number = Number(value);
        return Number.isFinite(number) ? `${(number * 100).toFixed(0)}%` : "—";
    }

    // An all-play record reads as a record, not as a rate: "7–2" is what a
    // manager argues with, and the percentage is the tiebreaker under it.
    function formatAllPlay(record) {
        if (!record) return "—";
        const parts = [record.wins, record.losses];
        if (record.ties) parts.push(record.ties);
        return parts.join("–");
    }

    // The line under a team's name: what happened, against whom, by how much.
    function resultLine(row) {
        if (!row) return "";
        const verb = RESULT_VERBS[row.result];
        if (!verb || row.result === "bye") return verb || "";
        const opponent = row.opponent || {};
        if (!opponent.name || row.points == null || opponent.points == null) {
            return verb;
        }
        return `${verb} ${formatPoints(row.points)}–${formatPoints(opponent.points)} vs ${opponent.name}`;
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

    // Power-ranking movement, as an arrow rather than a signed integer nobody
    // can read at a glance. Positive means the team moved up.
    function movementLabel(power) {
        if (!power || !power.rank) return "";
        const delta = power.rank_delta;
        if (!delta) return `Power ${power.rank}`;
        const arrow = delta > 0 ? "▲" : "▼";
        return `Power ${power.rank} ${arrow}${Math.abs(delta)}`;
    }

    // The recap has to be able to say why half of it is missing.
    function lineupNote(lineups) {
        if (!lineups) return "";
        if (lineups.available) {
            const excluded = lineups.excluded_slots || [];
            return excluded.length
                ? `Lineup efficiency excludes ${excluded.join(", ")}: the stat feed scores individual players, not team defenses.`
                : "Lineup efficiency is measured on what players actually scored.";
        }
        return LINEUP_REASONS[lineups.reason] || "";
    }

    function sortTeams(rows, key, direction) {
        const factor = direction === "asc" ? 1 : -1;
        const value = (row) => {
            switch (key) {
                case "team":
                    return row.team || "";
                case "points":
                    return row.points == null ? -Infinity : row.points;
                case "projected":
                    return row.vs_projection == null ? -Infinity : row.vs_projection;
                case "optimal":
                    return row.optimal == null ? -Infinity : row.optimal;
                case "efficiency":
                    return row.efficiency == null ? -Infinity : row.efficiency;
                case "bench":
                    return row.points_left == null ? -Infinity : row.points_left;
                case "all_play":
                    return (row.all_play && row.all_play.pct) == null
                        ? -Infinity
                        : row.all_play.pct;
                default:
                    return row.composite == null ? -Infinity : row.composite;
            }
        };
        return rows.slice().sort((a, b) => {
            const left = value(a);
            const right = value(b);
            if (typeof left === "string" || typeof right === "string") {
                return String(left).localeCompare(String(right)) * factor;
            }
            if (left === right) return (b.composite || 0) - (a.composite || 0);
            return (left < right ? -1 : 1) * factor;
        });
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
        LINEUP_REASONS,
        awardsForTeam,
        componentBarWidth,
        componentBlurb,
        componentLabel,
        formatAllPlay,
        formatPercent,
        formatPoints,
        formatSigned,
        gradeTier,
        lineupNote,
        movementLabel,
        resultLine,
        sortTeams,
        statusLabel,
        weekLabel,
    };
});
