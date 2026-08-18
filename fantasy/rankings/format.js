// Pure ordering/derivation helpers for personal ranking boards (spec 18).
//
// Kept free of DOM/network so they can be unit-tested under node and reused by
// app.js (browser) via window.RankingsFormat. No dependencies.
//
// The important one is projectOverallMove. A board holds a single ordered
// array — the QB list is that array filtered to QBs — so a move made inside a
// positional list has to be translated into an index in the overall array. Get
// that translation wrong and nothing throws; a player just quietly lands
// somewhere the person did not put him. It lives here, out of the controller,
// so it can be tested from both sides.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.RankingsFormat = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const POSITIONS = ["QB", "RB", "WR", "TE"];
    const SCOPES = ["OVERALL"].concat(POSITIONS);
    const SCOPE_LABELS = {
        OVERALL: "Overall",
        QB: "Quarterbacks",
        RB: "Running backs",
        WR: "Receivers",
        TE: "Tight ends",
    };
    const SCORING_LABELS = { ppr: "PPR", half: "Half PPR", std: "Standard" };
    const ROSTER_LABELS = { "1qb": "1QB", superflex: "Superflex" };

    // Mirrors KEY_STEP in fantasy_rankings_board.py.
    const KEY_STEP = 1000;
    const MIN_GAP = 1e-6;

    function scoringLabel(key) {
        return SCORING_LABELS[key] || key;
    }

    function rosterLabel(key) {
        return ROSTER_LABELS[key] || key;
    }

    function formatLabel(scoring, roster) {
        return `${scoringLabel(scoring)} · ${rosterLabel(roster)}`;
    }

    function boardLabel(board) {
        if (!board) return "";
        return `${board.season} · ${formatLabel(board.scoring, board.roster)}`;
    }

    function scopeLabel(scope) {
        return SCOPE_LABELS[scope] || scope;
    }

    // Entries filtered to one scope, still in overall order.
    function scopeEntries(entries, scope) {
        const list = entries || [];
        return scope === "OVERALL" ? list.slice() : list.filter((e) => e.position === scope);
    }

    // Dense 1..n, gapless. Storage order is sparse; display rank never is.
    function denseRanks(entries) {
        const ranks = {};
        (entries || []).forEach((entry, index) => {
            ranks[entry.player_id] = index + 1;
        });
        return ranks;
    }

    // "RB4" for every entry, derived from the overall array alone.
    function positionRanks(entries) {
        const seen = {};
        const labels = {};
        (entries || []).forEach((entry) => {
            seen[entry.position] = (seen[entry.position] || 0) + 1;
            labels[entry.player_id] = `${entry.position}${seen[entry.position]}`;
        });
        return labels;
    }

    // Move one id to a new index. Returns a new array; never mutates the input.
    function moveWithin(order, playerId, targetIndex) {
        const list = (order || []).slice();
        const from = list.indexOf(playerId);
        if (from === -1) return list;
        list.splice(from, 1);
        const to = Math.max(0, Math.min(targetIndex, list.length));
        list.splice(to, 0, playerId);
        return list;
    }

    // Where a move made inside a positional list lands in the overall array.
    //
    // Landing at positional index i means landing immediately above whoever
    // currently holds that positional slot, wherever he happens to sit overall.
    // That is the only placement that changes this player's order relative to
    // his own position and to nobody else — which is what keeps the overall and
    // positional orders from ever disagreeing.
    function projectOverallMove(overallOrder, playerId, position, targetPositionIndex) {
        const overall = (overallOrder || []).map((e) => (typeof e === "string" ? e : e.player_id));
        const positions = {};
        (overallOrder || []).forEach((e) => {
            if (typeof e !== "string") positions[e.player_id] = e.position;
        });

        const remaining = overall.filter((id) => id !== playerId);
        const scoped = remaining.filter((id) => positions[id] === position);
        const index = Math.max(0, Math.min(targetPositionIndex, scoped.length));

        if (!scoped.length) return remaining.length;
        if (index >= scoped.length) {
            // Below the last player at this position, but immediately below him
            // rather than at the bottom of the whole board.
            return remaining.indexOf(scoped[scoped.length - 1]) + 1;
        }
        return remaining.indexOf(scoped[index]);
    }

    // The client-side mirror of the server's key math, used only to predict
    // where an optimistic move will land. null means the gap between these two
    // neighbours is used up: stop predicting and take the server's order, which
    // will have been respread.
    function midpointKey(prevKey, nextKey) {
        const low = typeof prevKey === "number" ? prevKey : null;
        const high = typeof nextKey === "number" ? nextKey : null;
        if (low === null && high === null) return KEY_STEP;
        if (low === null) return high - KEY_STEP;
        if (high === null) return low + KEY_STEP;
        if (high - low < MIN_GAP) return null;
        return (low + high) / 2;
    }

    // Merge entries and same-scope dividers into rendered bands. The leading
    // band (players above the first divider) has a null tier.
    function tierBands(entries, tiers, scope) {
        const scoped = scopeEntries(entries, scope);
        const dividers = (tiers || []).filter((t) => t.scope === scope);
        const byPlayer = {};
        dividers.forEach((tier) => {
            if (tier.beforePlayerId) {
                byPlayer[tier.beforePlayerId] = (byPlayer[tier.beforePlayerId] || []).concat(tier);
            }
        });

        const bands = [{ tier: null, players: [] }];
        scoped.forEach((entry) => {
            (byPlayer[entry.player_id] || []).forEach((tier) => {
                bands.push({ tier, players: [] });
            });
            bands[bands.length - 1].players.push(entry);
        });
        // A divider pinned past the last player still shows, so it can be
        // labelled and dragged rather than silently vanishing.
        dividers
            .filter((tier) => !tier.beforePlayerId)
            .forEach((tier) => bands.push({ tier, players: [] }));

        return bands.filter((band, index) => index === 0 ? band.players.length > 0 : true);
    }

    // Plan a pointer drop in the list the user actually sees: players and tier
    // dividers together. A dense player rank cannot describe crossing a tier
    // without also passing a player, so the result names an adjacent tier when
    // there is one and falls back to a dense rank otherwise.
    function planCombinedPlayerMove(entries, tiers, scope, playerId, targetIndex) {
        const original = [];
        tierBands(entries, tiers, scope).forEach((band) => {
            if (band.tier) original.push({ kind: "tier", value: band.tier });
            band.players.forEach((entry) => original.push({ kind: "player", value: entry }));
        });
        const from = original.findIndex(
            (item) => item.kind === "player" && item.value.player_id === playerId
        );
        if (from === -1) return null;

        const mover = original[from];
        const arranged = original.filter((_, index) => index !== from);
        const bounded = Math.max(0, Math.min(targetIndex, arranged.length));
        arranged.splice(bounded, 0, mover);
        const unchanged = arranged.every((item, index) => item === original[index]);

        const playerIndex = arranged
            .slice(0, bounded)
            .filter((item) => item.kind === "player").length;
        const tierAnchors = {};
        arranged.forEach((item, index) => {
            if (item.kind !== "tier") return;
            const following = arranged
                .slice(index + 1)
                .find((candidate) => candidate.kind === "player");
            tierAnchors[item.value.id] = following ? following.value.player_id : null;
        });

        const previous = arranged[bounded - 1];
        const next = arranged[bounded + 1];
        let placement;
        if (previous && previous.kind === "tier") {
            placement = { after_tier_id: previous.value.id };
        } else if (next && next.kind === "tier") {
            placement = { before_tier_id: next.value.id };
        } else {
            placement = { to_rank: playerIndex + 1 };
        }
        return { unchanged, playerIndex, tierAnchors, placement, previous, next };
    }

    // The single sentence announced after any move, however it was made.
    function describeMove(name, fromRank, toRank, positionLabel) {
        const who = name || "Player";
        if (fromRank === toRank) return `${who} stayed at ${toRank}.`;
        const direction = toRank < fromRank ? "up" : "down";
        const tail = positionLabel ? ` Now ${positionLabel}.` : "";
        return `${who} moved ${direction} from ${fromRank} to ${toRank}.${tail}`;
    }

    // "3–11" — how far apart published boards are on one player.
    function consensusSpread(row) {
        if (!row || row.best == null || row.worst == null) return "—";
        return row.best === row.worst ? String(row.best) : `${row.best}–${row.worst}`;
    }

    function formatSavedAt(date, now) {
        if (!date) return "";
        const then = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(then.getTime())) return "";
        const seconds = Math.max(0, Math.round(((now || new Date()) - then) / 1000));
        if (seconds < 5) return "Saved just now";
        if (seconds < 60) return `Saved ${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `Saved ${minutes}m ago`;
        return `Saved ${Math.round(minutes / 60)}h ago`;
    }

    // Movement against where the seed put him, for the "vs consensus" column.
    function seedDelta(entry) {
        if (!entry || entry.seedOverallRank == null) return null;
        return entry.seedOverallRank - entry.overallRank;
    }

    function formatSigned(value) {
        if (value == null || value === 0) return "—";
        return value > 0 ? `+${value}` : String(value);
    }

    return {
        POSITIONS,
        SCOPES,
        SCOPE_LABELS,
        KEY_STEP,
        scoringLabel,
        rosterLabel,
        formatLabel,
        boardLabel,
        scopeLabel,
        scopeEntries,
        denseRanks,
        positionRanks,
        moveWithin,
        projectOverallMove,
        midpointKey,
        tierBands,
        planCombinedPlayerMove,
        describeMove,
        consensusSpread,
        formatSavedAt,
        seedDelta,
        formatSigned,
    };
});
