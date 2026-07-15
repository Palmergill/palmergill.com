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
    function rankDelta(previousRank, currentRank) {
        if (previousRank == null || currentRank == null) return null;
        const change = Number(previousRank) - Number(currentRank);
        if (change === 0) return { direction: "same", amount: 0 };
        return { direction: change > 0 ? "up" : "down", amount: Math.abs(change) };
    }

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

    // Spread from the home team's perspective. 0 is a pick'em ("PK").
    function formatSpread(point) {
        if (point === null || point === undefined || Number.isNaN(Number(point))) return "—";
        const n = Number(point);
        if (n === 0) return "PK";
        return n > 0 ? `+${n}` : String(n);
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
        scoringLabel,
        formatPoints,
        ordinal,
        rankDelta,
        sparkline,
        americanOdds,
        formatSpread,
        formatSigned,
    };
});
