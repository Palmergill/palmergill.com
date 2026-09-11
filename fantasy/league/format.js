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

    // The rooms a roster is read in, in display order. These mirror
    // fantasy_league_advanced.ROOMS on the server, which is what lets a room's
    // players and its league-wide measurement be joined by position key.
    // Kicker and defense stay apart: only one of them has an actuals feed.
    const ROOMS = [
        { position: "QB", label: "Quarterback", positions: ["QB"] },
        { position: "RB", label: "Running back", positions: ["RB"] },
        { position: "WR", label: "Wide receiver", positions: ["WR"] },
        { position: "TE", label: "Tight end", positions: ["TE"] },
        { position: "K", label: "Kicker", positions: ["K", "PK"] },
        { position: "DST", label: "Defense", positions: ["DEF", "DST", "D/ST"] },
    ];

    function roomKey(position) {
        const upper = String(position || "").toUpperCase();
        const room = ROOMS.find((entry) => entry.positions.indexOf(upper) !== -1);
        return room ? room.position : null;
    }

    // Rooms key on what a player *is*, not on the slot he happens to fill, so
    // a receiver in the flex is read with the other receivers. Empty rooms are
    // dropped rather than printed as a heading with nothing under it.
    function groupByPosition(entries) {
        const sorted = sortRoster(entries);
        const buckets = {};
        const unplaced = [];
        sorted.forEach((entry) => {
            const key = roomKey(entry.position);
            if (key === null) {
                unplaced.push(entry);
                return;
            }
            (buckets[key] = buckets[key] || []).push(entry);
        });
        const rooms = ROOMS.filter((room) => buckets[room.position]).map((room) => ({
            position: room.position,
            label: room.label,
            entries: buckets[room.position],
        }));
        if (unplaced.length) {
            rooms.push({ position: null, label: "Other", entries: unplaced });
        }
        return rooms;
    }

    function ordinal(value) {
        const number = finite(value);
        if (number === null) return "—";
        const rounded = Math.round(number);
        const tens = Math.abs(rounded) % 100;
        const suffix =
            tens >= 11 && tens <= 13
                ? "th"
                : { 1: "st", 2: "nd", 3: "rd" }[Math.abs(rounded) % 10] || "th";
        return `${rounded}${suffix}`;
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

    // ── the ledger's switchable column ──────────────────────────────
    //
    // Standings, power rankings and rosters used to be three lists of the
    // same ten teams. They are one table now, and this is the column that
    // changes: each entry knows how to read its measure out of a row, how to
    // print it, and which chart form carries it. On a phone that chart rides
    // inside the row, which is what lets a ten-column table survive 390px.
    const LEDGER_COLUMNS = [
        { key: "record", label: "Record", header: "W-L", chart: "none" },
        { key: "points_for", label: "Points", header: "PF", chart: "none" },
        { key: "all_play", label: "All-play", header: "Record vs all", chart: "meter" },
        { key: "luck", label: "Luck", header: "W − xW", chart: "diverging" },
        { key: "lineup", label: "Lineup", header: "% of best", chart: "dot" },
        { key: "scoring", label: "Range", header: "Low–high", chart: "range" },
        { key: "power", label: "Power", header: "Rank", chart: "spark" },
        { key: "odds", label: "Playoff odds", header: "Odds", chart: "meter" },
    ];

    function ledgerColumn(key) {
        return LEDGER_COLUMNS.find((column) => column.key === key) || LEDGER_COLUMNS[0];
    }

    // The number the column sorts on. Always "higher is better", so a rank
    // (where 1 is best) comes back negated rather than needing a per-column
    // sort direction.
    function ledgerValue(row, key) {
        if (!row) return null;
        switch (key) {
            case "record":
                return winPct(row.wins, row.losses, row.ties);
            case "points_for":
                return row.points_for === null || row.points_for === undefined
                    ? null
                    : Number(row.points_for);
            case "all_play":
                return row.all_play && row.all_play.games ? row.all_play.win_pct : null;
            case "luck":
                return row.luck === null || row.luck === undefined ? null : Number(row.luck);
            case "lineup":
                return row.lineup ? row.lineup.efficiency : null;
            case "scoring":
                return row.scoring ? row.scoring.median : null;
            case "power":
                return row.power && row.power.rank ? -row.power.rank : null;
            case "odds":
                return row.playoff ? row.playoff.odds : null;
            default:
                return null;
        }
    }

    // What the column prints. Separate from ledgerValue because a rank sorts
    // as a negative and prints as "3".
    function ledgerText(row, key) {
        if (!row) return "—";
        switch (key) {
            case "record":
                return recordLabel(row.wins, row.losses, row.ties);
            case "points_for":
                return formatPoints(row.points_for);
            case "all_play":
                return row.all_play && row.all_play.games
                    ? recordLabel(row.all_play.wins, row.all_play.losses, row.all_play.ties)
                    : "—";
            case "luck":
                return row.luck === null || row.luck === undefined
                    ? "—"
                    : formatSigned(row.luck);
            case "lineup":
                return row.lineup && row.lineup.efficiency !== null &&
                    row.lineup.efficiency !== undefined
                    ? `${(row.lineup.efficiency * 100).toFixed(1)}%`
                    : "—";
            case "scoring":
                return row.scoring && row.scoring.median !== null &&
                    row.scoring.median !== undefined
                    ? formatPoints(row.scoring.median)
                    : "—";
            case "power":
                return row.power && row.power.rank ? String(row.power.rank) : "—";
            case "odds":
                return row.playoff && row.playoff.odds !== null &&
                    row.playoff.odds !== undefined
                    ? `${Math.round(row.playoff.odds * 100)}%`
                    : "—";
            default:
                return "—";
        }
    }

    // The muted line under the name: whatever context makes the number mean
    // something without opening a second view.
    function ledgerMeta(row, key) {
        if (!row) return "";
        const record = recordLabel(row.wins, row.losses, row.ties);
        switch (key) {
            case "all_play":
                return row.expected_wins === null || row.expected_wins === undefined
                    ? record
                    : `${record} · ${row.expected_wins.toFixed(1)} expected wins`;
            case "luck":
                return row.all_play && row.all_play.games
                    ? `${record} · ${recordLabel(
                          row.all_play.wins,
                          row.all_play.losses,
                          row.all_play.ties
                      )} all-play`
                    : record;
            case "lineup":
                return row.lineup && row.lineup.points_left !== null &&
                    row.lineup.points_left !== undefined
                    ? `${formatPoints(row.lineup.points_left)} pts left on the bench`
                    : record;
            case "scoring":
                return row.scoring && row.scoring.low !== null && row.scoring.low !== undefined
                    ? `${formatPoints(row.scoring.low)} to ${formatPoints(row.scoring.high)}`
                    : record;
            case "odds":
                return row.playoff && row.playoff.projected_wins !== null &&
                    row.playoff.projected_wins !== undefined
                    ? `projected ${Math.round(row.playoff.projected_wins)}-${Math.round(
                          row.playoff.projected_losses
                      )}`
                    : record;
            case "power":
                return `${record} · ${rankMovement(row.power && row.power.rank_delta).label}`;
            default:
                return `${record} · ${formatPoints(row.points_for)} PF`;
        }
    }

    // Nulls sink, whichever column is showing: a team the measure cannot be
    // computed for is not "worst", it is unknown, and floating it to the top
    // of a descending sort would read as a result.
    function sortLedger(rows, key) {
        return (rows || []).slice().sort((a, b) => {
            const left = ledgerValue(a, key);
            const right = ledgerValue(b, key);
            const leftMissing = left === null || left === undefined;
            const rightMissing = right === null || right === undefined;
            if (leftMissing && rightMissing) return 0;
            if (leftMissing) return 1;
            if (rightMissing) return -1;
            if (right !== left) return right - left;
            return (b.points_for || 0) - (a.points_for || 0);
        });
    }

    // ── chart geometry ──────────────────────────────────────────────

    // `Number(null)` is 0, so every geometry helper has to reject a missing
    // value explicitly. Without this a team whose measure could not be
    // computed draws a dot hard against the bottom of the axis, which reads
    // as "worst in the league" rather than "unknown".
    function finite(value) {
        if (value === null || value === undefined || value === "") return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    // A diverging bar reads its polarity from which side of the zero rule it
    // sits on, so colour is never the only channel.
    function divergingBar(value, maxAbs, reach) {
        const number = finite(value);
        const span = Math.abs(finite(maxAbs) || 0) || 1;
        const limit = reach === undefined ? 46 : reach;
        if (number === null || number === 0) {
            return { side: "zero", width: 0 };
        }
        const width = Math.min(limit, (Math.abs(number) / span) * limit);
        return { side: number > 0 ? "positive" : "negative", width };
    }

    // Position, not length, so a window that does not start at zero stays
    // honest — which is why lineup efficiency is a dot plot and not a bar.
    function dotPosition(value, min, max) {
        const number = finite(value);
        const lo = finite(min);
        const hi = finite(max);
        if (number === null || lo === null || hi === null) return null;
        if (hi === lo) return 50;
        return Math.max(0, Math.min(100, ((number - lo) / (hi - lo)) * 100));
    }

    function rangeBand(low, high, min, max) {
        const left = dotPosition(low, min, max);
        const right = dotPosition(high, min, max);
        if (left === null || right === null) return null;
        return { left: Math.min(left, right), width: Math.abs(right - left) };
    }

    // Round outward to a step so the axis labels are readable numbers and
    // the marks are not jammed against the ends of the track.
    function niceAxis(values, step) {
        const numbers = (values || [])
            .map(finite)
            .filter((value) => value !== null);
        if (!numbers.length) return null;
        const size = finite(step) || 1;
        let low = Math.min.apply(null, numbers);
        let high = Math.max.apply(null, numbers);
        const pad = (high - low) * 0.12 || size;
        low = Math.floor((low - pad) / size) * size;
        high = Math.ceil((high + pad) / size) * size;
        if (high === low) high = low + size;
        return { min: low, max: high };
    }

    function maxAbs(values) {
        const numbers = (values || [])
            .map(finite)
            .filter((value) => value !== null);
        if (!numbers.length) return 0;
        return numbers.reduce((best, value) => Math.max(best, Math.abs(value)), 0);
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

    // "4.2k" — an add count is a magnitude, and five digits of it crowds out
    // the player's name on a phone.
    function compactCount(value) {
        if (value === null || value === undefined) return "";
        const count = Number(value);
        if (!Number.isFinite(count)) return "";
        if (Math.abs(count) < 1000) return String(Math.round(count));
        const thousands = count / 1000;
        const rounded = Math.abs(thousands) >= 10
            ? Math.round(thousands)
            : Math.round(thousands * 10) / 10;
        return `${rounded}k`;
    }

    return {
        ALGORITHM_LABELS,
        SLOT_ORDER,
        BENCH_SLOTS,
        LEDGER_COLUMNS,
        ledgerColumn,
        ledgerValue,
        ledgerText,
        ledgerMeta,
        sortLedger,
        divergingBar,
        dotPosition,
        rangeBand,
        niceAxis,
        maxAbs,
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
        ROOMS,
        groupByPosition,
        ordinal,
        groupByDivision,
        matchupResult,
        seasonLabel,
        modeLabel,
        formatAsOf,
        powerBar,
        sparkline,
        injuryBadge,
        compactCount,
    };
});
