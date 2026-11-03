// Castle Defense trials: many seeded variations of one day's allotment,
// played to the end, and a search for the best layout found. The server
// (backend/app/services/castle_defense.py) runs these in the same embedded
// V8 it replays runs in, a chunk at a time, to set each day's tiers and its
// best found score. Everything is seeded by the date, so a rerun gives the
// same answer.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("./castleDefenseGame.js"));
    } else {
        root.CastleDefenseTrials = factory(root.CastleDefenseGame);
    }
})(typeof self !== "undefined" ? self : this, function (G) {
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function hash(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    // How promising each tile looks for a tower and for a trap, the way a
    // player sizing up the map might judge it.
    function tileScores(map) {
        const towers = [];
        const traps = [];
        const road = [];
        for (let d = 0; d < map.length; d += 0.2) road.push(G.pointAt(map, d));
        for (let x = 0; x < G.SIZE; x++) {
            for (let y = 0; y < G.SIZE; y++) {
                if (G.isGrass(map, x, y)) {
                    const score = road.filter((p) => Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < 2).length + 0.5;
                    towers.push({ x, y, score });
                } else if (G.isRoad(map, x, y)) {
                    traps.push({ x, y, score: 1 });
                }
            }
        }
        return { towers, traps };
    }

    // Draw a tile without replacement, weighted by score^sharp (0 is uniform).
    function draw(rng, pool, used, sharp) {
        const open = pool.filter((t) => !used.has(`${t.x},${t.y}`));
        if (!open.length) return null;
        const weights = open.map((t) => Math.pow(t.score, sharp));
        let r = rng() * weights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < open.length; i++) {
            r -= weights[i];
            if (r <= 0) return open[i];
        }
        return open[open.length - 1];
    }

    // The variations, in equal shares:
    //   scatter — every piece on a random legal tile
    //   aimed   — every piece, towers leaning toward promising tiles
    //   partial — half to all of the pieces, aimed
    const KINDS = ["scatter", "aimed", "partial"];

    function trialLayout(map, scores, index) {
        const rng = mulberry32(hash(`${map.seed}:trial:${index}`));
        const kind = KINDS[index % KINDS.length];
        const sharp = kind === "scatter" ? 0 : 1 + rng() * 3;
        const pieces = [];
        Object.entries(map.allotment).forEach(([type, n]) => { for (let i = 0; i < n; i++) pieces.push(type); });
        let use = pieces;
        if (kind === "partial") {
            const keep = Math.max(1, Math.round(pieces.length * (0.5 + rng() * 0.5)));
            use = pieces.map((p) => ({ p, k: rng() })).sort((a, b) => a.k - b.k).slice(0, keep).map((o) => o.p);
        }
        const used = new Set();
        const layout = [];
        for (const type of use) {
            const tile = draw(rng, G.DEFENSES[type].kind === "trap" ? scores.traps : scores.towers, used, sharp);
            if (!tile) continue;
            used.add(`${tile.x},${tile.y}`);
            layout.push({ type, x: tile.x, y: tile.y });
        }
        if (!layout.some((d) => G.DEFENSES[d.type].kind === "tower")) {
            const type = G.TOWER_TYPES.find((t) => map.allotment[t] > 0);
            const tile = draw(rng, scores.towers, used, sharp);
            layout.push({ type, x: tile.x, y: tile.y });
        }
        return { kind, layout };
    }

    // Trials `from` to `from + count - 1` of a day: each one's kills, plus the
    // best of them with its layout.
    function runTrials(date, from, count) {
        const map = G.dailyMap(date);
        const scores = tileScores(map);
        const kills = [];
        let best = null;
        for (let i = from; i < from + count; i++) {
            const { layout } = trialLayout(map, scores, i);
            const res = G.replay(date, layout);
            if (!res.ok) throw new Error(`${date} trial ${i}: ${res.reason}`);
            kills.push(res.kills);
            if (!best || res.kills > best.kills) best = { kills: res.kills, layout };
        }
        return { kills, best };
    }

    // One tweak to a layout: move a piece to another open tile, swap two towers
    // or two traps, or put down a piece that was left out.
    function tweak(map, scores, layout, rng) {
        const out = layout.map((d) => ({ ...d }));
        const used = new Set(out.map((d) => `${d.x},${d.y}`));
        const left = { ...map.allotment };
        out.forEach((d) => { left[d.type] -= 1; });
        const spare = Object.keys(left).filter((t) => left[t] > 0);
        const roll = rng();
        if (spare.length && roll < 0.2) {
            const type = spare[Math.floor(rng() * spare.length)];
            const tile = draw(rng, G.DEFENSES[type].kind === "trap" ? scores.traps : scores.towers, used, 1);
            if (tile) out.push({ type, x: tile.x, y: tile.y });
            return out;
        }
        const a = out[Math.floor(rng() * out.length)];
        const kind = G.DEFENSES[a.type].kind;
        if (roll < 0.5) {
            const others = out.filter((d) => d !== a && d.type !== a.type && G.DEFENSES[d.type].kind === kind);
            if (others.length) {
                const b = others[Math.floor(rng() * others.length)];
                [a.type, b.type] = [b.type, a.type];
                return out;
            }
        }
        const tile = draw(rng, kind === "trap" ? scores.traps : scores.towers, used, 1);
        if (tile) {
            a.x = tile.x;
            a.y = tile.y;
        }
        return out;
    }

    // Steps `from` to `from + count - 1` of a hill climb from `start` (a layout
    // and its kills): each step tries one tweak and keeps it unless it scores
    // less. Returns where the climb got to.
    function climb(date, start, from, count) {
        const map = G.dailyMap(date);
        const scores = tileScores(map);
        let cur = start;
        for (let i = from; i < from + count; i++) {
            const rng = mulberry32(hash(`${map.seed}:climb:${i}`));
            const layout = tweak(map, scores, cur.layout, rng);
            const res = G.replay(date, layout);
            if (res.ok && res.kills >= cur.kills) cur = { kills: res.kills, layout };
        }
        return cur;
    }

    // The share of trials that fall short of tiers 2–5.
    const FAIL_SHARES = [0.4, 0.6, 0.8, 0.9];

    // Tiers 2–5 from every trial's kills. Ties at the bottom can stack two
    // cut-offs on one score; each tier still needs one more kill than the last.
    function tierCuts(kills) {
        const cuts = [];
        FAIL_SHARES.forEach((fail) => {
            const cut = cutoffFor(kills, +(1 - fail).toFixed(6));
            cuts.push(Math.max(cut, (cuts[cuts.length - 1] || 0) + 1));
        });
        return cuts;
    }

    // A cut-off: the fewest kills that at most `share` of the trials reached.
    function cutoffFor(kills, share) {
        const sorted = kills.slice().sort((a, b) => b - a);
        return sorted[Math.floor(sorted.length * share)] + 1;
    }

    return { KINDS, FAIL_SHARES, runTrials, climb, cutoffFor, tierCuts };
});
