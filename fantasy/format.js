// Pure formatting/derivation helpers for the fantasy dashboard.
//
// Kept free of DOM/network so they can be unit-tested under jsdom and reused
// by app.js (browser) via window.FantasyFormat. No dependencies.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.FantasyFormat = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DST"];
    const SEASON_POSITION_ORDER = ["QB", "RB", "WR", "TE"];
    const SCORINGS = [
        { key: "ppr", label: "PPR" },
        { key: "half", label: "Half" },
        { key: "std", label: "Standard" },
    ];

    // Sleeper stores team defenses as DEF; the UI shows DST.
    function positionLabel(position) {
        return position === "DEF" ? "DST" : position;
    }

    function positionQuery(position) {
        return position === "DST" ? "DEF" : position;
    }

    // Which positions a season board can be filtered to, in depth-chart order
    // and with a count each. Derived from the rows rather than POSITIONS: the
    // season markets only quote passing, rushing, receiving and touchdowns, so
    // kickers and defenses never appear, and which of QB/RB/WR/TE are quoted
    // shifts with the market and with the category being viewed.
    function seasonPositionCounts(leaders) {
        const counts = new Map();
        (leaders || []).forEach((entry) => {
            const player = (entry && entry.player) || {};
            const position = String(player.position || "").toUpperCase();
            if (!position) return;
            counts.set(position, (counts.get(position) || 0) + 1);
        });
        const ordered = SEASON_POSITION_ORDER.filter((position) => counts.has(position));
        const extra = [...counts.keys()]
            .filter((position) => !SEASON_POSITION_ORDER.includes(position))
            .sort();
        return [...ordered, ...extra].map((position) => ({ position, count: counts.get(position) }));
    }

    // What a market-implied total was actually built from. A category scores
    // only when both its yardage and touchdown markets are quoted, so "4
    // markets" told the reader nothing: naming the categories is the
    // difference between a running quarterback whose rushing is in the number
    // and one whose rushing was dropped for want of a touchdown ladder.
    function seasonPairDetail(pairsUsed, partialPairs) {
        const used = (pairsUsed || []).filter(Boolean);
        const partial = (partialPairs || []).filter(Boolean);
        return {
            scored: used.join(" + "),
            missing: partial.length ? `${partial.join(" and ")} not fully quoted` : "",
        };
    }

    function seasonPositionMatches(entry, position) {
        if (!position || position === "ALL") return true;
        const player = (entry && entry.player) || {};
        return String(player.position || "").toUpperCase() === position;
    }

    function scoringLabel(key) {
        const found = SCORINGS.find((s) => s.key === key);
        return found ? found.label : "PPR";
    }

    function formatPoints(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return "—";
        }
        return Number(value).toFixed(1);
    }

    function ordinal(n) {
        const num = Number(n);
        if (!Number.isFinite(num)) return String(n);
        const abs = Math.abs(num) % 100;
        if (abs >= 11 && abs <= 13) return `${num}th`;
        switch (abs % 10) {
            case 1: return `${num}st`;
            case 2: return `${num}nd`;
            case 3: return `${num}rd`;
            default: return `${num}th`;
        }
    }

    // Rank movement between two weeks. A *smaller* rank number is better, so a
    // drop in rank value is an upward ("up") move. Returns null when either
    // rank is missing (e.g. a newly ranked player).
    // Build an SVG polyline `points` string for a sparkline of the given
    // series, scaled to fit [0,width] x [0,height] with the newest value on
    // the right. Flat series render as a centered horizontal line. Returns
    // null when there is nothing meaningful to draw (<2 points).
    function sparkline(values, width, height, pad) {
        const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
        if (nums.length < 2) return null;
        const padding = pad == null ? 2 : pad;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const span = max - min;
        const usableW = width - padding * 2;
        const usableH = height - padding * 2;
        const points = nums.map((value, index) => {
            const x = padding + (usableW * index) / (nums.length - 1);
            const y = span === 0
                ? padding + usableH / 2
                : padding + usableH * (1 - (value - min) / span);
            return `${round2(x)},${round2(y)}`;
        });
        return { points: points.join(" "), min, max, first: nums[0], last: nums[nums.length - 1] };
    }

    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    // American odds: positive prices get an explicit "+", negatives keep the
    // "-". Missing/zero -> em dash.
    function americanOdds(price) {
        if (price === null || price === undefined || Number.isNaN(Number(price)) || Number(price) === 0) {
            return "—";
        }
        const n = Math.round(Number(price));
        return n > 0 ? `+${n}` : String(n);
    }

    // A season threshold. These run to four figures, so they get separators;
    // the trailing .5 is the point of the number and always survives.
    function seasonLine(point) {
        if (point === null || point === undefined || Number.isNaN(Number(point))) return "—";
        return Number(point).toLocaleString(undefined, {
            minimumFractionDigits: Number.isInteger(Number(point)) ? 0 : 1,
            maximumFractionDigits: 1,
        });
    }

    // The market's own probability that a line is cleared. Shown as a whole
    // percent: the quote it came from is a midpoint of a bid and an ask, and
    // a decimal place would dress that up as more precision than it has.
    function impliedChance(probability) {
        if (probability === null || probability === undefined) return "—";
        const value = Number(probability);
        if (Number.isNaN(value)) return "—";
        return `${Math.round(value * 100)}%`;
    }

    // Spread from the home team's perspective. 0 is a pick'em ("PK").
    function formatSpread(point) {
        if (point === null || point === undefined || Number.isNaN(Number(point))) return "—";
        const n = Number(point);
        if (n === 0) return "PK";
        return n > 0 ? `+${n}` : String(n);
    }

    // Article timestamp -> short display date ("Jul 10", or "Jul 10, 2025"
    // when it isn't this year). Unparseable/missing -> "".
    function formatArticleDate(iso) {
        if (!iso) return "";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        const options = { month: "short", day: "numeric" };
        if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
        return date.toLocaleDateString("en-US", options);
    }

    // Collector run timestamp -> "as of Jul 10". Unparseable/missing -> "".
    // The server marks these UTC (see `iso_utc`); without the offset the
    // rendered day slips for any run that finished near midnight UTC.
    // How long ago a provider last moved a quote, in the coarsest honest
    // unit. Season-long boards are the reason this exists: one exchange sat
    // eleven days without a tick while the run that fetched it was minutes
    // old, and only the first of those numbers tells you anything.
    function quoteAge(iso) {
        if (!iso) return "";
        const then = new Date(iso);
        if (Number.isNaN(then.getTime())) return "";
        const days = Math.floor((Date.now() - then.getTime()) / 86400000);
        if (days <= 0) return "today";
        if (days === 1) return "1 day ago";
        return `${days} days ago`;
    }

    // "Kalshi (11 days ago) · Polymarket (today)". Naming each provider next
    // to its own age is the point: they go stale at very different rates, so
    // one combined timestamp would hide the only source that is current.
    function marketSources(sources) {
        if (!Array.isArray(sources) || !sources.length) return "";
        return sources.map((entry) => {
            const age = quoteAge(entry.quoted_at);
            return age ? `${entry.bookmaker} (${age})` : entry.bookmaker;
        }).join(" · ");
    }

    function formatAsOf(iso) {
        if (!iso) return "";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        return `as of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }

    // Injury status -> a compact badge {code, label, severity}. Returns null
    // for healthy/unknown players so callers can skip rendering.
    const INJURY_CODES = {
        questionable: { code: "Q", severity: "warn" },
        doubtful: { code: "D", severity: "bad" },
        out: { code: "O", severity: "bad" },
        ir: { code: "IR", severity: "bad" },
        pup: { code: "PUP", severity: "bad" },
        sus: { code: "SUS", severity: "bad" },
        suspension: { code: "SUS", severity: "bad" },
        na: { code: "NA", severity: "bad" },
        dnr: { code: "DNR", severity: "bad" },
    };
    function injuryBadge(status) {
        if (!status) return null;
        const key = String(status).trim().toLowerCase();
        const mapped = INJURY_CODES[key];
        if (mapped) return { code: mapped.code, label: status, severity: mapped.severity };
        return { code: String(status).slice(0, 3).toUpperCase(), label: status, severity: "warn" };
    }

    // Weekly matchup label from a rankings/detail row. "@BUF" (away), "vs BUF"
    // (home), "BYE", or "" when the schedule isn't loaded.
    function formatMatchup(row) {
        if (!row) return "";
        if (row.bye) return "BYE";
        if (!row.opponent) return "";
        return row.home ? `vs ${row.opponent}` : `@ ${row.opponent}`;
    }

    // Signed movement, e.g. +0.5 / -1.0. 0 -> "0".
    function formatSigned(delta, digits) {
        if (delta === null || delta === undefined || Number.isNaN(Number(delta))) return "";
        const n = Number(delta);
        const fixed = digits == null ? n : Number(n.toFixed(digits));
        if (fixed === 0) return "0";
        return fixed > 0 ? `+${fixed}` : String(fixed);
    }

    return {
        POSITIONS,
        SCORINGS,
        positionLabel,
        positionQuery,
        seasonPositionCounts,
        seasonPositionMatches,
        seasonPairDetail,
        scoringLabel,
        formatPoints,
        ordinal,
        sparkline,
        americanOdds,
        seasonLine,
        impliedChance,
        formatSpread,
        formatSigned,
        formatArticleDate,
        formatAsOf,
        quoteAge,
        marketSources,
        injuryBadge,
        formatMatchup,
    };
});
