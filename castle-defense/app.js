// Castle Defense page: draws the engine's state on a canvas and forwards
// clicks and keys to it. All rules live in castleDefenseGame.js.
(function () {
    const G = window.CastleDefenseGame;
    const BEST_KEY = "castle-defense-best";
    const STEP = 1 / 60;
    const TOWER_ORDER = ["archer", "cannon", "frost", "mage"];
    const UPGRADE_ORDER = ["repair", "walls", "oil", "bounty"];

    const $ = (id) => document.getElementById(id);
    const canvas = $("board");
    const ctx = canvas.getContext("2d");
    const wrap = $("canvasWrap");
    const overlay = $("overlay");

    let state = G.createGame();
    let speed = 1;
    let paused = false;
    let started = false;
    let buildType = "archer";
    let selectedId = null;
    let hover = null;
    let scale = 40;
    let dpr = 1;
    let background = null;
    let lastFrame = 0;
    let acc = 0;
    let toastTimer = 0;
    let best = readBest();

    // ---------- storage ----------
    function readBest() {
        try {
            return Number(localStorage.getItem(BEST_KEY)) || 0;
        } catch {
            return 0;
        }
    }

    function saveBest(wave) {
        if (wave <= best) return;
        best = wave;
        try {
            localStorage.setItem(BEST_KEY, String(wave));
        } catch {
            /* private mode: the best score just doesn't persist */
        }
    }

    // ---------- sizing ----------
    function resize() {
        const width = wrap.clientWidth;
        if (!width) return;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(width * dpr * (G.ROWS / G.COLS));
        scale = canvas.width / G.COLS;
        background = paintBackground();
    }

    // ---------- drawing helpers ----------
    function noise(x, y) {
        const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return v - Math.floor(v);
    }

    function circle(c, x, y, r, fill, stroke, lw) {
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        if (fill) {
            c.fillStyle = fill;
            c.fill();
        }
        if (stroke) {
            c.strokeStyle = stroke;
            c.lineWidth = lw || 0.04;
            c.stroke();
        }
    }

    function roundRect(c, x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    }

    function text(str, x, y, size, color, weight = 800) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const px = (x * scale) / dpr;
        const py = (y * scale) / dpr;
        ctx.font = `${weight} ${Math.max(10, (size * scale) / dpr)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(30, 26, 20, 0.55)";
        ctx.strokeText(str, px, py);
        ctx.fillStyle = color;
        ctx.fillText(str, px, py);
        ctx.restore();
    }

    // ---------- static background ----------
    function paintBackground() {
        const off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const c = off.getContext("2d");
        c.setTransform(scale, 0, 0, scale, 0, 0);

        for (let x = 0; x < G.COLS; x++) {
            for (let y = 0; y < G.ROWS; y++) {
                const n = noise(x, y);
                c.fillStyle = n > 0.5 ? "#7aa557" : "#75a052";
                c.fillRect(x, y, 1.01, 1.01);
                for (let i = 0; i < 3; i++) {
                    const tx = x + noise(x + i, y * 3) * 0.9 + 0.05;
                    const ty = y + noise(x * 2, y + i) * 0.9 + 0.05;
                    c.strokeStyle = "rgba(60, 100, 40, 0.45)";
                    c.lineWidth = 0.035;
                    c.beginPath();
                    c.moveTo(tx, ty);
                    c.lineTo(tx - 0.04, ty - 0.12);
                    c.moveTo(tx + 0.05, ty);
                    c.lineTo(tx + 0.08, ty - 0.1);
                    c.stroke();
                }
                if (n > 0.93) circle(c, x + 0.3, y + 0.7, 0.05, "#e9d56b");
                if (n < 0.04) circle(c, x + 0.7, y + 0.3, 0.05, "#f0f0ea");
            }
        }

        const pts = G.WAYPOINTS.map(([x, y]) => [x + 0.5, y + 0.5]);
        c.lineJoin = "round";
        c.lineCap = "butt";
        const road = (width, color) => {
            c.strokeStyle = color;
            c.lineWidth = width;
            c.beginPath();
            pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
            c.stroke();
        };
        road(0.98, "#8e6f45");
        road(0.84, "#b8925f");
        road(0.5, "#c4a06b");
        for (let d = 0.3; d < G.PATH_LENGTH; d += 0.55) {
            const p = G.pointAt(d);
            const off2 = (noise(d, 3) - 0.5) * 0.6;
            circle(c, p.x + p.dy * off2, p.y - p.dx * off2, 0.035 + noise(d, 7) * 0.03, "rgba(110, 82, 50, 0.55)");
        }

        G.TREES.forEach(([x, y]) => {
            const cx = x + 0.5;
            const cy = y + 0.5;
            circle(c, cx + 0.06, cy + 0.12, 0.4, "rgba(30, 50, 20, 0.25)");
            circle(c, cx, cy, 0.38, "#3f6b32");
            circle(c, cx - 0.12, cy - 0.1, 0.24, "#4f8040");
            circle(c, cx + 0.1, cy + 0.06, 0.2, "#467538");
            circle(c, cx - 0.16, cy - 0.16, 0.08, "rgba(255,255,255,0.12)");
        });

        return off;
    }

    // ---------- castle ----------
    function drawCastle() {
        const { x, y, w, h } = G.CASTLE;
        const hpRatio = state.hp / state.maxHp;
        const stone = "#b3ab9c";
        const dark = "#7d7466";

        ctx.fillStyle = "rgba(30, 40, 20, 0.25)";
        ctx.fillRect(x + 0.18, y + 0.22, w, h);
        roundRect(ctx, x + 0.1, y + 0.1, w - 0.2, h - 0.2, 0.12);
        ctx.fillStyle = stone;
        ctx.fill();
        ctx.lineWidth = 0.06;
        ctx.strokeStyle = dark;
        ctx.stroke();

        // brick courses
        ctx.strokeStyle = "rgba(90, 80, 68, 0.35)";
        ctx.lineWidth = 0.025;
        for (let row = 0; row < (h - 0.2) / 0.3; row++) {
            const yy = y + 0.1 + row * 0.3;
            ctx.beginPath();
            ctx.moveTo(x + 0.1, yy);
            ctx.lineTo(x + w - 0.1, yy);
            ctx.stroke();
            for (let col = 0; col < w / 0.5; col++) {
                const xx = x + 0.1 + col * 0.5 + (row % 2 ? 0.25 : 0);
                if (xx > x + w - 0.1) continue;
                ctx.beginPath();
                ctx.moveTo(xx, yy);
                ctx.lineTo(xx, yy + 0.3);
                ctx.stroke();
            }
        }

        // keep
        roundRect(ctx, x + 0.75, y + 1.2, 1.7, 2.4, 0.1);
        ctx.fillStyle = "#c6bfb1";
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = 0.05;
        ctx.stroke();
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = "#9c9385";
            ctx.fillRect(x + 0.8 + i * 0.34, y + 1.08, 0.2, 0.16);
        }

        // corner towers
        [[x + 0.35, y + 0.35], [x + w - 0.35, y + 0.35], [x + 0.35, y + h - 0.35], [x + w - 0.35, y + h - 0.35]].forEach(([tx, ty]) => {
            circle(ctx, tx, ty, 0.36, "#a69e8f", dark, 0.05);
            circle(ctx, tx, ty, 0.2, "#8e8576");
        });

        // flag
        const fx = x + 1.6;
        const fy = y + 1.6;
        ctx.strokeStyle = "#4b4237";
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(fx, fy + 0.6);
        ctx.lineTo(fx, fy - 0.4);
        ctx.stroke();
        const wave = Math.sin(state.time * 4) * 0.06;
        ctx.fillStyle = "#b5523f";
        ctx.beginPath();
        ctx.moveTo(fx, fy - 0.4);
        ctx.quadraticCurveTo(fx + 0.3, fy - 0.36 + wave, fx + 0.6, fy - 0.26);
        ctx.lineTo(fx, fy - 0.08);
        ctx.fill();

        // gate on the road side
        const gy = 8.5;
        ctx.fillStyle = "#4a3a2a";
        ctx.beginPath();
        ctx.moveTo(x + 0.1, gy + 0.38);
        ctx.lineTo(x + 0.1, gy - 0.18);
        ctx.quadraticCurveTo(x + 0.1, gy - 0.4, x + 0.42, gy - 0.4);
        ctx.lineTo(x + 0.55, gy - 0.4);
        ctx.lineTo(x + 0.55, gy + 0.38);
        ctx.fill();
        ctx.strokeStyle = "#2e241a";
        ctx.lineWidth = 0.03;
        for (let i = 1; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(x + 0.1, gy - 0.4 + i * 0.2);
            ctx.lineTo(x + 0.55, gy - 0.4 + i * 0.2);
            ctx.stroke();
        }

        if (state.castle.oil > 0) {
            circle(ctx, x + 0.4, gy - 0.7, 0.18, "#3c3530", "#211c18", 0.04);
            circle(ctx, x + 0.4, gy - 0.7, 0.1, "#d9932f");
        }

        if (hpRatio < 0.6) {
            ctx.strokeStyle = "rgba(50, 40, 30, 0.7)";
            ctx.lineWidth = 0.04;
            ctx.beginPath();
            ctx.moveTo(x + 2.4, y + 0.3);
            ctx.lineTo(x + 2.2, y + 0.8);
            ctx.lineTo(x + 2.45, y + 1.1);
            ctx.moveTo(x + 0.5, y + 3.8);
            ctx.lineTo(x + 0.8, y + 4.2);
            ctx.lineTo(x + 0.7, y + 4.6);
            ctx.stroke();
        }
        if (hpRatio < 0.3) {
            for (let i = 0; i < 3; i++) {
                const t = (state.time * 0.6 + i / 3) % 1;
                circle(ctx, x + 2.2 + Math.sin(t * 6 + i) * 0.1, y + 0.6 - t * 1.2, 0.12 + t * 0.2, `rgba(70, 64, 58, ${0.45 * (1 - t)})`);
            }
        }
    }

    // ---------- towers ----------
    function drawTower(c, type, level, cx, cy, angle, time, alpha = 1) {
        c.save();
        c.globalAlpha = alpha;
        roundRect(c, cx - 0.4, cy - 0.4, 0.8, 0.8, 0.12);
        c.fillStyle = "#bdb5a6";
        c.fill();
        c.strokeStyle = "#857c6d";
        c.lineWidth = 0.05;
        c.stroke();

        if (type === "archer") {
            circle(c, cx, cy, 0.3, "#9a6a3c", "#6b4524", 0.05);
            circle(c, cx, cy, 0.17, "#7d5430");
            c.save();
            c.translate(cx, cy);
            c.rotate(angle);
            c.strokeStyle = "#3f2a16";
            c.lineWidth = 0.05;
            c.beginPath();
            c.arc(0.06, 0, 0.2, -1.2, 1.2);
            c.stroke();
            c.strokeStyle = "#e8e1d0";
            c.lineWidth = 0.025;
            c.beginPath();
            c.moveTo(-0.1, 0);
            c.lineTo(0.3, 0);
            c.stroke();
            c.restore();
        } else if (type === "cannon") {
            circle(c, cx, cy, 0.3, "#5b5650", "#36322e", 0.05);
            c.save();
            c.translate(cx, cy);
            c.rotate(angle);
            roundRect(c, -0.05, -0.1, 0.46, 0.2, 0.05);
            c.fillStyle = "#2f2c29";
            c.fill();
            circle(c, 0.41, 0, 0.06, "#1d1b19");
            c.restore();
            circle(c, cx, cy, 0.14, "#46423d");
        } else if (type === "frost") {
            const glow = 0.25 + Math.sin(time * 3) * 0.05;
            circle(c, cx, cy, 0.34, `rgba(160, 220, 255, ${glow})`);
            c.fillStyle = "#8fd0ee";
            c.strokeStyle = "#4f97ba";
            c.lineWidth = 0.04;
            c.beginPath();
            c.moveTo(cx, cy - 0.32);
            c.lineTo(cx + 0.18, cy);
            c.lineTo(cx, cy + 0.3);
            c.lineTo(cx - 0.18, cy);
            c.closePath();
            c.fill();
            c.stroke();
            c.fillStyle = "rgba(255,255,255,0.7)";
            c.beginPath();
            c.moveTo(cx - 0.02, cy - 0.24);
            c.lineTo(cx + 0.07, cy - 0.02);
            c.lineTo(cx - 0.08, cy - 0.02);
            c.closePath();
            c.fill();
        } else if (type === "mage") {
            circle(c, cx, cy + 0.04, 0.28, "#5f4489", "#3e2b5c", 0.05);
            circle(c, cx, cy - 0.04, 0.15, "#e2c9a6");
            const pulse = 0.09 + Math.sin(time * 5) * 0.02;
            circle(c, cx + 0.2, cy - 0.2, pulse + 0.06, "rgba(200, 170, 255, 0.35)");
            circle(c, cx + 0.2, cy - 0.2, pulse, "#d8c2ff", "#8e6cd1", 0.03);
        }

        for (let i = 0; i <= level; i++) {
            circle(c, cx - 0.2 + i * 0.2, cy + 0.33, 0.055, "#e2b746", "#8d6a1c", 0.025);
        }
        c.restore();
    }

    // ---------- zombies ----------
    const ZOMBIE_LOOK = {
        walker: { cloth: "#7d6e5a", skin: "#8fb06a" },
        runner: { cloth: "#a5584a", skin: "#a3c27a" },
        brute: { cloth: "#4b5a6b", skin: "#6f8f50" },
        king: { cloth: "#5b2d6e", skin: "#7c9a5c" }
    };

    function drawZombie(z) {
        const look = ZOMBIE_LOOK[z.type];
        const r = z.radius;
        const sway = Math.sin(state.time * (z.type === "runner" ? 14 : 7) + z.id) * r * 0.18;
        const px = -z.dy;
        const py = z.dx;
        const x = z.x + px * sway;
        const y = z.y + py * sway;

        circle(ctx, x + 0.04, y + 0.06, r, "rgba(20, 30, 10, 0.25)");

        // arms reaching forward
        ctx.strokeStyle = look.skin;
        ctx.lineWidth = r * 0.32;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + px * r * 0.7, y + py * r * 0.7);
        ctx.lineTo(x + px * r * 0.6 + z.dx * r * 1.3, y + py * r * 0.6 + z.dy * r * 1.3);
        ctx.moveTo(x - px * r * 0.7, y - py * r * 0.7);
        ctx.lineTo(x - px * r * 0.6 + z.dx * r * 1.35, y - py * r * 0.6 + z.dy * r * 1.35);
        ctx.stroke();

        circle(ctx, x, y, r, look.cloth, "rgba(30, 24, 18, 0.6)", 0.035);
        const hx = x + z.dx * r * 0.35;
        const hy = y + z.dy * r * 0.35;
        circle(ctx, hx, hy, r * 0.58, look.skin, "rgba(40, 60, 25, 0.7)", 0.03);
        const ex = z.dx * r * 0.32;
        const ey = z.dy * r * 0.32;
        circle(ctx, hx + ex + px * r * 0.2, hy + ey + py * r * 0.2, r * 0.1, "#e8402f");
        circle(ctx, hx + ex - px * r * 0.2, hy + ey - py * r * 0.2, r * 0.1, "#e8402f");

        if (z.type === "king") {
            ctx.fillStyle = "#e2b746";
            ctx.strokeStyle = "#8d6a1c";
            ctx.lineWidth = 0.025;
            ctx.beginPath();
            const cw = r * 0.55;
            ctx.moveTo(hx - cw, hy - r * 0.05);
            ctx.lineTo(hx - cw, hy - r * 0.55);
            ctx.lineTo(hx - cw * 0.5, hy - r * 0.3);
            ctx.lineTo(hx, hy - r * 0.65);
            ctx.lineTo(hx + cw * 0.5, hy - r * 0.3);
            ctx.lineTo(hx + cw, hy - r * 0.55);
            ctx.lineTo(hx + cw, hy - r * 0.05);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        if (z.slowUntil > state.time) circle(ctx, x, y, r + 0.06, null, "rgba(150, 215, 255, 0.9)", 0.05);
        if (z.hitFlash > 0) circle(ctx, x, y, r, `rgba(255,255,255,${z.hitFlash * 4})`);

        if (z.hp < z.maxHp) {
            const bw = Math.max(0.5, r * 2);
            const bx = z.x - bw / 2;
            const by = z.y - r - 0.2;
            ctx.fillStyle = "rgba(20, 20, 20, 0.6)";
            ctx.fillRect(bx, by, bw, 0.08);
            const ratio = Math.max(0, z.hp / z.maxHp);
            ctx.fillStyle = ratio > 0.5 ? "#8fd16a" : ratio > 0.25 ? "#e6c14a" : "#e3573e";
            ctx.fillRect(bx, by, bw * ratio, 0.08);
        }
    }

    // ---------- projectiles & effects ----------
    function drawProjectile(p) {
        const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
        if (p.kind === "arrow") {
            ctx.strokeStyle = "#4a3320";
            ctx.lineWidth = 0.04;
            ctx.beginPath();
            ctx.moveTo(p.x - Math.cos(ang) * 0.24, p.y - Math.sin(ang) * 0.24);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            circle(ctx, p.x, p.y, 0.03, "#d9d2c0");
        } else if (p.kind === "shell") {
            circle(ctx, p.x, p.y, 0.1, "#262321", "#000", 0.02);
        } else if (p.kind === "shard") {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(ang);
            ctx.fillStyle = "#c6ecff";
            ctx.beginPath();
            ctx.moveTo(0.14, 0);
            ctx.lineTo(0, 0.06);
            ctx.lineTo(-0.14, 0);
            ctx.lineTo(0, -0.06);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    function drawEffect(e) {
        const t = 1 - e.ttl / e.life;
        if (e.kind === "coin") {
            text(e.text, e.x, e.y - 0.3 - t * 0.6, 0.34, "#ffd866");
        } else if (e.kind === "breach") {
            text(e.text, e.x, e.y - 0.4 - t * 0.6, 0.42, "#ff7a62");
        } else if (e.kind === "splat") {
            circle(ctx, e.x, e.y, e.r * (1 + t * 0.4), `rgba(70, 90, 40, ${0.55 * (1 - t)})`);
        } else if (e.kind === "boom") {
            circle(ctx, e.x, e.y, e.r * (0.4 + t * 0.6), `rgba(255, 170, 70, ${0.55 * (1 - t)})`);
            circle(ctx, e.x, e.y, e.r * 0.35 * (1 - t), `rgba(255, 240, 180, ${0.8 * (1 - t)})`);
        } else if (e.kind === "frost") {
            circle(ctx, e.x, e.y, e.r * (0.4 + t * 0.6), `rgba(190, 235, 255, ${0.35 * (1 - t)})`, `rgba(220, 245, 255, ${0.9 * (1 - t)})`, 0.04);
        } else if (e.kind === "oil") {
            circle(ctx, e.x, e.y, e.r * (0.5 + t * 0.4), `rgba(200, 130, 40, ${0.5 * (1 - t)})`);
        } else if (e.kind === "bolt") {
            ctx.save();
            ctx.lineJoin = "round";
            [[0.14, "rgba(190, 160, 255, 0.5)"], [0.05, "#f4eeff"]].forEach(([lw, color]) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = lw;
                ctx.beginPath();
                e.points.forEach((p, i) => {
                    if (!i) {
                        ctx.moveTo(p.x, p.y);
                        return;
                    }
                    const prev = e.points[i - 1];
                    const mx = (prev.x + p.x) / 2 + (noise(i, e.ttl * 100) - 0.5) * 0.3;
                    const my = (prev.y + p.y) / 2 + (noise(e.ttl * 100, i) - 0.5) * 0.3;
                    ctx.lineTo(mx, my);
                    ctx.lineTo(p.x, p.y);
                });
                ctx.stroke();
            });
            ctx.restore();
        }
    }

    function drawRange(cx, cy, range, ok = true) {
        circle(
            ctx, cx, cy, range,
            ok ? "rgba(255, 255, 255, 0.14)" : "rgba(230, 80, 60, 0.14)",
            ok ? "rgba(255, 255, 255, 0.7)" : "rgba(230, 80, 60, 0.7)",
            0.035
        );
    }

    // ---------- frame ----------
    function render() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (background) ctx.drawImage(background, 0, 0);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        if (buildType && hover) {
            for (let x = 0; x < G.COLS; x++) {
                for (let y = 0; y < G.ROWS; y++) {
                    if (G.canBuild(state, x, y)) {
                        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
                        ctx.lineWidth = 0.025;
                        ctx.strokeRect(x + 0.06, y + 0.06, 0.88, 0.88);
                    }
                }
            }
        }

        drawCastle();

        const selected = selectedId != null ? G.findTower(state, selectedId) : null;
        if (selected) drawRange(selected.x + 0.5, selected.y + 0.5, G.towerStats(selected).range);

        state.effects.forEach((e) => {
            if (e.kind === "splat" || e.kind === "oil") drawEffect(e);
        });
        state.towers.forEach((t) => drawTower(ctx, t.type, t.level, t.x + 0.5, t.y + 0.5, t.angle, state.time));
        state.zombies.forEach((z) => {
            if (z.dist > -0.3) drawZombie(z);
        });
        state.projectiles.forEach(drawProjectile);
        state.effects.forEach((e) => {
            if (e.kind !== "splat" && e.kind !== "oil") drawEffect(e);
        });

        if (hover && !G.towerAt(state, hover.x, hover.y)) {
            if (buildType) {
                const ok = G.canBuild(state, hover.x, hover.y) && state.gold >= G.TOWERS[buildType].cost;
                drawRange(hover.x + 0.5, hover.y + 0.5, G.TOWERS[buildType].levels[0].range, ok);
                drawTower(ctx, buildType, 0, hover.x + 0.5, hover.y + 0.5, -Math.PI / 2, state.time, ok ? 0.75 : 0.4);
            }
        } else if (hover) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
            ctx.lineWidth = 0.05;
            roundRect(ctx, hover.x + 0.06, hover.y + 0.06, 0.88, 0.88, 0.14);
            ctx.stroke();
        }

        if (paused && started && state.phase !== "over") {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = "rgba(20, 24, 16, 0.35)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            text("Paused", G.COLS / 2, G.ROWS / 2, 0.9, "#ffffff");
        }
    }

    function frame(now) {
        const real = Math.min(0.25, (now - (lastFrame || now)) / 1000);
        lastFrame = now;
        if (started && !paused && state.phase !== "over") {
            acc += real * speed;
            while (acc >= STEP) {
                G.step(state, STEP);
                acc -= STEP;
            }
        }
        handleEvents();
        render();
        updateUi();
        requestAnimationFrame(frame);
    }

    // ---------- events & toast ----------
    function toast(message, bad = false) {
        const el = $("toast");
        el.textContent = message;
        el.classList.toggle("is-bad", bad);
        el.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("is-on"), 1800);
    }

    function pulse(el, cls) {
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
    }

    function handleEvents() {
        for (const e of G.drainEvents(state)) {
            if (e.type === "wave-start") {
                toast(e.wave % 10 === 0 ? `Wave ${e.wave} — the Zombie King walks` : `Wave ${e.wave} — here they come`);
            } else if (e.type === "wave-clear") {
                toast(`Wave ${e.wave} cleared · +${e.bonus} gold`);
                saveBest(e.wave);
            } else if (e.type === "king-down") {
                toast(`The Zombie King falls · +${e.gold} gold`);
            } else if (e.type === "breach") {
                pulse(document.querySelector(".cd-stat--hp"), "is-hit");
            } else if (e.type === "game-over") {
                // A wave the castle fell during doesn't count as survived.
                saveBest(e.wave - 1);
                showOverlay({
                    eyebrow: `Wave ${e.wave}`,
                    title: "The castle has fallen",
                    body: `You held out through ${e.wave - 1} ${e.wave - 1 === 1 ? "wave" : "waves"} and put down ${state.kills} zombies. Best: ${best} ${best === 1 ? "wave" : "waves"}.`,
                    howto: false,
                    button: "Defend again"
                });
            }
        }
    }

    function showOverlay({ eyebrow, title, body, howto, button }) {
        $("overlayEyebrow").textContent = eyebrow;
        $("overlayTitle").textContent = title;
        $("overlayBody").textContent = body;
        $("overlayHowto").hidden = !howto;
        $("overlayButton").textContent = button;
        overlay.hidden = false;
        $("overlayButton").focus({ preventScroll: true });
    }

    // ---------- side panels ----------
    const shopButtons = {};
    const upgradeButtons = {};

    function buildShop() {
        const shop = $("shop");
        TOWER_ORDER.forEach((type, i) => {
            const def = G.TOWERS[type];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cd-card";
            btn.dataset.type = type;
            btn.setAttribute("aria-pressed", "false");
            btn.setAttribute("aria-label", `${def.name} tower, ${def.cost} gold. ${def.blurb}`);
            const icon = document.createElement("canvas");
            icon.width = 68;
            icon.height = 68;
            const ic = icon.getContext("2d");
            ic.setTransform(68, 0, 0, 68, 0, 0);
            drawTower(ic, type, 0, 0.5, 0.5, -Math.PI / 4, 0);
            btn.append(icon);
            btn.insertAdjacentHTML(
                "beforeend",
                `<span class="cd-card__name">${def.name}</span><span class="cd-card__cost">${def.cost} gold</span><span class="cd-card__key">${i + 1}</span>`
            );
            btn.addEventListener("click", () => chooseBuild(buildType === type ? null : type));
            shop.append(btn);
            shopButtons[type] = btn;
        });
        const note = document.createElement("p");
        note.className = "cd-shop-note";
        note.id = "shopNote";
        shop.append(note);
    }

    function buildCastlePanel() {
        const box = $("castleUpgrades");
        UPGRADE_ORDER.forEach((kind) => {
            const def = G.CASTLE_UPGRADES[kind];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cd-upgrade";
            btn.innerHTML = `<span class="cd-upgrade__name">${def.name}<span class="cd-pips"></span></span><span class="cd-upgrade__blurb">${def.blurb}</span><span class="cd-upgrade__cost"></span>`;
            btn.addEventListener("click", () => {
                const res = G.buyCastleUpgrade(state, kind);
                if (!res.ok) toast(res.reason, true);
            });
            box.append(btn);
            upgradeButtons[kind] = btn;
        });
    }

    function chooseBuild(type) {
        buildType = type;
        if (type) selectedId = null;
        Object.entries(shopButtons).forEach(([t, btn]) => btn.setAttribute("aria-pressed", String(t === type)));
        $("shopNote").textContent = type ? `${G.TOWERS[type].blurb} Click the grass to build.` : "Pick a tower to build.";
    }

    function selectTower(id) {
        selectedId = id;
        if (id != null) chooseBuild(null);
        lastSelectedSig = "";
    }

    function fmt(n) {
        return Number.isInteger(n) ? String(n) : n.toFixed(1);
    }

    let lastSelectedSig = "";
    function renderSelected() {
        const panel = $("selectedPanel");
        const tower = selectedId != null ? G.findTower(state, selectedId) : null;
        if (!tower) {
            if (!panel.hidden) panel.hidden = true;
            selectedId = null;
            lastSelectedSig = "";
            return;
        }
        const cost = G.upgradeCost(tower);
        const sig = `${tower.id}|${tower.level}|${tower.kills}|${state.gold >= (cost ?? Infinity)}|${state.phase}`;
        if (sig === lastSelectedSig) return;
        lastSelectedSig = sig;
        panel.hidden = false;
        const def = G.TOWERS[tower.type];
        const now = G.towerStats(tower);
        const next = def.levels[tower.level + 1];
        const row = (label, a, b, suffix = "") =>
            `<div><dt>${label}</dt><dd>${fmt(a)}${suffix}${b != null && b !== a ? ` <span class="up">→ ${fmt(b)}${suffix}</span>` : ""}</dd></div>`;
        let special = "";
        if (now.splash && tower.type === "cannon") special = row("Blast", now.splash, next?.splash);
        if (now.slow) special = row("Slow", Math.round(now.slow * 100), next ? Math.round(next.slow * 100) : null, "%");
        if (now.chains) special = row("Chains", now.chains, next?.chains);
        $("selectedTitle").textContent = `${def.name} · level ${tower.level + 1}`;
        $("selectedBody").innerHTML = `
            <p class="cd-tower-meta">${def.blurb} ${tower.kills} ${tower.kills === 1 ? "kill" : "kills"}.</p>
            <dl class="cd-tower-stats">
                ${row("Damage", now.damage, next?.damage)}
                ${row("Range", now.range, next?.range)}
                ${row("Shots/sec", now.rate, next?.rate)}
                ${special}
            </dl>
            <div class="cd-tower-actions">
                <button class="cd-btn cd-btn--primary" type="button" data-act="upgrade" ${cost == null || state.gold < cost ? "disabled" : ""}>
                    ${cost == null ? "Fully upgraded" : `Upgrade · ${cost} gold`}
                </button>
                <button class="cd-btn cd-btn--danger" type="button" data-act="sell">Sell · ${G.sellValue(tower)}</button>
            </div>`;
    }

    $("selectedBody").addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "upgrade") doUpgrade();
        if (act === "sell") doSell();
    });

    function doUpgrade() {
        if (selectedId == null) return;
        const res = G.upgradeTower(state, selectedId);
        if (!res.ok) toast(res.reason, true);
    }

    function doSell() {
        if (selectedId == null) return;
        const res = G.sellTower(state, selectedId);
        if (res.ok) {
            toast(`Sold for ${res.refund} gold`);
            selectTower(null);
        }
    }

    let lastHud = "";
    let lastGold = state.gold;
    function updateUi() {
        const remaining = G.zombiesRemaining(state);
        const hud = `${state.hp}|${state.maxHp}|${state.gold}|${state.wave}|${remaining}|${state.phase}|${best}|${JSON.stringify(state.castle)}`;
        renderSelected();
        if (hud === lastHud) return;
        lastHud = hud;

        $("hpValue").textContent = state.hp;
        $("hpMax").textContent = state.maxHp;
        const bar = $("hpBar");
        bar.style.width = `${(state.hp / state.maxHp) * 100}%`;
        bar.classList.toggle("is-low", state.hp / state.maxHp < 0.35);
        $("goldValue").textContent = state.gold;
        if (state.gold > lastGold) pulse(document.querySelector(".cd-stat--gold"), "is-bump");
        lastGold = state.gold;
        $("waveValue").textContent = state.wave;
        $("zombieValue").textContent = state.phase === "wave" ? remaining : "—";
        $("bestValue").textContent = best || "—";

        Object.entries(shopButtons).forEach(([type, btn]) => btn.classList.toggle("is-poor", state.gold < G.TOWERS[type].cost));

        UPGRADE_ORDER.forEach((kind) => {
            const btn = upgradeButtons[kind];
            const cost = G.castleUpgradeCost(state, kind);
            const level = G.castleUpgradeLevel(state, kind);
            const def = G.CASTLE_UPGRADES[kind];
            const full = kind === "repair" && state.hp >= state.maxHp;
            btn.disabled = cost == null || full || state.gold < cost || state.phase === "over";
            btn.querySelector(".cd-upgrade__cost").textContent = cost == null ? "Max" : `${cost}`;
            btn.querySelector(".cd-pips").innerHTML = level == null ? "" : def.costs.map((_, i) => `<i class="${i < level ? "on" : ""}"></i>`).join("");
        });

        const waveBtn = $("waveButton");
        if (state.phase === "build") {
            const next = state.wave + 1;
            const summary = G.waveSummary(next);
            const total = Object.values(summary).reduce((a, b) => a + b, 0);
            $("waveButtonLabel").textContent = `Start wave ${next}`;
            $("waveHint").textContent = summary.king ? `${total} zombies + King` : `${total} zombies`;
            waveBtn.disabled = false;
        } else if (state.phase === "wave") {
            $("waveButtonLabel").textContent = `Wave ${state.wave} underway`;
            $("waveHint").textContent = "";
            waveBtn.disabled = true;
        } else {
            $("waveButtonLabel").textContent = "Castle fallen";
            $("waveHint").textContent = "";
            waveBtn.disabled = true;
        }
    }

    // ---------- input ----------
    function tileFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * G.COLS);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * G.ROWS);
        if (x < 0 || y < 0 || x >= G.COLS || y >= G.ROWS) return null;
        return { x, y };
    }

    canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType === "mouse") hover = tileFromEvent(e);
    });
    canvas.addEventListener("pointerleave", () => { hover = null; });
    canvas.addEventListener("click", (e) => {
        const tile = tileFromEvent(e);
        if (!tile) return;
        const tower = G.towerAt(state, tile.x, tile.y);
        if (tower) {
            selectTower(tower.id);
            return;
        }
        if (buildType) {
            if (!G.canBuild(state, tile.x, tile.y)) {
                toast(G.isPathTile(tile.x, tile.y) ? "Keep the road clear — build on the grass." : "You can't build there.", true);
                return;
            }
            const res = G.buildTower(state, buildType, tile.x, tile.y);
            if (!res.ok) toast(res.reason, true);
            return;
        }
        selectTower(null);
    });

    $("waveButton").addEventListener("click", () => {
        const res = G.startWave(state);
        if (!res.ok) toast(res.reason, true);
    });

    document.querySelectorAll("[data-speed]").forEach((btn) => {
        btn.addEventListener("click", () => setSpeed(Number(btn.dataset.speed)));
    });

    function setSpeed(value) {
        speed = value;
        document.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === value)));
    }

    function togglePause() {
        paused = !paused;
        $("pauseButton").setAttribute("aria-pressed", String(paused));
        $("pauseButton").textContent = paused ? "Resume" : "Pause";
    }

    $("pauseButton").addEventListener("click", togglePause);
    $("autoStart").addEventListener("change", (e) => {
        state.autoStart = e.target.checked;
    });
    $("deselectButton").addEventListener("click", () => selectTower(null));

    $("overlayButton").addEventListener("click", () => {
        if (state.phase === "over") {
            state = G.createGame();
            state.autoStart = $("autoStart").checked;
            selectTower(null);
            chooseBuild("archer");
            lastHud = "";
            lastGold = state.gold;
        }
        started = true;
        if (paused) togglePause();
        overlay.hidden = true;
    });

    document.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (!overlay.hidden) return;
        const key = e.key.toLowerCase();
        if (["1", "2", "3", "4"].includes(key)) {
            const type = TOWER_ORDER[Number(key) - 1];
            chooseBuild(buildType === type ? null : type);
        } else if (key === " " && tag !== "BUTTON") {
            e.preventDefault();
            G.startWave(state);
        } else if (key === "u") {
            doUpgrade();
        } else if (key === "s") {
            doSell();
        } else if (key === "p") {
            togglePause();
        } else if (key === "escape") {
            selectTower(null);
            chooseBuild(null);
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden && started && !paused && state.phase === "wave") togglePause();
    });

    // ---------- boot ----------
    buildShop();
    buildCastlePanel();
    chooseBuild("archer");
    if (best) $("overlayBody").textContent += ` Your best so far: ${best} ${best === 1 ? "wave" : "waves"}.`;
    new ResizeObserver(resize).observe(wrap);
    resize();
    requestAnimationFrame(frame);
})();
