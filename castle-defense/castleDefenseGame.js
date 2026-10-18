// Castle Defense engine: a daily puzzle. Each date seeds one 8×8 map and one
// horde. The player places three towers of three different types, presses
// play, and the run goes untouched until the castle falls or the horde is
// dead. Towers level themselves up from kills and assists.
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
    const TOWER_LIMIT = 3;
    const WAVES = 10;
    const START_HP = 10;
    const WAVE_BREAK = 4;
    // Day #1 of the daily map.
    const EPOCH = "2026-10-18";

    // XP needed to reach level 2, 3, 4, 5. A kill is worth 2, an assist 1.
    const LEVEL_XP = [10, 26, 50, 84];
    const MAX_LEVEL = LEVEL_XP.length + 1;
    const KILL_XP = 2;
    const ASSIST_XP = 1;

    const TOWERS = {
        archer: {
            name: "Archer",
            blurb: "Long reach, one target at a time. Best against Brutes and the King.",
            base: { damage: 22, range: 2.3, rate: 2.0 },
            projectile: { kind: "arrow", speed: 11, homing: true }
        },
        cannon: {
            name: "Cannon",
            blurb: "Shells burst across a crowd, but fast zombies can outrun them.",
            base: { damage: 18, range: 1.7, rate: 0.5, splash: 0.75 },
            projectile: { kind: "shell", speed: 6, homing: false }
        },
        frost: {
            name: "Frost",
            blurb: "Barely hurts, but slows the pack so the others get more shots.",
            base: { damage: 4, range: 1.7, rate: 1.0, splash: 0.7, slow: 0.28, slowGrowth: 0.04, slowCap: 0.45, slowFor: 1.6 },
            projectile: { kind: "shard", speed: 9, homing: true }
        },
        mage: {
            name: "Mage",
            blurb: "Lightning jumps between zombies. Strong when they bunch up.",
            base: { damage: 23, range: 2.0, rate: 0.75, chains: 2, chainRange: 1.6 },
            projectile: null
        }
    };

    const ZOMBIES = {
        walker: { name: "Walker", hp: 34, speed: 0.85, points: 10, damage: 1, radius: 0.2 },
        runner: { name: "Runner", hp: 20, speed: 1.6, points: 15, damage: 1, radius: 0.16 },
        brute: { name: "Brute", hp: 140, speed: 0.5, points: 40, damage: 2, radius: 0.27 },
        king: { name: "Zombie King", hp: 1200, speed: 0.38, points: 300, damage: 5, radius: 0.34 }
    };

    const WIN_BONUS = 250;
    const HP_BONUS = 50;

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

    function dailyMap(dateStr) {
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
        // road. Several there can wall off the only good tower spots and make
        // a day unwinnable.
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

        // Each day leans on one kind of zombie, so the best three towers change.
        const leans = ["walker", "runner", "brute"];
        const lean = leans[Math.floor(rng() * leans.length)];

        const map = {
            date: dateStr,
            day: dayNumber(dateStr),
            seed,
            path: road.path,
            entry: road.entry,
            castle: { x: castle[0], y: castle[1] },
            obstacles,
            lean,
            waves: []
        };
        map.waypoints = [road.entry, ...road.path].map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
        map.segments = buildSegments(map.waypoints);
        map.length = map.segments[map.segments.length - 1].end;
        // The castle tile is the end of the road, so it's in pathSet already.
        map.blocked = new Set([...pathSet, ...obstacles.map((o) => `${o.x},${o.y}`)]);
        map.pathSet = pathSet;
        for (let w = 1; w <= WAVES; w++) map.waves.push(waveSpawns(rng, w, lean));
        return map;
    }

    // How much road (in tiles) the three best grass tiles can reach between
    // them. Below MIN_COVERAGE, a day was often unwinnable in simulation.
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

    function hpScale(wave) {
        return Math.pow(1.28, wave - 1);
    }

    function spawnOdds(wave, lean) {
        return {
            runner: wave >= 2 ? (lean === "runner" ? 0.4 : 0.2) : 0,
            brute: wave >= 4 ? (lean === "brute" ? 0.25 : 0.12) : 0
        };
    }

    function waveSpawns(rng, wave, lean) {
        const list = [];
        const count = 5 + wave * 2;
        const gap = Math.max(0.45, 1.05 - wave * 0.05);
        let t = 0;
        for (let i = 0; i < count; i++) {
            let type = "walker";
            const r = rng();
            const odds = spawnOdds(wave, lean);
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
        if (wave === WAVES) list.push({ type: "king", at: t + 1.5, wave, hpMul: 1 });
        return list;
    }

    // ---------- game state ----------
    function createGame(map) {
        return {
            map,
            phase: "setup",
            time: 0,
            hp: START_HP,
            maxHp: START_HP,
            wave: 0,
            kills: 0,
            leaked: 0,
            score: 0,
            towers: [],
            zombies: [],
            projectiles: [],
            effects: [],
            events: [],
            timeline: [],
            nextId: 1
        };
    }

    function towerStats(type, level) {
        const b = TOWERS[type].base;
        const up = level - 1;
        const s = {
            damage: Math.round(b.damage * (1 + 0.45 * up)),
            range: +(b.range + 0.12 * up).toFixed(2),
            rate: +(b.rate * (1 + 0.08 * up)).toFixed(2)
        };
        if (b.splash) s.splash = +(b.splash + 0.08 * up).toFixed(2);
        if (b.slow) {
            s.slow = Math.min(b.slowCap, +(b.slow + b.slowGrowth * up).toFixed(2));
            s.slowFor = +(b.slowFor + 0.15 * up).toFixed(2);
        }
        if (b.chains) {
            s.chains = b.chains + Math.floor(level / 2);
            s.chainRange = b.chainRange;
        }
        return s;
    }

    function xpForNext(tower) {
        return tower.level < MAX_LEVEL ? LEVEL_XP[tower.level - 1] : null;
    }

    function towerAt(state, x, y) {
        return state.towers.find((t) => t.x === x && t.y === y) || null;
    }

    function findTower(state, id) {
        return state.towers.find((t) => t.id === id) || null;
    }

    function canPlace(state, x, y) {
        return Number.isInteger(x) && Number.isInteger(y) && inGrid(x, y) && !state.map.blocked.has(`${x},${y}`) && !towerAt(state, x, y);
    }

    function typesUsed(state) {
        return state.towers.map((t) => t.type);
    }

    function placeTower(state, type, x, y) {
        if (!TOWERS[type]) return { ok: false, reason: "Unknown tower." };
        if (state.phase !== "setup") return { ok: false, reason: "The run has started." };
        if (!canPlace(state, x, y)) {
            return { ok: false, reason: state.map.pathSet.has(`${x},${y}`) ? "Keep the road clear — build on the grass." : "You can't build there." };
        }
        // One of each type: placing a type you already have moves it.
        const existing = state.towers.find((t) => t.type === type);
        if (existing) {
            existing.x = x;
            existing.y = y;
            return { ok: true, tower: existing, moved: true };
        }
        if (state.towers.length >= TOWER_LIMIT) return { ok: false, reason: `Only ${TOWER_LIMIT} towers — remove one first.` };
        const tower = { id: state.nextId++, type, x, y, level: 1, xp: 0, kills: 0, assists: 0, cooldown: 0, angle: -Math.PI / 2 };
        state.towers.push(tower);
        return { ok: true, tower };
    }

    function removeTower(state, id) {
        if (state.phase !== "setup") return { ok: false, reason: "The run has started." };
        const before = state.towers.length;
        state.towers = state.towers.filter((t) => t.id !== id);
        return { ok: state.towers.length < before };
    }

    function startRun(state) {
        if (state.phase !== "setup") return { ok: false, reason: "Already running." };
        const missing = TOWER_LIMIT - state.towers.length;
        if (missing > 0) return { ok: false, reason: `Place ${missing} more ${missing === 1 ? "tower" : "towers"}.` };
        let offset = 0;
        state.timeline = [];
        state.map.waves.forEach((spawns) => {
            spawns.forEach((s) => state.timeline.push({ ...s, at: s.at + offset }));
            offset += spawns[spawns.length - 1].at + WAVE_BREAK;
        });
        state.phase = "running";
        state.time = 0;
        return { ok: true };
    }

    function totalZombies(map) {
        return map.waves.reduce((n, w) => n + w.length, 0);
    }

    function zombiesRemaining(state) {
        return state.timeline.length + state.zombies.length;
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
            points: def.points,
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
        placeZombie(state.map, z);
        state.zombies.push(z);
        if (spawn.wave > state.wave) {
            state.wave = spawn.wave;
            state.events.push({ type: "wave", wave: spawn.wave });
        }
    }

    function placeZombie(map, z) {
        const p = pointAt(map, z.dist);
        z.x = p.x - p.dy * z.lane;
        z.y = p.y + p.dx * z.lane;
        z.dx = p.dx;
        z.dy = p.dy;
    }

    function addXp(state, tower, amount) {
        tower.xp += amount;
        while (tower.level < MAX_LEVEL && tower.xp >= LEVEL_XP[tower.level - 1]) {
            tower.level += 1;
            state.effects.push({ kind: "levelup", x: tower.x + 0.5, y: tower.y + 0.5, text: `Level ${tower.level}`, ttl: 1.2, life: 1.2 });
            state.events.push({ type: "level-up", towerId: tower.id, level: tower.level });
        }
    }

    // Every tower that damaged a zombie shares the credit: the killing blow
    // earns KILL_XP, every other tower that hit it earns ASSIST_XP.
    function damageZombie(state, z, amount, tower) {
        if (z.gone) return;
        z.hp -= amount;
        z.hitFlash = 0.12;
        z.hitBy.add(tower.id);
        if (z.hp > 0) return;
        z.gone = true;
        state.kills += 1;
        state.score += z.points;
        tower.kills += 1;
        addXp(state, tower, KILL_XP);
        for (const id of z.hitBy) {
            if (id === tower.id) continue;
            const helper = findTower(state, id);
            if (!helper) continue;
            helper.assists += 1;
            addXp(state, helper, ASSIST_XP);
        }
        state.effects.push({ kind: "points", x: z.x, y: z.y, text: `+${z.points}`, ttl: 0.9, life: 0.9 });
        state.effects.push({ kind: "splat", x: z.x, y: z.y, r: z.radius, ttl: 0.5, life: 0.5 });
        if (z.type === "king") state.events.push({ type: "king-down" });
    }

    function live(state) {
        return state.zombies.filter((z) => !z.gone);
    }

    function pickTarget(state, x, y, range) {
        let best = null;
        for (const z of live(state)) {
            if (Math.hypot(z.x - x, z.y - y) > range + z.radius * 0.5) continue;
            if (!best || z.dist > best.dist) best = z;
        }
        return best;
    }

    function splashAt(state, x, y, radius, fn) {
        for (const z of live(state)) {
            if (Math.hypot(z.x - x, z.y - y) <= radius + z.radius) fn(z);
        }
    }

    function fireTower(state, tower, target) {
        const stats = towerStats(tower.type, tower.level);
        const cx = tower.x + 0.5;
        const cy = tower.y + 0.5;
        tower.angle = Math.atan2(target.y - cy, target.x - cx);
        if (tower.type === "mage") {
            const hit = [target];
            let last = target;
            let damage = stats.damage;
            const points = [{ x: cx, y: cy - 0.2 }, { x: target.x, y: target.y }];
            damageZombie(state, target, damage, tower);
            for (let i = 1; i < stats.chains; i++) {
                let next = null;
                let nextD = Infinity;
                for (const z of live(state)) {
                    if (hit.includes(z)) continue;
                    const d = Math.hypot(z.x - last.x, z.y - last.y);
                    if (d < stats.chainRange && d < nextD) {
                        next = z;
                        nextD = d;
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
        const proj = TOWERS[tower.type].projectile;
        state.projectiles.push({
            kind: proj.kind,
            speed: proj.speed,
            homing: proj.homing,
            x: cx,
            y: cy,
            tx: target.x,
            ty: target.y,
            targetId: target.id,
            towerId: tower.id,
            damage: stats.damage,
            splash: stats.splash || 0,
            slow: stats.slow || 0,
            slowFor: stats.slowFor || 0,
            done: false
        });
    }

    function landProjectile(state, p) {
        const tower = findTower(state, p.towerId);
        if (!tower) return;
        if (p.kind === "arrow") {
            const target = state.zombies.find((z) => z.id === p.targetId && !z.gone);
            if (target) damageZombie(state, target, p.damage, tower);
            return;
        }
        if (p.kind === "shell") {
            splashAt(state, p.x, p.y, p.splash, (z) => damageZombie(state, z, p.damage, tower));
            state.effects.push({ kind: "boom", x: p.x, y: p.y, r: p.splash, ttl: 0.35, life: 0.35 });
            return;
        }
        splashAt(state, p.x, p.y, p.splash, (z) => {
            if (p.slow >= z.slowAmt || z.slowUntil < state.time) z.slowAmt = p.slow;
            z.slowUntil = Math.max(z.slowUntil, state.time + p.slowFor);
            damageZombie(state, z, p.damage, tower);
        });
        state.effects.push({ kind: "frost", x: p.x, y: p.y, r: p.splash, ttl: 0.4, life: 0.4 });
    }

    function finalScore(state) {
        return state.score + (state.phase === "won" ? WIN_BONUS + HP_BONUS * state.hp : 0);
    }

    function step(state, dt) {
        if (state.phase !== "running" || dt <= 0) return;
        state.time += dt;

        while (state.timeline.length && state.timeline[0].at <= state.time) {
            spawnZombie(state, state.timeline.shift());
        }

        for (const z of state.zombies) {
            if (z.gone) continue;
            const slowed = z.slowUntil > state.time ? 1 - z.slowAmt : 1;
            z.dist += z.speed * slowed * dt;
            z.hitFlash = Math.max(0, z.hitFlash - dt);
            placeZombie(state.map, z);
            if (z.dist >= state.map.length) {
                z.gone = true;
                state.leaked += 1;
                state.hp = Math.max(0, state.hp - z.damage);
                state.effects.push({ kind: "breach", x: state.map.castle.x + 0.5, y: state.map.castle.y + 0.1, text: `-${z.damage}`, ttl: 0.9, life: 0.9 });
                state.events.push({ type: "breach", damage: z.damage });
            }
        }

        for (const tower of state.towers) {
            tower.cooldown -= dt;
            if (tower.cooldown > 0) continue;
            const stats = towerStats(tower.type, tower.level);
            const target = pickTarget(state, tower.x + 0.5, tower.y + 0.5, stats.range);
            if (!target) {
                tower.cooldown = 0;
                continue;
            }
            fireTower(state, tower, target);
            tower.cooldown = 1 / stats.rate;
        }

        for (const p of state.projectiles) {
            // Shells fly to where the target stood when fired, so fast
            // zombies can outrun the blast; arrows and shards home in.
            const target = p.homing && state.zombies.find((z) => z.id === p.targetId && !z.gone);
            if (target) {
                p.tx = target.x;
                p.ty = target.y;
            }
            const d = Math.hypot(p.tx - p.x, p.ty - p.y);
            const move = p.speed * dt;
            if (d <= move) {
                p.x = p.tx;
                p.y = p.ty;
                p.done = true;
                landProjectile(state, p);
            } else {
                p.x += ((p.tx - p.x) / d) * move;
                p.y += ((p.ty - p.y) / d) * move;
            }
        }

        state.zombies = state.zombies.filter((z) => !z.gone);
        state.projectiles = state.projectiles.filter((p) => !p.done);
        for (const e of state.effects) e.ttl -= dt;
        state.effects = state.effects.filter((e) => e.ttl > 0);

        if (state.hp <= 0) {
            state.phase = "lost";
            state.events.push({ type: "end", won: false, score: finalScore(state) });
        } else if (!state.timeline.length && !state.zombies.length) {
            state.phase = "won";
            state.events.push({ type: "end", won: true, score: finalScore(state) });
        }
    }

    function drainEvents(state) {
        const out = state.events;
        state.events = [];
        return out;
    }

    return {
        SIZE,
        TOWER_LIMIT,
        WAVES,
        START_HP,
        MAX_LEVEL,
        LEVEL_XP,
        KILL_XP,
        ASSIST_XP,
        WIN_BONUS,
        HP_BONUS,
        TOWERS,
        ZOMBIES,
        canPlace,
        createGame,
        dailyMap,
        dayNumber,
        drainEvents,
        finalScore,
        findTower,
        localDateString,
        placeTower,
        pointAt,
        removeTower,
        startRun,
        step,
        totalZombies,
        towerAt,
        towerStats,
        typesUsed,
        xpForNext,
        zombiesRemaining
    };
});
