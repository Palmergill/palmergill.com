// Castle Defense engine: a daily puzzle. Each date seeds one 8×8 map, one
// endless horde, and one allotment of 0–3 of each tower and trap. The player
// places what they're given — towers beside the road, traps on it — presses
// play, and the run goes untouched until the castle falls. The score is how
// many zombies died first. Every defense levels itself up from kills and
// assists.
//
// That's the classic mode. The open mode drops the road: the castle stands
// in the middle of a field, the horde walks in from the map's edges, and each
// zombie heads for the nearest thing it can tear down — a tower, or the
// castle itself. Towers there have walls of their own and can fall.
//
// Pure state + step(): no DOM, so the page (app.js) only draws and forwards
// input, and node can drive it for balance runs. Positions are in tile units;
// a tile's centre is (x + 0.5, y + 0.5).
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CastleDefenseGame = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const SIZE = 8;
    // Bumped whenever a change makes old scores incomparable; the leaderboard
    // only ranks runs played under the current rules. 1 was the gold budget.
    const RULES = 2;
    // Each mode ranks on its own board, under its own rules number.
    const MODES = ["classic", "open"];
    const RULES_BY_MODE = { classic: RULES, open: 1 };
    const MAX_EACH = 3;
    // Limits on a day's allotment, checked by simulation (see dailyAllotment).
    const ALLOT_MIN_TOWERS = 3;
    const ALLOT_MIN_TOTAL = 7;
    const ALLOT_MAX_TOTAL = 14;
    const START_HP = 10;
    const WAVE_BREAK = 4;
    const KING_EVERY = 10;
    // The page and the server's replay both advance in this fixed step, so
    // a layout plays out identically in either place.
    const STEP = 1 / 60;
    // A run that somehow never ends stops here (90 minutes of game time).
    const MAX_STEPS = 60 * 60 * 90;
    // Day #1 of the daily map.
    const EPOCH = "2026-10-18";

    // Total XP needed to reach level 2, 3, … 10. A kill is worth 2, an assist 1.
    const LEVEL_XP = [10, 26, 50, 84, 130, 190, 265, 355, 460];
    const MAX_LEVEL = LEVEL_XP.length + 1;
    const KILL_XP = 2;
    const ASSIST_XP = 1;

    // Towers stand on grass and shoot; traps sit on a road tile and act on
    // whatever walks over them.
    const DEFENSES = {
        archer: {
            kind: "tower",
            name: "Archer",
            plural: "Archers",
            blurb: "Long reach, one target at a time. Best against Brutes and the King.",
            base: { damage: 22, range: 2.3, rate: 2.0, hp: 90 },
            projectile: { kind: "arrow", speed: 11, homing: true }
        },
        cannon: {
            kind: "tower",
            name: "Cannon",
            plural: "Cannons",
            blurb: "Shells burst across a crowd, but fast zombies can outrun them.",
            base: { damage: 20, range: 1.7, rate: 0.5, splash: 0.75, hp: 120 },
            projectile: { kind: "shell", speed: 6, homing: false }
        },
        frost: {
            kind: "tower",
            name: "Frost",
            plural: "Frost towers",
            blurb: "Barely hurts, but slows the pack so the others get more shots.",
            base: { damage: 4, range: 1.7, rate: 1.0, splash: 0.7, slow: 0.28, slowGrowth: 0.04, slowCap: 0.45, slowFor: 1.6, hp: 100 },
            projectile: { kind: "shard", speed: 9, homing: true }
        },
        mage: {
            kind: "tower",
            name: "Mage",
            plural: "Mages",
            blurb: "Lightning jumps between zombies. Strong when they bunch up.",
            base: { damage: 23, range: 2.0, rate: 0.75, chains: 2, chainRange: 1.6, hp: 80 },
            projectile: null
        },
        spikes: {
            kind: "trap",
            name: "Spikes",
            plural: "Spikes",
            blurb: "Cuts every zombie that walks across its tile.",
            base: { dps: 16 }
        },
        tar: {
            kind: "trap",
            name: "Tar pit",
            plural: "Tar pits",
            blurb: "Bogs down everything crossing it, and the slow lingers.",
            base: { dps: 4, slow: 0.5, slowGrowth: 0.02, slowCap: 0.6, slowFor: 1.3 }
        },
        mine: {
            kind: "trap",
            name: "Mine",
            plural: "Mines",
            blurb: "A big blast when stepped on, then a few seconds to re-arm.",
            base: { damage: 55, splash: 0.9, rearm: 5 }
        }
    };
    const TOWER_TYPES = Object.keys(DEFENSES).filter((t) => DEFENSES[t].kind === "tower");
    const TRAP_TYPES = Object.keys(DEFENSES).filter((t) => DEFENSES[t].kind === "trap");

    // `damage` is what a zombie takes off the castle's walls when it gets in;
    // `bite` is how fast it tears at a tower in the open mode (HP a second).
    const ZOMBIES = {
        walker: { name: "Walker", hp: 34, speed: 0.85, damage: 1, radius: 0.2, bite: 4 },
        runner: { name: "Runner", hp: 20, speed: 1.6, damage: 1, radius: 0.16, bite: 3 },
        brute: { name: "Brute", hp: 140, speed: 0.5, damage: 2, radius: 0.27, bite: 11 },
        king: { name: "Zombie King", hp: 1200, speed: 0.38, damage: 5, radius: 0.34, bite: 32 }
    };
    // A bite grows this much a wave, so late towers fall faster.
    const BITE_GROWTH = 0.06;

    // ---------- seeded randomness ----------
    function hashString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

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

    function shuffle(rng, list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    // ---------- dates ----------
    function localDateString(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    function dayNumber(dateStr) {
        const [y, m, d] = dateStr.split("-").map(Number);
        const [ey, em, ed] = EPOCH.split("-").map(Number);
        return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86400000) + 1;
    }

    // ---------- map generation ----------
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    function inGrid(x, y) {
        return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
    }

    // A self-avoiding road that never runs alongside itself, so every bend
    // leaves grass between the lanes for towers.
    function carveRoad(rng) {
        const target = 15 + Math.floor(rng() * 7);
        const side = Math.floor(rng() * 4);
        const along = 1 + Math.floor(rng() * (SIZE - 2));
        const start = [[0, along], [SIZE - 1, along], [along, 0], [along, SIZE - 1]][side];
        const entry = [[-1, along], [SIZE, along], [along, -1], [along, SIZE]][side];
        const path = [start];
        const used = new Set([`${start[0]},${start[1]}`]);
        let budget = 4000;

        function touches(x, y, prev) {
            for (const [dx, dy] of DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx === prev[0] && ny === prev[1]) continue;
                if (used.has(`${nx},${ny}`)) return true;
            }
            return false;
        }

        function extend() {
            if (path.length === target) return true;
            if (--budget <= 0) return false;
            const last = path[path.length - 1];
            const prev = path.length > 1 ? path[path.length - 2] : entry;
            const heading = [last[0] - prev[0], last[1] - prev[1]];
            // Prefer to keep going straight: roads read better with runs.
            const options = shuffle(rng, DIRS.slice())
                .map((d) => ({ d, k: d[0] === heading[0] && d[1] === heading[1] ? rng() * 0.8 : rng() }))
                .sort((a, b) => a.k - b.k)
                .map((o) => o.d);
            for (const [dx, dy] of options) {
                const nx = last[0] + dx;
                const ny = last[1] + dy;
                const key = `${nx},${ny}`;
                if (!inGrid(nx, ny) || used.has(key) || touches(nx, ny, last)) continue;
                // The castle can't sit on the border: it needs grass around it.
                if (path.length + 1 === target && (nx === 0 || ny === 0 || nx === SIZE - 1 || ny === SIZE - 1)) continue;
                path.push([nx, ny]);
                used.add(key);
                if (extend()) return true;
                path.pop();
                used.delete(key);
            }
            return false;
        }

        return extend() ? { path, entry } : null;
    }

    // How much road (in tiles) the three best grass tiles can reach between
    // them. Below MIN_COVERAGE, a day played far harder in simulation.
    const MIN_COVERAGE = 16.5;
    const COVERAGE_RANGE = 2.0;

    function roadCoverage(road) {
        const onRoad = new Set(road.path.map(([x, y]) => `${x},${y}`));
        const fake = { segments: buildSegments([road.entry, ...road.path].map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }))) };
        fake.length = fake.segments[fake.segments.length - 1].end;
        const samples = [];
        for (let d = 0; d < fake.length; d += 0.1) {
            const p = pointAt(fake, d);
            if (p.x >= 0 && p.y >= 0 && p.x <= SIZE && p.y <= SIZE) samples.push(p);
        }
        const reach = [];
        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) {
                if (onRoad.has(`${x},${y}`)) continue;
                reach.push(samples.filter((p) => Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < COVERAGE_RANGE).length * 0.1);
            }
        }
        reach.sort((a, b) => b - a);
        return reach[0] + reach[1] + reach[2];
    }

    function dailyMap(dateStr, mode = "classic") {
        if (mode === "open") return openMap(dateStr);
        const seed = hashString(`castle-defense:${dateStr}`);
        const rng = mulberry32(seed);
        // Reroll roads that towers can barely reach — ones hugging the edge
        // leave half of every tower's range off the board.
        let road = null;
        while (!road || roadCoverage(road) < MIN_COVERAGE) road = carveRoad(rng);

        const pathSet = new Set(road.path.map(([x, y]) => `${x},${y}`));
        const castle = road.path[road.path.length - 1];
        const free = [];
        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) if (!pathSet.has(`${x},${y}`)) free.push([x, y]);
        }
        // Trees and rocks are mostly scenery: at most one may sit beside the
        // road. Several there can wall off the only good tower spots.
        const besideRoad = ([x, y]) => {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) if (pathSet.has(`${x + dx},${y + dy}`)) return true;
            }
            return false;
        };
        const want = 3 + Math.floor(rng() * 3);
        const spots = shuffle(rng, free);
        const near = spots.filter(besideRoad).slice(0, 1);
        const far = spots.filter((t) => !besideRoad(t)).slice(0, want - near.length);
        const obstacles = [...near, ...far].map(([x, y], i) => ({ x, y, kind: i % 3 === 2 ? "rock" : "tree" }));

        // Each day leans on one kind of zombie, so the best mix of defenses changes.
        const leans = ["walker", "runner", "brute"];
        const lean = leans[Math.floor(rng() * leans.length)];

        const map = {
            date: dateStr,
            day: dayNumber(dateStr),
            mode: "classic",
            seed,
            path: road.path,
            entry: road.entry,
            castle: { x: castle[0], y: castle[1] },
            obstacles,
            lean
        };
        map.waypoints = [road.entry, ...road.path].map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
        map.segments = buildSegments(map.waypoints);
        map.length = map.segments[map.segments.length - 1].end;
        map.pathSet = pathSet;
        map.obstacleSet = new Set(obstacles.map((o) => `${o.x},${o.y}`));
        map.allotment = dailyAllotment(seed);
        return map;
    }

    // The open field: no road, the castle near the middle, and a few trees
    // and rocks that zombies have to walk around. Its own seed, so the open
    // day isn't just the classic day with the road painted over.
    const SIDES = ["north", "east", "south", "west"];
    // Which way is "outward" from each side, as [dx, dy].
    const SIDE_OUT = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

    function openMap(dateStr) {
        const seed = hashString(`castle-defense:open:${dateStr}`);
        const rng = mulberry32(seed);
        const castle = { x: 3 + Math.floor(rng() * 2), y: 3 + Math.floor(rng() * 2) };
        const key = (x, y) => `${x},${y}`;
        const nearCastle = (x, y) => Math.abs(x - castle.x) <= 1 && Math.abs(y - castle.y) <= 1;
        const spots = [];
        for (let x = 0; x < SIZE; x++) {
            for (let y = 0; y < SIZE; y++) if (!nearCastle(x, y)) spots.push([x, y]);
        }
        // Reroll until every open tile can still reach the castle, so no
        // zombie can be born in a pocket sealed off by rocks.
        let obstacles;
        for (;;) {
            const want = 4 + Math.floor(rng() * 3);
            obstacles = shuffle(rng, spots.slice()).slice(0, want).map(([x, y], i) => ({ x, y, kind: i % 3 === 2 ? "rock" : "tree" }));
            const blocked = new Set([key(castle.x, castle.y), ...obstacles.map((o) => key(o.x, o.y))]);
            const seen = new Set();
            const queue = [[castle.x + 1, castle.y]];
            seen.add(key(castle.x + 1, castle.y));
            while (queue.length) {
                const [x, y] = queue.shift();
                for (const [dx, dy] of DIRS) {
                    const k = key(x + dx, y + dy);
                    if (!inGrid(x + dx, y + dy) || blocked.has(k) || seen.has(k)) continue;
                    seen.add(k);
                    queue.push([x + dx, y + dy]);
                }
            }
            if (seen.size === SIZE * SIZE - blocked.size) break;
        }

        const leans = ["walker", "runner", "brute"];
        const lean = leans[Math.floor(rng() * leans.length)];
        const obstacleSet = new Set(obstacles.map((o) => key(o.x, o.y)));
        // The tiles zombies can walk in from, side by side.
        const edges = {};
        SIDES.forEach((side) => {
            edges[side] = [];
            for (let i = 0; i < SIZE; i++) {
                const [x, y] = { north: [i, 0], east: [SIZE - 1, i], south: [i, SIZE - 1], west: [0, i] }[side];
                if (!obstacleSet.has(key(x, y))) edges[side].push({ x, y });
            }
        });
        return {
            date: dateStr,
            day: dayNumber(dateStr),
            mode: "open",
            seed,
            path: [],
            castle,
            obstacles,
            lean,
            edges,
            // The castle is the only tile that isn't grass or scenery.
            pathSet: new Set([key(castle.x, castle.y)]),
            obstacleSet,
            allotment: dailyAllotment(seed)
        };
    }

    // What everyone gets to place today: 0–3 of each defense, from its own
    // seeded stream so the map itself is unchanged. Rerolled until it's a
    // fair day to play — enough towers to fight with, and neither a handful
    // of pieces nor a bottomless pile.
    function dailyAllotment(seed) {
        const rng = mulberry32(hashString(`${seed}:allotment`));
        for (;;) {
            const out = {};
            Object.keys(DEFENSES).forEach((type) => { out[type] = Math.floor(rng() * (MAX_EACH + 1)); });
            const towers = TOWER_TYPES.reduce((n, t) => n + out[t], 0);
            const total = Object.values(out).reduce((n, c) => n + c, 0);
            if (towers >= ALLOT_MIN_TOWERS && total >= ALLOT_MIN_TOTAL && total <= ALLOT_MAX_TOTAL) return out;
        }
    }

    function buildSegments(points) {
        const out = [];
        let total = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, start: total, end: total + len, len });
            total += len;
        }
        return out;
    }

    function pointAt(map, dist) {
        const segs = map.segments;
        for (const s of segs) {
            if (dist <= s.end) {
                const t = (dist - s.start) / s.len;
                return { x: s.ax + (s.bx - s.ax) * t, y: s.ay + (s.by - s.ay) * t, dx: (s.bx - s.ax) / s.len, dy: (s.by - s.ay) / s.len };
            }
        }
        const last = segs[segs.length - 1];
        return { x: last.bx, y: last.by, dx: (last.bx - last.ax) / last.len, dy: (last.by - last.ay) / last.len };
    }

    // ---------- the horde ----------
    function hpScale(wave) {
        return Math.pow(1.28, wave - 1);
    }

    function spawnOdds(wave, lean) {
        return {
            runner: wave >= 2 ? (lean === "runner" ? 0.4 : 0.2) : 0,
            brute: wave >= 4 ? (lean === "brute" ? 0.25 : 0.12) : 0
        };
    }

    // Waves never run out; each is generated from the day's seed and its
    // number, so wave 23 is the same for everyone that day.
    function waveSpawns(map, wave) {
        const rng = mulberry32(hashString(`${map.seed}:wave:${wave}`));
        const list = [];
        const count = 5 + wave * 2;
        const gap = Math.max(0.45, 1.05 - wave * 0.05);
        let t = 0;
        for (let i = 0; i < count; i++) {
            let type = "walker";
            const r = rng();
            const odds = spawnOdds(wave, map.lean);
            if (r < odds.brute) type = "brute";
            else if (r < odds.brute + odds.runner) type = "runner";
            list.push({ type, at: t, wave });
            t += type === "runner" ? gap * 0.55 : type === "brute" ? gap * 1.6 : gap;
        }
        // Every day's wave carries the same total HP as a walker-day wave of
        // the same size, so a Brute day means fewer, tougher zombies — not a
        // harder day. Clamped so a type still feels like itself.
        const neutral = spawnOdds(wave, "walker");
        const perZombie = ZOMBIES.brute.hp * neutral.brute + ZOMBIES.runner.hp * neutral.runner + ZOMBIES.walker.hp * (1 - neutral.brute - neutral.runner);
        const actual = list.reduce((sum, s) => sum + ZOMBIES[s.type].hp, 0);
        const hpMul = Math.min(1.3, Math.max(0.7, (perZombie * count) / actual));
        list.forEach((s) => { s.hpMul = hpMul; });
        if (wave % KING_EVERY === 0) list.push({ type: "king", at: t + 1.5, wave, hpMul: 1 });
        if (map.mode === "open") {
            // A wave comes in from one side at first, then two, then three,
            // from its own stream so the zombies themselves don't change.
            const srng = mulberry32(hashString(`${map.seed}:sides:${wave}`));
            const sides = shuffle(srng, SIDES.slice()).slice(0, wave < 3 ? 1 : wave < 8 ? 2 : 3);
            list.forEach((s) => {
                s.side = sides[Math.floor(srng() * sides.length)];
                s.along = srng();
            });
            list.sides = sides;
        }
        return list;
    }

    // ---------- game state ----------
    function createGame(map) {
        return {
            map,
            phase: "setup",
            time: 0,
            stock: { ...map.allotment },
            hp: START_HP,
            maxHp: START_HP,
            wave: 0,
            kills: 0,
            leaked: 0,
            defenses: [],
            zombies: [],
            projectiles: [],
            effects: [],
            events: [],
            queue: [],
            nextWaveAt: 0,
            nextId: 1
        };
    }

    function stats(type, level) {
        const b = DEFENSES[type].base;
        const up = level - 1;
        const grow = (v) => +(v * (1 + 0.45 * up)).toFixed(2);
        const s = {};
        if (b.damage != null) s.damage = Math.round(grow(b.damage));
        if (b.dps != null) s.dps = grow(b.dps);
        if (b.range != null) s.range = +(b.range + 0.08 * up).toFixed(2);
        if (b.rate != null) s.rate = +(b.rate * (1 + 0.06 * up)).toFixed(2);
        if (b.splash != null) s.splash = +(b.splash + 0.05 * up).toFixed(2);
        if (b.slow != null) {
            s.slow = Math.min(b.slowCap, +(b.slow + b.slowGrowth * up).toFixed(2));
            s.slowFor = +(b.slowFor + 0.1 * up).toFixed(2);
        }
        if (b.chains != null) {
            s.chains = b.chains + Math.floor(level / 2);
            s.chainRange = b.chainRange;
        }
        if (b.rearm != null) s.rearm = +(b.rearm * Math.pow(0.92, up)).toFixed(2);
        if (b.hp != null) s.hp = Math.round(b.hp * (1 + 0.3 * up));
        return s;
    }

    function xpForNext(d) {
        return d.level < MAX_LEVEL ? LEVEL_XP[d.level - 1] : null;
    }

    function defenseAt(state, x, y) {
        return state.defenses.find((d) => d.x === x && d.y === y) || null;
    }

    function findDefense(state, id) {
        return state.defenses.find((d) => d.id === id) || null;
    }

    function isRoad(map, x, y) {
        return map.pathSet.has(`${x},${y}`) && !(x === map.castle.x && y === map.castle.y);
    }

    function isGrass(map, x, y) {
        return inGrid(x, y) && !map.pathSet.has(`${x},${y}`) && !map.obstacleSet.has(`${x},${y}`);
    }

    // Why `type` can't go on (x, y), or null if it can.
    function placementProblem(state, type, x, y) {
        const def = DEFENSES[type];
        if (!def) return "Unknown defense.";
        if (state.phase !== "setup") return "The run has started.";
        if (!Number.isInteger(x) || !Number.isInteger(y) || !inGrid(x, y)) return "That's off the map.";
        if (defenseAt(state, x, y)) return "Something is already there.";
        if (x === state.map.castle.x && y === state.map.castle.y) return "That's the castle.";
        if (state.map.mode === "open") {
            if (!isGrass(state.map, x, y)) return "You can't build there.";
        } else if (def.kind === "tower" && !isGrass(state.map, x, y)) {
            return state.map.pathSet.has(`${x},${y}`) ? "Towers go on the grass — traps go on the road." : "You can't build there.";
        }
        if (state.map.mode !== "open" && def.kind === "trap" && !isRoad(state.map, x, y)) return "Traps go on the road.";
        if (!(state.stock[type] > 0)) {
            return state.map.allotment[type] ? `No ${def.plural} left — that's all of today's.` : `There are no ${def.plural} today.`;
        }
        return null;
    }

    function canPlace(state, type, x, y) {
        return placementProblem(state, type, x, y) === null;
    }

    function place(state, type, x, y) {
        const problem = placementProblem(state, type, x, y);
        if (problem) return { ok: false, reason: problem };
        const def = DEFENSES[type];
        state.stock[type] -= 1;
        const d = { id: state.nextId++, type, kind: def.kind, x, y, level: 1, xp: 0, kills: 0, assists: 0, cooldown: 0, angle: -Math.PI / 2 };
        state.defenses.push(d);
        return { ok: true, defense: d };
    }

    // Before the run, anything can be picked back up and placed again.
    function remove(state, id) {
        if (state.phase !== "setup") return { ok: false, reason: "The run has started." };
        const d = findDefense(state, id);
        if (!d) return { ok: false, reason: "Nothing there." };
        state.defenses = state.defenses.filter((x) => x !== d);
        state.stock[d.type] += 1;
        return { ok: true, defense: d };
    }

    function startRun(state) {
        if (state.phase !== "setup") return { ok: false, reason: "Already running." };
        if (!state.defenses.length) return { ok: false, reason: "Build something first." };
        // Renumber in board order. Ids feed into each zombie's lane, so the
        // same layout must play the same however it was built or rearranged.
        state.defenses.sort((a, b) => a.y - b.y || a.x - b.x);
        state.defenses.forEach((d, i) => { d.id = i + 1; });
        state.nextId = state.defenses.length + 1;
        if (state.map.mode === "open") {
            state.defenses.forEach((d) => {
                if (d.kind === "tower") d.hp = d.maxHp = stats(d.type, 1).hp;
            });
            state.fieldDirty = true;
        }
        state.phase = "running";
        state.time = 0;
        state.nextWaveAt = 0;
        return { ok: true };
    }

    // ---------- combat ----------
    function spawnZombie(state, spawn) {
        const def = ZOMBIES[spawn.type];
        const hp = Math.round(def.hp * hpScale(spawn.wave) * spawn.hpMul);
        const id = state.nextId++;
        const z = {
            id,
            type: spawn.type,
            wave: spawn.wave,
            hp,
            maxHp: hp,
            speed: def.speed,
            radius: def.radius,
            damage: def.damage,
            dist: 0,
            // Sideways offset from the road's centre line, so a crowd walks
            // abreast instead of stacking into one blob.
            lane: (mulberry32(id * 7919 + state.map.seed)() - 0.5) * 0.36,
            slowUntil: 0,
            slowAmt: 0,
            hitFlash: 0,
            hitBy: new Set(),
            gone: false,
            x: 0,
            y: 0,
            dx: 1,
            dy: 0
        };
        if (state.map.mode === "open") enterField(state, z, spawn);
        else placeZombie(state.map, z);
        state.zombies.push(z);
    }

    function placeZombie(map, z) {
        const p = pointAt(map, z.dist);
        z.x = p.x - p.dy * z.lane;
        z.y = p.y + p.dx * z.lane;
        z.dx = p.dx;
        z.dy = p.dy;
    }

    function addXp(state, d, amount) {
        d.xp += amount;
        while (d.level < MAX_LEVEL && d.xp >= LEVEL_XP[d.level - 1]) {
            d.level += 1;
            // A tower that grows gets the new wall on top of what's left.
            if (d.maxHp != null) {
                const grown = stats(d.type, d.level).hp;
                d.hp += grown - d.maxHp;
                d.maxHp = grown;
            }
            state.effects.push({ kind: "levelup", x: d.x + 0.5, y: d.y + 0.5, text: `Level ${d.level}`, ttl: 1.2, life: 1.2 });
            state.events.push({ type: "level-up", id: d.id, level: d.level });
        }
    }

    // Every defense that hurt a zombie shares the credit: the killing blow
    // earns KILL_XP, every other one that hit it earns ASSIST_XP.
    function damageZombie(state, z, amount, d) {
        if (z.gone) return;
        z.hp -= amount;
        z.hitFlash = 0.12;
        z.hitBy.add(d.id);
        if (z.hp > 0) return;
        z.gone = true;
        state.kills += 1;
        d.kills += 1;
        addXp(state, d, KILL_XP);
        for (const id of z.hitBy) {
            if (id === d.id) continue;
            const helper = findDefense(state, id);
            if (!helper) continue;
            helper.assists += 1;
            addXp(state, helper, ASSIST_XP);
        }
        state.effects.push({ kind: "points", x: z.x, y: z.y, text: "+1", ttl: 0.7, life: 0.7 });
        state.effects.push({ kind: "splat", x: z.x, y: z.y, r: z.radius, ttl: 0.5, life: 0.5 });
        if (z.type === "king") state.events.push({ type: "king-down" });
    }

    function slowZombie(state, z, amount, duration) {
        if (amount >= z.slowAmt || z.slowUntil < state.time) z.slowAmt = amount;
        z.slowUntil = Math.max(z.slowUntil, state.time + duration);
    }

    function live(state) {
        return state.zombies.filter((z) => !z.gone);
    }

    function onTile(z, d) {
        return Math.floor(z.x) === d.x && Math.floor(z.y) === d.y;
    }

    // On the road a tower shoots whoever is furthest along it; in the open
    // there's no "along", so it shoots whoever is closest to itself.
    function pickTarget(state, x, y, range) {
        const open = state.map.mode === "open";
        let best = null;
        let bestGap = Infinity;
        for (const z of live(state)) {
            const gap = Math.hypot(z.x - x, z.y - y);
            if (gap > range + z.radius * 0.5) continue;
            if (open ? gap < bestGap : !best || z.dist > best.dist) {
                best = z;
                bestGap = gap;
            }
        }
        return best;
    }

    function splashAt(state, x, y, radius, fn) {
        for (const z of live(state)) {
            if (Math.hypot(z.x - x, z.y - y) <= radius + z.radius) fn(z);
        }
    }

    function fireTower(state, tower, target) {
        const s = stats(tower.type, tower.level);
        const cx = tower.x + 0.5;
        const cy = tower.y + 0.5;
        tower.angle = Math.atan2(target.y - cy, target.x - cx);
        if (tower.type === "mage") {
            const hit = [target];
            let last = target;
            let damage = s.damage;
            const points = [{ x: cx, y: cy - 0.2 }, { x: target.x, y: target.y }];
            damageZombie(state, target, damage, tower);
            for (let i = 1; i < s.chains; i++) {
                let next = null;
                let nextD = Infinity;
                for (const z of live(state)) {
                    if (hit.includes(z)) continue;
                    const dd = Math.hypot(z.x - last.x, z.y - last.y);
                    if (dd < s.chainRange && dd < nextD) {
                        next = z;
                        nextD = dd;
                    }
                }
                if (!next) break;
                damage *= 0.8;
                hit.push(next);
                points.push({ x: next.x, y: next.y });
                damageZombie(state, next, damage, tower);
                last = next;
            }
            state.effects.push({ kind: "bolt", points, ttl: 0.18, life: 0.18 });
            return;
        }
        const proj = DEFENSES[tower.type].projectile;
        state.projectiles.push({
            kind: proj.kind,
            speed: proj.speed,
            homing: proj.homing,
            x: cx,
            y: cy,
            tx: target.x,
            ty: target.y,
            targetId: target.id,
            ownerId: tower.id,
            damage: s.damage,
            splash: s.splash || 0,
            slow: s.slow || 0,
            slowFor: s.slowFor || 0,
            done: false
        });
    }

    function landProjectile(state, p) {
        const owner = findDefense(state, p.ownerId);
        if (!owner) return;
        if (p.kind === "arrow") {
            const target = state.zombies.find((z) => z.id === p.targetId && !z.gone);
            if (target) damageZombie(state, target, p.damage, owner);
            return;
        }
        if (p.kind === "shell") {
            splashAt(state, p.x, p.y, p.splash, (z) => damageZombie(state, z, p.damage, owner));
            state.effects.push({ kind: "boom", x: p.x, y: p.y, r: p.splash, ttl: 0.35, life: 0.35 });
            return;
        }
        splashAt(state, p.x, p.y, p.splash, (z) => {
            slowZombie(state, z, p.slow, p.slowFor);
            damageZombie(state, z, p.damage, owner);
        });
        state.effects.push({ kind: "frost", x: p.x, y: p.y, r: p.splash, ttl: 0.4, life: 0.4 });
    }

    function runTrap(state, trap, dt) {
        const s = stats(trap.type, trap.level);
        const here = live(state).filter((z) => onTile(z, trap));
        if (trap.type === "mine") {
            trap.cooldown -= dt;
            if (trap.cooldown > 0 || !here.length) return;
            const cx = trap.x + 0.5;
            const cy = trap.y + 0.5;
            splashAt(state, cx, cy, s.splash, (z) => damageZombie(state, z, s.damage, trap));
            state.effects.push({ kind: "boom", x: cx, y: cy, r: s.splash, ttl: 0.45, life: 0.45 });
            trap.cooldown = s.rearm;
            return;
        }
        for (const z of here) {
            if (trap.type === "tar") slowZombie(state, z, s.slow, s.slowFor);
            damageZombie(state, z, s.dps * dt, trap);
        }
        trap.active = here.length > 0;
    }

    // ---------- the open field ----------
    // Zombies there steer by a flow field: every walkable tile holds how many
    // steps it is from standing next to something they can attack — a live
    // tower or the castle. Walking downhill on it is walking to the nearest
    // threat. It's rebuilt whenever a tower falls and opens new ground.
    function tileIndex(x, y) {
        return y * SIZE + x;
    }

    function liveTowerAt(state, x, y) {
        return state.defenses.find((d) => d.kind === "tower" && !d.destroyed && d.x === x && d.y === y) || null;
    }

    function isCastle(map, x, y) {
        return x === map.castle.x && y === map.castle.y;
    }

    function walkable(state, x, y) {
        return inGrid(x, y) && !state.map.obstacleSet.has(`${x},${y}`) && !isCastle(state.map, x, y) && !liveTowerAt(state, x, y);
    }

    function buildField(state) {
        const field = new Array(SIZE * SIZE).fill(Infinity);
        const queue = [];
        const targets = state.defenses.filter((d) => d.kind === "tower" && !d.destroyed).concat([state.map.castle]);
        for (const t of targets) {
            for (const [dx, dy] of DIRS) {
                const x = t.x + dx;
                const y = t.y + dy;
                if (!walkable(state, x, y) || field[tileIndex(x, y)] === 0) continue;
                field[tileIndex(x, y)] = 0;
                queue.push([x, y]);
            }
        }
        for (let i = 0; i < queue.length; i++) {
            const [x, y] = queue[i];
            const next = field[tileIndex(x, y)] + 1;
            for (const [dx, dy] of DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (!walkable(state, nx, ny) || field[tileIndex(nx, ny)] <= next) continue;
                field[tileIndex(nx, ny)] = next;
                queue.push([nx, ny]);
            }
        }
        state.field = field;
        state.fieldDirty = false;
    }

    // A zombie walks on from just outside its edge tile.
    function enterField(state, z, spawn) {
        const map = state.map;
        const free = (side) => map.edges[side].filter((t) => !liveTowerAt(state, t.x, t.y));
        let tiles = free(spawn.side);
        if (!tiles.length) tiles = SIDES.flatMap(free);
        const tile = tiles[Math.floor(spawn.along * tiles.length)];
        const [ox, oy] = SIDE_OUT[spawn.side];
        const r = mulberry32(z.id * 7919 + map.seed);
        // Where in a tile this zombie likes to stand, so a crowd spreads out.
        z.ox = (r() - 0.5) * 0.36;
        z.oy = (r() - 0.5) * 0.36;
        z.gx = tile.x;
        z.gy = tile.y;
        z.x = tile.x + 0.5 + ox * 0.8 + z.ox;
        z.y = tile.y + 0.5 + oy * 0.8 + z.oy;
        z.dx = -ox;
        z.dy = -oy;
        z.target = null;
        z.bite = ZOMBIES[spawn.type].bite * (1 + BITE_GROWTH * (spawn.wave - 1));
    }

    // Standing on its goal tile: attack whatever is next to it, or pick the
    // next tile downhill. Ties are split by id so a crowd fans out.
    function decide(state, z) {
        const here = state.field[tileIndex(z.gx, z.gy)];
        z.target = null;
        if (here === 0) {
            for (let i = 0; i < 4; i++) {
                const [dx, dy] = DIRS[(i + z.id) % 4];
                const x = z.gx + dx;
                const y = z.gy + dy;
                if (isCastle(state.map, x, y)) z.target = { x, y, castle: true };
                else {
                    const tower = liveTowerAt(state, x, y);
                    if (tower) z.target = { x, y, tower };
                }
                if (z.target) return;
            }
        }
        const options = [];
        for (const [dx, dy] of DIRS) {
            const x = z.gx + dx;
            const y = z.gy + dy;
            if (walkable(state, x, y) && state.field[tileIndex(x, y)] < here) options.push([x, y]);
        }
        if (!options.length) return;
        const [x, y] = options[z.id % options.length];
        z.gx = x;
        z.gy = y;
    }

    function walkTo(z, x, y, move) {
        const gap = Math.hypot(x - z.x, y - z.y);
        if (gap > 1e-6) {
            z.dx = (x - z.x) / gap;
            z.dy = (y - z.y) / gap;
        }
        if (gap <= move) {
            z.x = x;
            z.y = y;
            return true;
        }
        z.x += z.dx * move;
        z.y += z.dy * move;
        return false;
    }

    function moveOpen(state, z, move, dt) {
        if (z.target && z.target.tower && z.target.tower.destroyed) decide(state, z);
        const t = z.target;
        if (!t) {
            if (walkTo(z, z.gx + 0.5 + z.ox, z.gy + 0.5 + z.oy, move)) decide(state, z);
            return;
        }
        // Close in on the side of the tile facing the target.
        const fx = t.x - z.gx;
        const fy = t.y - z.gy;
        const reach = t.castle ? 0.5 : 0.5 - z.radius * 0.6;
        const side = fx ? z.oy : z.ox;
        const ax = z.gx + 0.5 + fx * reach + (fx ? 0 : side);
        const ay = z.gy + 0.5 + fy * reach + (fy ? 0 : side);
        if (!walkTo(z, ax, ay, move)) return;
        z.dx = fx;
        z.dy = fy;
        if (t.castle) {
            breach(state, z);
            return;
        }
        const tower = t.tower;
        tower.hp -= z.bite * dt;
        tower.hitFlash = 0.12;
        if (tower.hp > 0) return;
        tower.hp = 0;
        tower.destroyed = true;
        state.fieldDirty = true;
        state.effects.push({ kind: "boom", x: tower.x + 0.5, y: tower.y + 0.5, r: 0.6, ttl: 0.5, life: 0.5 });
        state.events.push({ type: "tower-down", id: tower.id });
    }

    function breach(state, z) {
        z.gone = true;
        state.leaked += 1;
        state.hp = Math.max(0, state.hp - z.damage);
        state.effects.push({ kind: "breach", x: state.map.castle.x + 0.5, y: state.map.castle.y + 0.1, text: `-${z.damage}`, ttl: 0.9, life: 0.9 });
        state.events.push({ type: "breach", damage: z.damage });
    }

    function step(state, dt) {
        if (state.phase !== "running" || dt <= 0) return;
        state.time += dt;

        // The next wave rolls in a short break after the last one finished
        // arriving, whether or not you've cleared it.
        if (state.time >= state.nextWaveAt) {
            state.wave += 1;
            const spawns = waveSpawns(state.map, state.wave);
            spawns.forEach((s) => state.queue.push({ ...s, at: s.at + state.time }));
            state.nextWaveAt = state.time + spawns[spawns.length - 1].at + WAVE_BREAK;
            state.events.push({ type: "wave", wave: state.wave, sides: spawns.sides });
            if (spawns.sides) state.waveSides = spawns.sides;
        }
        while (state.queue.length && state.queue[0].at <= state.time) spawnZombie(state, state.queue.shift());

        const open = state.map.mode === "open";
        for (const z of state.zombies) {
            if (z.gone) continue;
            const slowed = z.slowUntil > state.time ? 1 - z.slowAmt : 1;
            z.hitFlash = Math.max(0, z.hitFlash - dt);
            if (open) {
                if (state.fieldDirty) buildField(state);
                moveOpen(state, z, z.speed * slowed * dt, dt);
                continue;
            }
            z.dist += z.speed * slowed * dt;
            placeZombie(state.map, z);
            if (z.dist >= state.map.length) breach(state, z);
        }

        for (const d of state.defenses) {
            if (d.hitFlash) d.hitFlash = Math.max(0, d.hitFlash - dt);
            if (d.destroyed) continue;
            if (d.kind === "trap") {
                runTrap(state, d, dt);
                continue;
            }
            d.cooldown -= dt;
            if (d.cooldown > 0) continue;
            const s = stats(d.type, d.level);
            const target = pickTarget(state, d.x + 0.5, d.y + 0.5, s.range);
            if (!target) {
                d.cooldown = 0;
                continue;
            }
            fireTower(state, d, target);
            d.cooldown = 1 / s.rate;
        }

        for (const p of state.projectiles) {
            // Shells fly to where the target stood when fired, so fast
            // zombies can outrun the blast; arrows and shards home in.
            const target = p.homing && state.zombies.find((z) => z.id === p.targetId && !z.gone);
            if (target) {
                p.tx = target.x;
                p.ty = target.y;
            }
            const dist = Math.hypot(p.tx - p.x, p.ty - p.y);
            const move = p.speed * dt;
            if (dist <= move) {
                p.x = p.tx;
                p.y = p.ty;
                p.done = true;
                landProjectile(state, p);
            } else {
                p.x += ((p.tx - p.x) / dist) * move;
                p.y += ((p.ty - p.y) / dist) * move;
            }
        }

        state.zombies = state.zombies.filter((z) => !z.gone);
        state.projectiles = state.projectiles.filter((p) => !p.done);
        for (const e of state.effects) e.ttl -= dt;
        state.effects = state.effects.filter((e) => e.ttl > 0);

        if (state.hp <= 0) {
            state.phase = "over";
            state.events.push({ type: "end", kills: state.kills, wave: state.wave });
        }
    }

    // The official result of a layout on a date. The server replays this to
    // rank a run, so a posted score can't claim more than the layout earns.
    function replay(dateStr, layout, mode = "classic") {
        if (!MODES.includes(mode)) return { ok: false, reason: "Unknown mode." };
        const state = createGame(dailyMap(dateStr, mode));
        if (!Array.isArray(layout) || !layout.length) return { ok: false, reason: "Build something first." };
        for (const d of layout) {
            const res = place(state, d && d.type, d && d.x, d && d.y);
            if (!res.ok) return { ok: false, reason: res.reason };
        }
        const started = startRun(state);
        if (!started.ok) return started;
        let steps = 0;
        while (state.phase === "running" && steps < MAX_STEPS) {
            step(state, STEP);
            steps += 1;
        }
        return { ok: true, kills: state.kills, wave: state.wave, rules: RULES_BY_MODE[mode] };
    }

    function drainEvents(state) {
        const out = state.events;
        state.events = [];
        return out;
    }

    return {
        SIZE,
        RULES,
        MODES,
        RULES_BY_MODE,
        SIDES,
        MAX_EACH,
        START_HP,
        KING_EVERY,
        STEP,
        MAX_LEVEL,
        LEVEL_XP,
        KILL_XP,
        ASSIST_XP,
        DEFENSES,
        TOWER_TYPES,
        TRAP_TYPES,
        ZOMBIES,
        canPlace,
        createGame,
        dailyMap,
        dayNumber,
        defenseAt,
        drainEvents,
        findDefense,
        isGrass,
        isRoad,
        localDateString,
        place,
        placementProblem,
        pointAt,
        remove,
        replay,
        startRun,
        stats,
        step,
        waveSpawns,
        xpForNext
    };
});
