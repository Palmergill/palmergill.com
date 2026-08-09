// Pure formatting/derivation helpers for the league hub.
//
// Kept free of DOM/network so they can be unit-tested under node and reused
// by app.js (browser) via window.LeagueFormat. No dependencies.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.LeagueFormat = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const ALGORITHM_LABELS = {
        composite: "Composite",
        record: "Record",
        points_differential: "Point diff",
        strength_of_schedule: "Schedule",
        consistency: "Consistency",
        recent_form: "Recent form",
        head_to_head: "Head to head",
    };

    // Starters first, in lineup order; bench and IR sink to the bottom.
    const SLOT_ORDER = {
        QB: 0,
        RB: 1,
        WR: 2,
        TE: 3,
        FLEX: 4,
        "RB/WR": 4,
        "WR/TE": 4,
        OP: 5,
        DST: 6,
        K: 7,
        BENCH: 90,
        IR: 95,
    };
    const BENCH_SLOTS = ["BENCH", "IR"];

    function algorithmLabel(key) {
        return ALGORITHM_LABELS[key] || key;
    }

    function recordLabel(wins, losses, ties) {
        const w = wins || 0;
        const l = losses || 0;
        const t = ties || 0;
        return t ? `${w}-${l}-${t}` : `${w}-${l}`;
    }

    // Ties count as half a win, matching how ESPN computes the percentage.
    function winPct(wins, losses, ties) {
        const games = (wins || 0) + (losses || 0) + (ties || 0);
        if (!games) return null;
        return ((wins || 0) + 0.5 * (ties || 0)) / games;
    }

    function formatPct(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return "—";
        }
        return Number(value).toFixed(3).replace(/^0/, "");
    }

    function formatPoints(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return "—";
        }
        return Number(value).toFixed(1);
    }

    function formatSigned(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return "—";
        }
        const number = Number(value);
        return `${number > 0 ? "+" : ""}${number.toFixed(1)}`;
    }

    // Guards against 0/0 -> NaN and n/0 -> Infinity on a team with no games.
    function pointsPerGame(pointsFor, games) {
        if (!games) return null;
        const value = Number(pointsFor) / Number(games);
        return Number.isFinite(value) ? value : null;
    }

    function streakLabel(length, type) {
        if (!length || !type || type === "NONE") return "—";
        const initial = String(type).charAt(0).toUpperCase();
        return `${initial}${length}`;
    }

    // Four distinct states, including "no previous week to compare against".
    function rankMovement(delta) {
        if (delta === null || delta === undefined) {
            return { direction: "none", label: "—", value: 0 };
        }
        const value = Number(delta);
        if (!value) return { direction: "flat", label: "—", value: 0 };
        if (value > 0) return { direction: "up", label: `▲ ${value}`, value };
        return { direction: "down", label: `▼ ${Math.abs(value)}`, value };
    }

    function seedLabel(seed, playoffTeamCount) {
        if (!seed) return "";
        if (playoffTeamCount && seed <= playoffTeamCount) return `#${seed}`;
        return `${seed}`;
    }

    function isStarter(entry) {
        return BENCH_SLOTS.indexOf(entry.lineup_slot) === -1;
    }

    function sortRoster(entries) {
        return (entries || []).slice().sort((a, b) => {
            const orderA = SLOT_ORDER[a.lineup_slot];
            const orderB = SLOT_ORDER[b.lineup_slot];
            const rankA = orderA === undefined ? 50 : orderA;
            const rankB = orderB === undefined ? 50 : orderB;
            if (rankA !== rankB) return rankA - rankB;
            return String(a.name || "").localeCompare(String(b.name || ""));
        });
    }

    function splitRoster(entries) {
        const sorted = sortRoster(entries);
        return {
            starters: sorted.filter((entry) => isStarter(entry)),
            bench: sorted.filter((entry) => entry.lineup_slot === "BENCH"),
            ir: sorted.filter((entry) => entry.lineup_slot === "IR"),
        };
    }

    function groupByDivision(teams, divisions) {
        const names = {};
        (divisions || []).forEach((division) => {
            names[division.id] = division.name;
        });
        const groups = [];
        const index = {};
        (teams || []).forEach((team) => {
            const key = team.division_id === null || team.division_id === undefined
                ? "none"
                : team.division_id;
            if (!index[key]) {
                index[key] = {
                    division_id: team.division_id,
                    // Fall back to the team's own label, then a generic one:
                    // a division id we have no name for still needs a header.
                    division_name: team.division_name || names[team.division_id] || "Division",
                    teams: [],
                };
                groups.push(index[key]);
            }
            index[key].teams.push(team);
        });
        return groups;
    }

    // How one matchup looked from a given team's side.
    function matchupResult(matchup, teamId) {
        if (!matchup) return null;
        const isHome = matchup.home && matchup.home.espn_team_id === teamId;
        const side = isHome ? matchup.home : matchup.away;
        const other = isHome ? matchup.away : matchup.home;
        if (!side) return null;
        if (matchup.is_bye) {
            return { outcome: "BYE", points: side.points, opponent: null, margin: null };
        }
        let outcome = null;
        if (matchup.is_complete) {
            if (matchup.winner === "TIE") {
                outcome = "T";
            } else {
                const won = (matchup.winner === "HOME") === isHome;
                outcome = won ? "W" : "L";
            }
        }
        const margin =
            side.points !== null && side.points !== undefined &&
            other && other.points !== null && other.points !== undefined
                ? side.points - other.points
                : null;
        return { outcome, points: side.points, opponent: other, margin };
    }

    function seasonLabel(season, status) {
        if (status === "unauthorized") return `${season} · private`;
        if (status && status !== "ok") return `${season} · unavailable`;
        return String(season);
    }

    function modeLabel(mode) {
        if (mode === "preseason") return "Preseason";
        if (mode === "live") return "In season";
        return "";
    }

    function formatAsOf(iso) {
        if (!iso) return "";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        return `as of ${date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
        })}`;
    }

    // Width of a 0-1 normalized score as a percentage, clamped so a bar can
    // never render outside its track.
    function powerBar(score) {
        const value = Number(score);
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(100, value * 100));
    }

    // Dependency-free SVG path for a rank sparkline. Ranks invert (1 is best)
    // so the line reads the way people expect: up means improving.
    function sparkline(ranks, width, height, pad) {
        const values = (ranks || []).filter((value) => Number.isFinite(Number(value)));
        if (values.length < 2) return "";
        const w = width || 80;
        const h = height || 24;
        const p = pad === undefined ? 2 : pad;
        const best = Math.min.apply(null, values);
        const worst = Math.max.apply(null, values);
        const span = worst - best || 1;
        const step = (w - p * 2) / (values.length - 1);
        return values
            .map((value, index) => {
                const x = p + step * index;
                const y = p + ((value - best) / span) * (h - p * 2);
                return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
    }

    function injuryBadge(status) {
        if (!status) return "";
        const normalized = String(status).toUpperCase();
        if (normalized === "ACTIVE" || normalized === "NORMAL") return "";
        const short = {
            QUESTIONABLE: "Q",
            DOUBTFUL: "D",
            OUT: "O",
            INJURY_RESERVE: "IR",
            SUSPENSION: "SUS",
        };
        return short[normalized] || normalized.charAt(0);
    }

    return {
        ALGORITHM_LABELS,
        SLOT_ORDER,
        BENCH_SLOTS,
        algorithmLabel,
        recordLabel,
        winPct,
        formatPct,
        formatPoints,
        formatSigned,
        pointsPerGame,
        streakLabel,
        rankMovement,
        seedLabel,
        isStarter,
        sortRoster,
        splitRoster,
        groupByDivision,
        matchupResult,
        seasonLabel,
        modeLabel,
        formatAsOf,
        powerBar,
        sparkline,
        injuryBadge,
    };
});
