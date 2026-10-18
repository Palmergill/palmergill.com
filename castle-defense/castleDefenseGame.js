// Castle Defense engine. Pure state + step(): no DOM, no canvas, so the page
// (app.js) only draws and forwards input, and node can drive it for balance
// runs. Positions are in tile units; a tile's centre is (x + 0.5, y + 0.5).
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CastleDefenseGame = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const COLS = 20;
    const ROWS = 12;

    // Waypoints as tile coordinates; zombies walk the centre line between them.
    // The first sits off the left edge so zombies walk on rather than pop in.
    const WAYPOINTS = [[-1, 2], [4, 2], [4, 9], [9, 9], [9, 2], [14, 2], [14, 8], [17, 8]];
    const CASTLE = { x: 17, y: 6, w: 3, h: 5 };
    const TREES = [[1, 6], [2, 10], [7, 5], [12, 6], [16, 1], [11, 11], [6, 0], [18, 2], [0, 9], [12, 10]];

    const TOWERS = {
        archer: {
            name: "Archer",
            blurb: "Fast arrows at one zombie.",
            cost: 50,
            levels: [
                { damage: 9, range: 2.6, rate: 1.6 },
                { damage: 15, range: 2.9, rate: 1.9, cost: 60 },
                { damage: 26, range: 3.2, rate: 2.3, cost: 120 }
            ],
            projectile: { kind: "arrow", speed: 13 }
        },
        cannon: {
            name: "Cannon",
            blurb: "Slow shells that hit a crowd.",
            cost: 110,
            levels: [
                { damage: 24, range: 2.4, rate: 0.6, splash: 1.0 },
                { damage: 38, range: 2.6, rate: 0.7, splash: 1.2, cost: 120 },
                { damage: 62, range: 2.9, rate: 0.8, splash: 1.45, cost: 210 }
            ],
            projectile: { kind: "shell", speed: 7 }
        },
        frost: {
            name: "Frost",
            blurb: "Chills a group, slowing them.",
            cost: 80,
            levels: [
                { damage: 3, range: 2.3, rate: 1.0, splash: 0.9, slow: 0.4, slowFor: 1.6 },
                { damage: 5, range: 2.6, rate: 1.2, splash: 1.1, slow: 0.5, slowFor: 1.9, cost: 90 },
                { damage: 8, range: 3.0, rate: 1.4, splash: 1.3, slow: 0.6, slowFor: 2.2, cost: 150 }
            ],
            projectile: { kind: "shard", speed: 10 }
        },
        mage: {
            name: "Mage",
            blurb: "Lightning that chains between zombies.",
            cost: 150,
            levels: [
                { damage: 20, range: 2.8, rate: 0.8, chains: 3 },
                { damage: 32, range: 3.0, rate: 0.9, chains: 4, cost: 160 },
                { damage: 50, range: 3.3, rate: 1.0, chains: 5, cost: 270 }
            ],
            projectile: null
        }
    };

    const ZOMBIES = {
        walker: { name: "Walker", hp: 32, speed: 1.0, gold: 5, damage: 1, radius: 0.28 },
        runner: { name: "Runner", hp: 20, speed: 1.9, gold: 6, damage: 1, radius: 0.23 },
        brute: { name: "Brute", hp: 130, speed: 0.6, gold: 14, damage: 3, radius: 0.36 },
        king: { name: "Zombie King", hp: 1100, speed: 0.45, gold: 150, damage: 10, radius: 0.46 }
    };

    const CASTLE_UPGRADES = {
        repair: { name: "Repair walls", blurb: "+5 castle health.", costs: [30], repeatable: true },
        walls: { name: "Thicker walls", blurb: "+10 max health, healed now.", costs: [120, 200, 320, 480] },
        oil: { name: "Boiling oil", blurb: "Scalds zombies at the gate.", costs: [90, 170, 280] },
        bounty: { name: "Tax collector", blurb: "+15% gold per kill.", costs: [100, 190, 320] }
    };
    const OIL_LEVELS = [
        { damage: 14, rate: 0.5, splash: 1.3 },
        { damage: 26, rate: 0.6, splash: 1.5 },
        { damage: 44, rate: 0.7, splash: 1.7 }
    ];
    // Where the oil pours: just outside the gate, on the last stretch of road.
    const GATE = { x: 16.2, y: 8.5 };
    const OIL_RANGE = 1.8;

    const SELL_REFUND = 0.7;
    const START_GOLD = 160;
    const START_HP = 20;
    const AUTO_START_DELAY = 3;

    const segments = buildSegments();
    const PATH_LENGTH = segments.length ? segments[segments.length - 1].end : 0;
    const pathTiles = buildPathTiles();
    const blockedTiles = buildBlockedTiles();

    function buildSegments() {
        const out = [];
        let total = 0;
        for (let i = 0; i < WAYPOINTS.length - 1; i++) {
            const ax = WAYPOINTS[i][0] + 0.5;
            const ay = WAYPOINTS[i][1] + 0.5;
            const bx = WAYPOINTS[i + 1][0] + 0.5;
            const by = WAYPOINTS[i + 1][1] + 0.5;
            const len = Math.hypot(bx - ax, by - ay);
            out.push({ ax, ay, bx, by, start: total, end: total + len, len });
            total += len;
        }
        return out;
    }

    function buildPathTiles() {
        const set = new Set();
        for (let i = 0; i < WAYPOINTS.length - 1; i++) {
            let [x, y] = WAYPOINTS[i];
            const [tx, ty] = WAYPOINTS[i + 1];
            const dx = Math.sign(tx - x);
            const dy = Math.sign(ty - y);
            while (true) {
                if (x >= 0 && y >= 0 && x < COLS && y < ROWS) set.add(`${x},${y}`);
                if (x === tx && y === ty) break;
                x += dx;
                y += dy;
            }
        }
        return set;
    }

    function buildBlockedTiles() {
        const set = new Set(pathTiles);
        for (let x = CASTLE.x; x < CASTLE.x + CASTLE.w; x++) {
            for (let y = CASTLE.y; y < CASTLE.y + CASTLE.h; y++) set.add(`${x},${y}`);
        }
        TREES.forEach(([x, y]) => set.add(`${x},${y}`));
        return set;
    }

    function pointAt(dist) {
        if (dist <= 0) return { x: segments[0].ax, y: segments[0].ay, dx: 1, dy: 0 };
        for (const s of segments) {
            if (dist <= s.end) {
                const t = (dist - s.start) / s.len;
                return {
                    x: s.ax + (s.bx - s.ax) * t,
                    y: s.ay + (s.by - s.ay) * t,
                    dx: (s.bx - s.ax) / s.len,
                    dy: (s.by - s.ay) / s.len
                };
            }
        }
        const last = segments[segments.length - 1];
        return { x: last.bx, y: last.by, dx: 1, dy: 0 };
    }

    // Deterministic per (wave, index), so a given wave is the same every game.
    function noise(a, b) {
        const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
        return v - Math.floor(v);
    }

    function hpScale(wave) {
        return Math.pow(1.15, wave - 1) * (1 + 0.02 * (wave - 1));
    }

    function goldScale(wave) {
        return 1 + 0.02 * (wave - 1);
    }

    function waveSpawns(wave) {
        const list = [];
        const count = 6 + Math.floor(wave * 2.2);
        const gap = Math.max(0.32, 0.95 - wave * 0.02);
        let t = 0;
        for (let i = 0; i < count; i++) {
            const r = noise(wave, i);
            let type = "walker";
            if (wave >= 5 && r > 0.86 - Math.min(wave, 30) * 0.008) type = "brute";
            else if (wave >= 3 && r < 0.22 + Math.min(wave, 25) * 0.012) type = "runner";
            list.push({ type, at: t });
            t += type === "runner" ? gap * 0.6 : type === "brute" ? gap * 1.5 : gap;
        }
        if (wave % 10 === 0) list.push({ type: "king", at: t + 1.5 });
        return list;
    }

    function waveSummary(wave) {
        const counts = {};
        waveSpawns(wave).forEach((s) => { counts[s.type] = (counts[s.type] || 0) + 1; });
        return counts;
    }

    function createGame(options = {}) {
        return {
            phase: "build",
            time: 0,
            gold: options.gold ?? START_GOLD,
            hp: options.hp ?? START_HP,
            maxHp: options.hp ?? START_HP,
            wave: 0,
            kills: 0,
            goldEarned: 0,
            towers: [],
            zombies: [],
            projectiles: [],
            effects: [],
            events: [],
            spawnQueue: [],
            waveStartedAt: 0,
            clearedAt: 0,
            autoStart: false,
            castle: { walls: 0, oil: 0, bounty: 0, oilCooldown: 0 },
            nextId: 1
        };
    }

    function tileKey(x, y) {
        return `${x},${y}`;
    }

    function inBounds(x, y) {
        return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < COLS && y < ROWS;
    }

    function towerAt(state, x, y) {
        return state.towers.find((t) => t.x === x && t.y === y) || null;
    }

    function canBuild(state, x, y) {
        return inBounds(x, y) && !blockedTiles.has(tileKey(x, y)) && !towerAt(state, x, y);
    }

    function towerStats(tower) {
        return TOWERS[tower.type].levels[tower.level];
    }

    function upgradeCost(tower) {
        const next = TOWERS[tower.type].levels[tower.level + 1];
        return next ? next.cost : null;
    }

    function sellValue(tower) {
        return Math.floor(tower.invested * SELL_REFUND);
    }

    function buildTower(state, type, x, y) {
        const def = TOWERS[type];
        if (!def) return { ok: false, reason: "Unknown tower." };
        if (state.phase === "over") return { ok: false, reason: "The castle has fallen." };
        if (!canBuild(state, x, y)) return { ok: false, reason: "You can't build there." };
        if (state.gold < def.cost) return { ok: false, reason: `Need ${def.cost - state.gold} more gold.` };
        state.gold -= def.cost;
        const tower = { id: state.nextId++, type, level: 0, x, y, cooldown: 0, invested: def.cost, angle: 0, kills: 0 };
        state.towers.push(tower);
        return { ok: true, tower };
    }

    function findTower(state, id) {
        return state.towers.find((t) => t.id === id) || null;
    }

    function upgradeTower(state, id) {
        const tower = findTower(state, id);
        if (!tower) return { ok: false, reason: "No tower there." };
        const cost = upgradeCost(tower);
        if (cost == null) return { ok: false, reason: "Already fully upgraded." };
        if (state.gold < cost) return { ok: false, reason: `Need ${cost - state.gold} more gold.` };
        state.gold -= cost;
        tower.invested += cost;
        tower.level += 1;
        return { ok: true, tower };
    }

    function sellTower(state, id) {
        const tower = findTower(state, id);
        if (!tower) return { ok: false, reason: "No tower there." };
        const refund = sellValue(tower);
        state.gold += refund;
        state.towers = state.towers.filter((t) => t !== tower);
        return { ok: true, refund };
    }

    function castleUpgradeCost(state, kind) {
        const def = CASTLE_UPGRADES[kind];
        if (!def) return null;
        if (def.repeatable) return def.costs[0];
        const level = state.castle[kind];
        return level < def.costs.length ? def.costs[level] : null;
    }

    function castleUpgradeLevel(state, kind) {
        return CASTLE_UPGRADES[kind].repeatable ? null : state.castle[kind];
    }

    function buyCastleUpgrade(state, kind) {
        const def = CASTLE_UPGRADES[kind];
        if (!def) return { ok: false, reason: "Unknown upgrade." };
        if (state.phase === "over") return { ok: false, reason: "The castle has fallen." };
        const cost = castleUpgradeCost(state, kind);
        if (cost == null) return { ok: false, reason: "Already fully upgraded." };
        if (kind === "repair" && state.hp >= state.maxHp) return { ok: false, reason: "The walls are already whole." };
        if (state.gold < cost) return { ok: false, reason: `Need ${cost - state.gold} more gold.` };
        state.gold -= cost;
        if (kind === "repair") {
            state.hp = Math.min(state.maxHp, state.hp + 5);
        } else {
            state.castle[kind] += 1;
            if (kind === "walls") {
                state.maxHp += 10;
                state.hp += 10;
            }
        }
        return { ok: true };
    }

    function startWave(state) {
        if (state.phase !== "build") return { ok: false, reason: "A wave is already coming." };
        state.wave += 1;
        state.phase = "wave";
        state.waveStartedAt = state.time;
        state.spawnQueue = waveSpawns(state.wave);
        state.events.push({ type: "wave-start", wave: state.wave });
        return { ok: true };
    }

    function zombiesRemaining(state) {
        return state.spawnQueue.length + state.zombies.filter((z) => !z.gone).length;
    }

    function spawnZombie(state, type) {
        const def = ZOMBIES[type];
        const hp = Math.round(def.hp * hpScale(state.wave));
        state.zombies.push({
            id: state.nextId++,
            type,
            hp,
            maxHp: hp,
            speed: def.speed,
            radius: def.radius,
            damage: def.damage,
            gold: Math.round(def.gold * goldScale(state.wave)),
            dist: -0.4,
            // Sideways offset from the road's centre line, so a crowd walks
            // abreast instead of stacking into one blob.
            lane: (noise(state.nextId, state.wave) - 0.5) * 0.4,
            slowUntil: 0,
            slowAmt: 0,
            hitFlash: 0,
            gone: false,
            x: 0,
            y: 0,
            dx: 1,
            dy: 0
        });
        placeZombie(state.zombies[state.zombies.length - 1]);
    }

    function placeZombie(z) {
        const p = pointAt(z.dist);
        z.x = p.x - p.dy * z.lane;
        z.y = p.y + p.dx * z.lane;
        z.dx = p.dx;
        z.dy = p.dy;
    }

    function damageZombie(state, z, amount, tower) {
        if (z.gone) return;
        z.hp -= amount;
        z.hitFlash = 0.12;
        if (z.hp <= 0) {
            z.gone = true;
            const reward = Math.round(z.gold * (1 + 0.15 * state.castle.bounty));
            state.gold += reward;
            state.goldEarned += reward;
            state.kills += 1;
            if (tower) tower.kills += 1;
            state.effects.push({ kind: "coin", x: z.x, y: z.y, text: `+${reward}`, ttl: 0.9, life: 0.9 });
            state.effects.push({ kind: "splat", x: z.x, y: z.y, r: z.radius, ttl: 0.5, life: 0.5 });
            if (z.type === "king") state.events.push({ type: "king-down", gold: reward });
        }
    }

    function slowZombie(state, z, amount, duration) {
        if (z.gone) return;
        const until = state.time + duration;
        if (amount >= z.slowAmt || z.slowUntil < state.time) z.slowAmt = amount;
        z.slowUntil = Math.max(z.slowUntil, until);
    }

    function live(state) {
        return state.zombies.filter((z) => !z.gone && z.dist >= 0);
    }

    function pickTarget(state, x, y, range) {
        let best = null;
        for (const z of state.zombies) {
            if (z.gone || z.dist < 0) continue;
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
        const def = TOWERS[tower.type];
        const stats = towerStats(tower);
        const cx = tower.x + 0.5;
        const cy = tower.y + 0.5;
        tower.angle = Math.atan2(target.y - cy, target.x - cx);
        if (tower.type === "mage") {
            const hit = [target];
            let last = target;
            let damage = stats.damage;
            const points = [{ x: cx, y: cy - 0.25 }, { x: target.x, y: target.y }];
            damageZombie(state, target, damage, tower);
            for (let i = 1; i < stats.chains; i++) {
                let next = null;
                let nextD = Infinity;
                for (const z of live(state)) {
                    if (hit.includes(z)) continue;
                    const d = Math.hypot(z.x - last.x, z.y - last.y);
                    if (d < 1.7 && d < nextD) {
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
        state.projectiles.push({
            kind: def.projectile.kind,
            speed: def.projectile.speed,
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
        if (p.kind === "shard") {
            splashAt(state, p.x, p.y, p.splash, (z) => {
                slowZombie(state, z, p.slow, p.slowFor);
                damageZombie(state, z, p.damage, tower);
            });
            state.effects.push({ kind: "frost", x: p.x, y: p.y, r: p.splash, ttl: 0.4, life: 0.4 });
        }
    }

    function step(state, dt) {
        if (state.phase === "over" || dt <= 0) return;
        state.time += dt;

        if (state.phase === "build" && state.autoStart && state.wave > 0 && state.time - state.clearedAt >= AUTO_START_DELAY) {
            startWave(state);
        }

        if (state.phase === "wave") {
            const elapsed = state.time - state.waveStartedAt;
            while (state.spawnQueue.length && state.spawnQueue[0].at <= elapsed) {
                spawnZombie(state, state.spawnQueue.shift().type);
            }
        }

        for (const z of state.zombies) {
            if (z.gone) continue;
            const slowed = z.slowUntil > state.time ? 1 - z.slowAmt : 1;
            z.dist += z.speed * slowed * dt;
            z.hitFlash = Math.max(0, z.hitFlash - dt);
            placeZombie(z);
            if (z.dist >= PATH_LENGTH) {
                z.gone = true;
                state.hp = Math.max(0, state.hp - z.damage);
                state.effects.push({ kind: "breach", x: CASTLE.x + 0.3, y: z.y, text: `-${z.damage}`, ttl: 0.9, life: 0.9 });
                state.events.push({ type: "breach", damage: z.damage });
            }
        }

        for (const tower of state.towers) {
            tower.cooldown -= dt;
            if (tower.cooldown > 0) continue;
            const stats = towerStats(tower);
            const target = pickTarget(state, tower.x + 0.5, tower.y + 0.5, stats.range);
            if (!target) {
                tower.cooldown = 0;
                continue;
            }
            fireTower(state, tower, target);
            tower.cooldown = 1 / stats.rate;
        }

        if (state.castle.oil > 0) {
            state.castle.oilCooldown -= dt;
            if (state.castle.oilCooldown <= 0) {
                const oil = OIL_LEVELS[state.castle.oil - 1];
                const target = pickTarget(state, GATE.x, GATE.y, OIL_RANGE);
                if (target) {
                    splashAt(state, target.x, target.y, oil.splash, (z) => damageZombie(state, z, oil.damage, null));
                    state.effects.push({ kind: "oil", x: target.x, y: target.y, r: oil.splash, ttl: 0.5, life: 0.5 });
                    state.castle.oilCooldown = 1 / oil.rate;
                } else {
                    state.castle.oilCooldown = 0;
                }
            }
        }

        for (const p of state.projectiles) {
            const target = state.zombies.find((z) => z.id === p.targetId && !z.gone);
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
            state.phase = "over";
            state.events.push({ type: "game-over", wave: state.wave });
            return;
        }

        if (state.phase === "wave" && !state.spawnQueue.length && !state.zombies.length) {
            const bonus = 15 + 3 * state.wave;
            state.gold += bonus;
            state.goldEarned += bonus;
            state.phase = "build";
            state.clearedAt = state.time;
            state.events.push({ type: "wave-clear", wave: state.wave, bonus });
        }
    }

    function drainEvents(state) {
        const out = state.events;
        state.events = [];
        return out;
    }

    return {
        COLS,
        ROWS,
        WAYPOINTS,
        CASTLE,
        TREES,
        TOWERS,
        ZOMBIES,
        CASTLE_UPGRADES,
        OIL_LEVELS,
        OIL_RANGE,
        GATE,
        PATH_LENGTH,
        SELL_REFUND,
        isPathTile: (x, y) => pathTiles.has(tileKey(x, y)),
        buildTower,
        buyCastleUpgrade,
        canBuild,
        castleUpgradeCost,
        castleUpgradeLevel,
        createGame,
        drainEvents,
        findTower,
        hpScale,
        pointAt,
        sellTower,
        sellValue,
        startWave,
        step,
        towerAt,
        towerStats,
        upgradeCost,
        upgradeTower,
        waveSpawns,
        waveSummary,
        zombiesRemaining
    };
});
