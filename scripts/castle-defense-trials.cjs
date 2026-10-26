// Castle Defense trial layouts: many seeded variations of one day's
// allotment, played to the end. scripts/castle-defense-goals.mjs uses them to
// set each day's goal; they're deterministic, so a rerun gives the same goals.
const G = require("../castle-defense/castleDefenseGame.js");

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
function tileScores(map, mode) {
    const towers = [];
    const traps = [];
    const road = [];
    if (mode === "classic") {
        for (let d = 0; d < map.length; d += 0.2) road.push(G.pointAt(map, d));
    }
    for (let x = 0; x < G.SIZE; x++) {
        for (let y = 0; y < G.SIZE; y++) {
            if (G.isGrass(map, x, y)) {
                const score = mode === "classic"
                    ? road.filter((p) => Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < 2).length + 0.5
                    : 1 / (0.5 + Math.hypot(x - map.castle.x, y - map.castle.y));
                towers.push({ x, y, score });
                if (mode === "open") traps.push({ x, y, score: 1 / (0.5 + Math.abs(Math.hypot(x - map.castle.x, y - map.castle.y) - 2)) });
            } else if (mode === "classic" && G.isRoad(map, x, y)) {
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

function trialLayout(map, mode, scores, index) {
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

function runTrials(date, mode, count) {
    const map = G.dailyMap(date, mode);
    const scores = tileScores(map, mode);
    const out = [];
    for (let i = 0; i < count; i++) {
        const { kind, layout } = trialLayout(map, mode, scores, i);
        const res = G.replay(date, layout, mode);
        if (!res.ok) throw new Error(`${date} ${mode} trial ${i}: ${res.reason}`);
        out.push({ kind, kills: res.kills });
    }
    return out;
}

// The goal: the fewest kills that at most `share` of the trials reached.
function goalFor(kills, share) {
    const sorted = kills.slice().sort((a, b) => b - a);
    return sorted[Math.floor(sorted.length * share)] + 1;
}

module.exports = { KINDS, runTrials, goalFor };
