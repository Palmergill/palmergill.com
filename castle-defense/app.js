// Castle Defense page: draws the engine's state on a canvas and forwards
// clicks and keys to it. All rules live in castleDefenseGame.js.
(function () {
    const G = window.CastleDefenseGame;
    const STEP = 1 / 60;
    const TYPES = ["archer", "cannon", "frost", "mage"];
    const SHARE_ICON = { archer: "🏹", cannon: "💣", frost: "❄️", mage: "🔮" };

    const $ = (id) => document.getElementById(id);
    const canvas = $("board");
    const ctx = canvas.getContext("2d");
    const wrap = $("canvasWrap");
    const overlay = $("overlay");

    // ?date=YYYY-MM-DD replays another day's map; otherwise it's today's.
    const requested = new URLSearchParams(location.search).get("date");
    const today = G.localDateString();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(requested || "") && !Number.isNaN(Date.parse(requested)) ? requested : today;
    const map = G.dailyMap(date);
    const storeKey = `castle-defense:v2:${date}`;

    let record = readRecord();
    let state = G.createGame(map);
    let speed = 1;
    let selectedType = null;
    let hover = null;
    let scale = 60;
    let dpr = 1;
    let background = null;
    let lastFrame = 0;
    let acc = 0;
    let toastTimer = 0;

    // ---------- storage ----------
    function readRecord() {
        try {
            return { best: null, runs: 0, layout: null, ...JSON.parse(localStorage.getItem(storeKey) || "{}") };
        } catch {
            return { best: null, runs: 0, layout: null };
        }
    }

    function writeRecord() {
        try {
            localStorage.setItem(storeKey, JSON.stringify(record));
        } catch {
            /* private mode: today's best just doesn't persist */
        }
    }

    function layoutOf(s) {
        return s.towers.map((t) => ({ type: t.type, x: t.x, y: t.y }));
    }

    function applyLayout(s, layout) {
        (layout || []).forEach((t) => G.placeTower(s, t.type, t.x, t.y));
    }

    // ---------- sizing ----------
    function resize() {
        const width = wrap.clientWidth;
        if (!width) return;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr);
        canvas.height = canvas.width;
        scale = canvas.width / G.SIZE;
        background = paintBackground();
    }

    // ---------- drawing helpers ----------
    function noise(x, y) {
        const v = Math.sin(x * 127.1 + y * 311.7 + (map.seed % 1000)) * 43758.5453;
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
            c.lineWidth = lw || 0.03;
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

    function text(str, x, y, size, color) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = `800 ${Math.max(11, (size * scale) / dpr)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(30, 26, 20, 0.6)";
        ctx.strokeText(str, (x * scale) / dpr, (y * scale) / dpr);
        ctx.fillStyle = color;
        ctx.fillText(str, (x * scale) / dpr, (y * scale) / dpr);
        ctx.restore();
    }

    // ---------- static background ----------
    function paintBackground() {
        const off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const c = off.getContext("2d");
        c.setTransform(scale, 0, 0, scale, 0, 0);

        for (let x = 0; x < G.SIZE; x++) {
            for (let y = 0; y < G.SIZE; y++) {
                const n = noise(x, y);
                c.fillStyle = (x + y) % 2 ? "#79a456" : "#74a051";
                c.fillRect(x, y, 1.01, 1.01);
                for (let i = 0; i < 5; i++) {
                    const tx = x + noise(x + i, y * 3) * 0.9 + 0.05;
                    const ty = y + noise(x * 2, y + i) * 0.9 + 0.05;
                    c.strokeStyle = "rgba(60, 100, 40, 0.4)";
                    c.lineWidth = 0.02;
                    c.beginPath();
                    c.moveTo(tx, ty);
                    c.lineTo(tx - 0.03, ty - 0.08);
                    c.moveTo(tx + 0.035, ty);
                    c.lineTo(tx + 0.055, ty - 0.07);
                    c.stroke();
                }
                if (n > 0.9) circle(c, x + 0.3, y + 0.7, 0.035, "#e9d56b");
                if (n < 0.06) circle(c, x + 0.7, y + 0.3, 0.035, "#f0f0ea");
            }
        }

        const pts = map.waypoints;
        c.lineJoin = "round";
        c.lineCap = "butt";
        const road = (width, color) => {
            c.strokeStyle = color;
            c.lineWidth = width;
            c.beginPath();
            pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
            c.stroke();
        };
        road(0.86, "#8e6f45");
        road(0.74, "#b8925f");
        road(0.42, "#c4a06b");
        for (let d = 0.3; d < map.length - 0.5; d += 0.4) {
            const p = G.pointAt(map, d);
            const o = (noise(d, 3) - 0.5) * 0.5;
            circle(c, p.x + p.dy * o, p.y - p.dx * o, 0.025 + noise(d, 7) * 0.02, "rgba(110, 82, 50, 0.55)");
        }

        // Footprints where the horde walks on, so the entrance reads at a glance.
        const e = map.waypoints[1];
        const f = map.waypoints[2];
        c.fillStyle = "rgba(70, 50, 30, 0.5)";
        for (let i = 0; i < 4; i++) {
            const t = -0.4 + i * 0.22;
            const side = i % 2 ? 0.09 : -0.09;
            const px = e.x + (f.x - e.x) * t + side * (f.y - e.y);
            const py = e.y + (f.y - e.y) * t - side * (f.x - e.x);
            c.beginPath();
            c.ellipse(px, py, 0.05, 0.032, Math.atan2(f.y - e.y, f.x - e.x), 0, Math.PI * 2);
            c.fill();
        }

        map.obstacles.forEach((o) => {
            const cx = o.x + 0.5;
            const cy = o.y + 0.5;
            if (o.kind === "rock") {
                circle(c, cx + 0.05, cy + 0.08, 0.3, "rgba(30, 40, 20, 0.25)");
                c.fillStyle = "#9a9488";
                c.strokeStyle = "#6f6a60";
                c.lineWidth = 0.03;
                c.beginPath();
                c.moveTo(cx - 0.3, cy + 0.15);
                c.lineTo(cx - 0.18, cy - 0.2);
                c.lineTo(cx + 0.08, cy - 0.28);
                c.lineTo(cx + 0.3, cy - 0.05);
                c.lineTo(cx + 0.24, cy + 0.2);
                c.closePath();
                c.fill();
                c.stroke();
                c.fillStyle = "rgba(255,255,255,0.18)";
                c.beginPath();
                c.moveTo(cx - 0.16, cy - 0.15);
                c.lineTo(cx + 0.06, cy - 0.22);
                c.lineTo(cx - 0.02, cy - 0.05);
                c.closePath();
                c.fill();
            } else {
                circle(c, cx + 0.05, cy + 0.1, 0.36, "rgba(30, 50, 20, 0.25)");
                circle(c, cx, cy, 0.34, "#3f6b32");
                circle(c, cx - 0.1, cy - 0.09, 0.22, "#4f8040");
                circle(c, cx + 0.1, cy + 0.06, 0.18, "#467538");
                circle(c, cx - 0.14, cy - 0.14, 0.07, "rgba(255,255,255,0.12)");
            }
        });

        return off;
    }

    // ---------- castle ----------
    function drawCastle() {
        const { x, y } = map.castle;
        const cx = x + 0.5;
        const cy = y + 0.5;
        const prev = map.path[map.path.length - 2];
        const facing = Math.atan2(prev[1] - y, prev[0] - x);
        const hpRatio = state.hp / state.maxHp;
        const dark = "#7d7466";
        const clock = performance.now() / 1000;

        circle(ctx, cx + 0.06, cy + 0.08, 0.5, "rgba(30, 40, 20, 0.25)");
        roundRect(ctx, cx - 0.4, cy - 0.4, 0.8, 0.8, 0.06);
        ctx.fillStyle = "#b8b0a1";
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = 0.035;
        ctx.stroke();
        ctx.strokeStyle = "rgba(90, 80, 68, 0.3)";
        ctx.lineWidth = 0.015;
        for (let row = 1; row < 4; row++) {
            ctx.beginPath();
            ctx.moveTo(cx - 0.4, cy - 0.4 + row * 0.2);
            ctx.lineTo(cx + 0.4, cy - 0.4 + row * 0.2);
            ctx.stroke();
        }

        roundRect(ctx, cx - 0.2, cy - 0.2, 0.4, 0.4, 0.04);
        ctx.fillStyle = "#cbc4b6";
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = 0.03;
        ctx.stroke();

        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
            circle(ctx, cx + sx * 0.38, cy + sy * 0.38, 0.15, "#a9a192", dark, 0.03);
            circle(ctx, cx + sx * 0.38, cy + sy * 0.38, 0.08, "#8e8576");
        });

        // gate, facing the road
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(facing);
        ctx.fillStyle = "#4a3a2a";
        roundRect(ctx, 0.3, -0.13, 0.12, 0.26, 0.04);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = "#4b4237";
        ctx.lineWidth = 0.025;
        ctx.beginPath();
        ctx.moveTo(cx, cy + 0.1);
        ctx.lineTo(cx, cy - 0.38);
        ctx.stroke();
        const flutter = Math.sin(clock * 4) * 0.03;
        ctx.fillStyle = "#b5523f";
        ctx.beginPath();
        ctx.moveTo(cx, cy - 0.38);
        ctx.quadraticCurveTo(cx + 0.14, cy - 0.36 + flutter, cx + 0.28, cy - 0.31);
        ctx.lineTo(cx, cy - 0.22);
        ctx.fill();

        if (hpRatio < 0.6) {
            ctx.strokeStyle = "rgba(50, 40, 30, 0.75)";
            ctx.lineWidth = 0.025;
            ctx.beginPath();
            ctx.moveTo(cx + 0.25, cy - 0.38);
            ctx.lineTo(cx + 0.16, cy - 0.24);
            ctx.lineTo(cx + 0.24, cy - 0.12);
            ctx.moveTo(cx - 0.3, cy + 0.1);
            ctx.lineTo(cx - 0.2, cy + 0.22);
            ctx.stroke();
        }
        if (hpRatio < 0.35) {
            for (let i = 0; i < 3; i++) {
                const t = (clock / 1.6 + i / 3) % 1;
                circle(ctx, cx + 0.1 + Math.sin(t * 6 + i) * 0.06, cy - 0.2 - t * 0.6, 0.08 + t * 0.14, `rgba(70, 64, 58, ${0.5 * (1 - t)})`);
            }
        }
    }

    // ---------- towers ----------
    // level 0 draws a bare tower (icons, placement ghost); 1–5 draws that many pips.
    function drawTower(c, type, level, cx, cy, angle, time, alpha = 1) {
        c.save();
        c.globalAlpha = alpha;
        roundRect(c, cx - 0.4, cy - 0.4, 0.8, 0.8, 0.12);
        c.fillStyle = level >= G.MAX_LEVEL ? "#d6c79c" : "#bdb5a6";
        c.fill();
        c.strokeStyle = level >= G.MAX_LEVEL ? "#a8893c" : "#857c6d";
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

        if (level > 0) {
            const start = cx - ((level - 1) * 0.14) / 2;
            for (let i = 0; i < level; i++) circle(c, start + i * 0.14, cy + 0.33, 0.045, "#e2b746", "#8d6a1c", 0.02);
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

        circle(ctx, x + 0.03, y + 0.05, r, "rgba(20, 30, 10, 0.25)");

        ctx.strokeStyle = look.skin;
        ctx.lineWidth = r * 0.32;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + px * r * 0.7, y + py * r * 0.7);
        ctx.lineTo(x + px * r * 0.6 + z.dx * r * 1.3, y + py * r * 0.6 + z.dy * r * 1.3);
        ctx.moveTo(x - px * r * 0.7, y - py * r * 0.7);
        ctx.lineTo(x - px * r * 0.6 + z.dx * r * 1.35, y - py * r * 0.6 + z.dy * r * 1.35);
        ctx.stroke();

        circle(ctx, x, y, r, look.cloth, "rgba(30, 24, 18, 0.6)", 0.025);
        const hx = x + z.dx * r * 0.35;
        const hy = y + z.dy * r * 0.35;
        circle(ctx, hx, hy, r * 0.58, look.skin, "rgba(40, 60, 25, 0.7)", 0.02);
        const ex = z.dx * r * 0.32;
        const ey = z.dy * r * 0.32;
        circle(ctx, hx + ex + px * r * 0.2, hy + ey + py * r * 0.2, r * 0.1, "#e8402f");
        circle(ctx, hx + ex - px * r * 0.2, hy + ey - py * r * 0.2, r * 0.1, "#e8402f");

        if (z.type === "king") {
            ctx.fillStyle = "#e2b746";
            ctx.strokeStyle = "#8d6a1c";
            ctx.lineWidth = 0.02;
            const cw = r * 0.55;
            ctx.beginPath();
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

        if (z.slowUntil > state.time) circle(ctx, x, y, r + 0.04, null, "rgba(150, 215, 255, 0.9)", 0.035);
        if (z.hitFlash > 0) circle(ctx, x, y, r, `rgba(255,255,255,${z.hitFlash * 4})`);

        if (z.hp < z.maxHp) {
            const bw = Math.max(0.36, r * 2);
            const bx = z.x - bw / 2;
            const by = z.y - r - 0.14;
            ctx.fillStyle = "rgba(20, 20, 20, 0.6)";
            ctx.fillRect(bx, by, bw, 0.06);
            const ratio = Math.max(0, z.hp / z.maxHp);
            ctx.fillStyle = ratio > 0.5 ? "#8fd16a" : ratio > 0.25 ? "#e6c14a" : "#e3573e";
            ctx.fillRect(bx, by, bw * ratio, 0.06);
        }
    }

    // ---------- projectiles & effects ----------
    function drawProjectile(p) {
        const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
        if (p.kind === "arrow") {
            ctx.strokeStyle = "#4a3320";
            ctx.lineWidth = 0.035;
            ctx.beginPath();
            ctx.moveTo(p.x - Math.cos(ang) * 0.2, p.y - Math.sin(ang) * 0.2);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            circle(ctx, p.x, p.y, 0.025, "#d9d2c0");
        } else if (p.kind === "shell") {
            circle(ctx, p.x, p.y, 0.08, "#262321", "#000", 0.02);
        } else if (p.kind === "shard") {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(ang);
            ctx.fillStyle = "#c6ecff";
            ctx.beginPath();
            ctx.moveTo(0.12, 0);
            ctx.lineTo(0, 0.05);
            ctx.lineTo(-0.12, 0);
            ctx.lineTo(0, -0.05);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    function drawEffect(e) {
        const t = 1 - e.ttl / e.life;
        if (e.kind === "points") {
            text(e.text, e.x, e.y - 0.2 - t * 0.4, 0.22, "#ffd866");
        } else if (e.kind === "breach") {
            text(e.text, e.x, e.y - t * 0.4, 0.3, "#ff7a62");
        } else if (e.kind === "levelup") {
            circle(ctx, e.x, e.y, 0.45 + t * 0.3, null, `rgba(255, 216, 102, ${1 - t})`, 0.05);
            text(e.text, e.x, e.y - 0.55 - t * 0.25, 0.24, "#ffe08a");
        } else if (e.kind === "splat") {
            circle(ctx, e.x, e.y, e.r * (1 + t * 0.4), `rgba(70, 90, 40, ${0.55 * (1 - t)})`);
        } else if (e.kind === "boom") {
            circle(ctx, e.x, e.y, e.r * (0.4 + t * 0.6), `rgba(255, 170, 70, ${0.55 * (1 - t)})`);
            circle(ctx, e.x, e.y, e.r * 0.35 * (1 - t), `rgba(255, 240, 180, ${0.8 * (1 - t)})`);
        } else if (e.kind === "frost") {
            circle(ctx, e.x, e.y, e.r * (0.4 + t * 0.6), `rgba(190, 235, 255, ${0.35 * (1 - t)})`, `rgba(220, 245, 255, ${0.9 * (1 - t)})`, 0.03);
        } else if (e.kind === "bolt") {
            ctx.save();
            ctx.lineJoin = "round";
            [[0.1, "rgba(190, 160, 255, 0.5)"], [0.035, "#f4eeff"]].forEach(([lw, color]) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = lw;
                ctx.beginPath();
                e.points.forEach((p, i) => {
                    if (!i) {
                        ctx.moveTo(p.x, p.y);
                        return;
                    }
                    const prev = e.points[i - 1];
                    ctx.lineTo((prev.x + p.x) / 2 + (noise(i, e.ttl * 100) - 0.5) * 0.25, (prev.y + p.y) / 2 + (noise(e.ttl * 100, i) - 0.5) * 0.25);
                    ctx.lineTo(p.x, p.y);
                });
                ctx.stroke();
            });
            ctx.restore();
        }
    }

    function drawRange(cx, cy, range, strong, ok = true) {
        circle(
            ctx, cx, cy, range,
            ok ? `rgba(255, 255, 255, ${strong ? 0.16 : 0.07})` : "rgba(230, 80, 60, 0.14)",
            ok ? `rgba(255, 255, 255, ${strong ? 0.8 : 0.35})` : "rgba(230, 80, 60, 0.7)",
            0.025
        );
    }

    // ---------- frame ----------
    function render() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (background) ctx.drawImage(background, 0, 0);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        const setup = state.phase === "setup";
        const clock = performance.now() / 1000;

        if (setup && selectedType) {
            for (let x = 0; x < G.SIZE; x++) {
                for (let y = 0; y < G.SIZE; y++) {
                    if (!G.canPlace(state, x, y)) continue;
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
                    ctx.lineWidth = 0.02;
                    roundRect(ctx, x + 0.05, y + 0.05, 0.9, 0.9, 0.1);
                    ctx.stroke();
                }
            }
        }

        // While planning, every placed tower shows its reach.
        if (setup) {
            state.towers.forEach((t) => {
                const strong = hover && hover.x === t.x && hover.y === t.y;
                drawRange(t.x + 0.5, t.y + 0.5, G.towerStats(t.type, 1).range, strong);
            });
        }

        drawCastle();
        state.effects.forEach((e) => {
            if (e.kind === "splat") drawEffect(e);
        });
        state.towers.forEach((t) => drawTower(ctx, t.type, t.level, t.x + 0.5, t.y + 0.5, t.angle, setup ? clock : state.time));
        state.zombies.forEach(drawZombie);
        state.projectiles.forEach(drawProjectile);
        state.effects.forEach((e) => {
            if (e.kind !== "splat") drawEffect(e);
        });

        if (setup && hover) {
            if (G.towerAt(state, hover.x, hover.y)) {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                ctx.lineWidth = 0.04;
                roundRect(ctx, hover.x + 0.06, hover.y + 0.06, 0.88, 0.88, 0.14);
                ctx.stroke();
            } else if (selectedType) {
                const ok = G.canPlace(state, hover.x, hover.y);
                drawRange(hover.x + 0.5, hover.y + 0.5, G.towerStats(selectedType, 1).range, true, ok);
                drawTower(ctx, selectedType, 0, hover.x + 0.5, hover.y + 0.5, -Math.PI / 2, clock, ok ? 0.75 : 0.35);
            }
        }
    }

    function frame(t) {
        const real = Math.min(0.25, (t - (lastFrame || t)) / 1000);
        lastFrame = t;
        if (state.phase === "running") {
            acc += real * speed;
            while (acc >= STEP && state.phase === "running") {
                G.step(state, STEP);
                acc -= STEP;
            }
        }
        handleEvents();
        render();
        updateUi();
        requestAnimationFrame(frame);
    }

    // ---------- toast & events ----------
    function toast(message, bad = false) {
        const el = $("toast");
        el.textContent = message;
        el.classList.toggle("is-bad", bad);
        el.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("is-on"), 1800);
    }

    function handleEvents() {
        for (const e of G.drainEvents(state)) {
            if (e.type === "wave") {
                toast(e.wave === G.WAVES ? "Final wave — the Zombie King walks" : `Wave ${e.wave}`);
            } else if (e.type === "level-up") {
                const tower = G.findTower(state, e.towerId);
                if (tower) toast(`${G.TOWERS[tower.type].name} reached level ${e.level}`);
            } else if (e.type === "king-down") {
                toast("The Zombie King falls");
            } else if (e.type === "breach") {
                const el = document.querySelector(".cd-stat--hp");
                el.classList.remove("is-hit");
                void el.offsetWidth;
                el.classList.add("is-hit");
            } else if (e.type === "end") {
                finishRun(e);
            }
        }
    }

    // ---------- overlay ----------
    function showOverlay({ eyebrow, title, body, actions }) {
        $("overlayEyebrow").textContent = eyebrow;
        $("overlayTitle").textContent = title;
        $("overlayBody").innerHTML = body;
        const box = $("overlayActions");
        box.innerHTML = "";
        actions.forEach(({ label, primary, onClick }) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `cd-btn${primary ? " cd-btn--primary" : ""}`;
            btn.textContent = label;
            btn.addEventListener("click", onClick);
            box.append(btn);
        });
        overlay.hidden = false;
        box.querySelector(".cd-btn--primary")?.focus({ preventScroll: true });
    }

    function hideOverlay() {
        overlay.hidden = true;
    }

    overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideOverlay();
    });

    function prettyDate(str) {
        const [y, m, d] = str.split("-").map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    }

    function showIntro() {
        showOverlay({
            eyebrow: `Day ${map.day} · ${prettyDate(date)}`,
            title: "Hold the castle",
            body: `
                <p>Zombies follow the road to your castle. Every one that reaches it knocks down part of the wall; lose all ${G.START_HP} walls and it falls.</p>
                <ol class="cd-howto">
                    <li>Pick three of the four towers and place them on the grass.</li>
                    <li>Press play. From then on it runs itself.</li>
                    <li>Towers level up from their kills and assists. Every zombie scores points, with a bonus if the castle survives all ${G.WAVES} waves.</li>
                </ol>`,
            actions: [{ label: "Place towers", primary: true, onClick: hideOverlay }]
        });
    }

    function untilTomorrow() {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const mins = Math.max(1, Math.round((next - now) / 60000));
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h ? `${h}h ${m}m` : `${m}m`;
    }

    function shareText(won, score) {
        const icons = state.towers.map((t) => `${SHARE_ICON[t.type]} Lv${t.level}`).join(" · ");
        const outcome = won ? `🏰 Held all ${G.WAVES} waves · ${state.hp}/${state.maxHp} walls` : `💀 Fell on wave ${state.wave} of ${G.WAVES}`;
        return `Castle Defense #${map.day} — ${score.toLocaleString()} pts\n${outcome}\n${icons}\nhttps://palmergill.com/castle-defense/`;
    }

    async function share(textToShare) {
        try {
            await navigator.clipboard.writeText(textToShare);
            toast("Result copied — paste it anywhere");
            return;
        } catch {
            /* fall through to the share sheet */
        }
        if (navigator.share) {
            try {
                await navigator.share({ text: textToShare });
                return;
            } catch {
                /* dismissed */
            }
        }
        toast("Couldn't copy the result", true);
    }

    function iconCanvas(type, level, size) {
        const c = document.createElement("canvas");
        c.width = size * 2;
        c.height = size * 2;
        const ic = c.getContext("2d");
        ic.setTransform(size * 2, 0, 0, size * 2, 0, 0);
        drawTower(ic, type, level, 0.5, 0.5, -Math.PI / 4, 0);
        return c;
    }

    function finishRun({ won, score }) {
        const isBest = record.best == null || score > record.best;
        record.runs += 1;
        if (isBest) record.best = score;
        writeRecord();

        const badge = isBest
            ? `<span class="cd-final__best">${record.runs > 1 ? "New best today" : "Today's score"}</span>`
            : `<span class="cd-final__best">Best ${record.best.toLocaleString()}</span>`;
        const bonusRows = won
            ? `<dt>Castle held</dt><dd>+${G.WIN_BONUS}</dd><dt>${state.hp} walls standing × ${G.HP_BONUS}</dt><dd>+${G.HP_BONUS * state.hp}</dd>`
            : `<dt>Fell on wave ${state.wave} of ${G.WAVES}</dt><dd>—</dd>`;
        showOverlay({
            eyebrow: `Day ${map.day}`,
            title: won ? "The castle held" : "The castle has fallen",
            body: `
                <div class="cd-final">
                    <span class="cd-final__score">${score.toLocaleString()}</span>
                    <span class="cd-final__label">points</span>
                    ${badge}
                </div>
                <dl class="cd-breakdown">
                    <dt>${state.kills} zombies put down</dt><dd>${state.score.toLocaleString()}</dd>
                    ${bonusRows}
                </dl>
                <div class="cd-result-towers" id="resultTowers"></div>
                <p class="cd-next">${date === today ? `New map in ${untilTomorrow()}` : `Replaying ${prettyDate(date)}`}</p>`,
            actions: [
                { label: "Share result", primary: true, onClick: () => share(shareText(won, score)) },
                { label: "Try again", onClick: resetRun }
            ]
        });
        const list = $("resultTowers");
        state.towers.forEach((t) => {
            const row = document.createElement("div");
            row.className = "cd-result-tower";
            row.append(iconCanvas(t.type, t.level, 30));
            row.insertAdjacentHTML("beforeend", `<span><b>${G.TOWERS[t.type].name}</b> · level ${t.level}</span><span>${t.kills} kills · ${t.assists} assists</span>`);
            list.append(row);
        });
    }

    // Same map, same towers in the same spots, fresh levels.
    function resetRun() {
        const layout = layoutOf(state);
        state = G.createGame(map);
        applyLayout(state, layout);
        selectedType = null;
        acc = 0;
        hideOverlay();
        refreshCards();
    }

    // ---------- tower cards ----------
    const cards = {};

    function buildTowerCards() {
        const box = $("towers");
        TYPES.forEach((type) => {
            const def = G.TOWERS[type];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cd-tower";
            btn.setAttribute("aria-pressed", "false");
            btn.append(iconCanvas(type, 0, 40));
            btn.insertAdjacentHTML(
                "beforeend",
                `<span class="cd-tower__name">${def.name}</span><span class="cd-tower__blurb">${def.blurb}</span><span class="cd-tower__state"></span>`
            );
            btn.addEventListener("click", () => chooseType(type));
            box.append(btn);
            cards[type] = btn;
        });
    }

    let lastCards = "";
    function refreshCards() {
        lastCards = "";
        updateCards();
    }

    function updateCards() {
        const setup = state.phase === "setup";
        const used = G.typesUsed(state);
        const sig = setup
            ? `s|${selectedType}|${state.towers.map((t) => `${t.type}@${t.x},${t.y}`).join(",")}`
            : `r|${state.towers.map((t) => `${t.level}:${t.xp}:${t.kills}:${t.assists}`).join(",")}`;
        if (sig === lastCards) return;
        lastCards = sig;
        TYPES.forEach((type) => {
            const btn = cards[type];
            const tower = state.towers.find((t) => t.type === type);
            const label = btn.querySelector(".cd-tower__state");
            btn.classList.toggle("is-placed", Boolean(tower));
            btn.classList.toggle("is-out", !tower && (!setup || used.length >= G.TOWER_LIMIT));
            btn.setAttribute("aria-pressed", String(setup && selectedType === type));
            btn.disabled = !setup;
            if (setup) {
                label.textContent = tower ? "Placed" : used.length >= G.TOWER_LIMIT ? "Not picked" : "";
            } else if (tower) {
                const need = G.xpForNext(tower);
                const floor = tower.level > 1 ? G.LEVEL_XP[tower.level - 2] : 0;
                const pct = need == null ? 100 : Math.min(100, ((tower.xp - floor) / (need - floor)) * 100);
                label.innerHTML = `<span class="cd-tower__level">Lv ${tower.level}${need == null ? " · max" : ""}</span><span class="cd-xp"><span style="width:${pct}%"></span></span>${tower.kills} K · ${tower.assists} A`;
            } else {
                label.textContent = "Not picked";
            }
        });
        $("towerCount").textContent = setup ? `${used.length}/${G.TOWER_LIMIT} placed` : "Leveling up";
        $("towersTitle").textContent = setup ? `Pick ${G.TOWER_LIMIT} of 4` : "Your towers";
        let note;
        if (!setup) note = "Levels come from kills (2 XP) and assists (1 XP).";
        else if (selectedType) note = `Click the grass to ${used.includes(selectedType) ? "move" : "place"} the ${G.TOWERS[selectedType].name}. Click a placed tower to pick it up.`;
        else if (used.length >= G.TOWER_LIMIT) note = `Ready. Want the ${G.TOWERS[TYPES.find((t) => !used.includes(t))].name} instead? Click a tower on the map to pick it up, then swap.`;
        else note = "Pick a tower to place.";
        $("towerNote").textContent = note;
    }

    function chooseType(type) {
        if (state.phase !== "setup") return;
        const placed = state.towers.some((t) => t.type === type);
        if (!placed && state.towers.length >= G.TOWER_LIMIT) {
            toast("Three towers max — click one on the map to pick it up first", true);
            return;
        }
        selectedType = selectedType === type ? null : type;
        refreshCards();
    }

    function nextUnplaced() {
        if (state.towers.length >= G.TOWER_LIMIT) return null;
        return TYPES.find((t) => !state.towers.some((tw) => tw.type === t)) || null;
    }

    // ---------- HUD ----------
    let lastHud = "";
    function updateUi() {
        updateCards();
        const hud = `${state.hp}|${state.wave}|${state.score}|${state.phase}|${state.towers.length}|${record.best}`;
        if (hud === lastHud) return;
        lastHud = hud;
        $("hpValue").textContent = state.hp;
        $("hpMax").textContent = state.maxHp;
        $("hpBar").style.width = `${(state.hp / state.maxHp) * 100}%`;
        $("hpBar").classList.toggle("is-low", state.hp / state.maxHp < 0.35);
        $("waveValue").textContent = state.wave;
        $("scoreValue").textContent = state.score.toLocaleString();
        $("bestValue").textContent = record.best == null ? "—" : record.best.toLocaleString();

        const play = $("playButton");
        if (state.phase === "setup") {
            const missing = G.TOWER_LIMIT - state.towers.length;
            play.disabled = missing > 0;
            $("playLabel").textContent = "Play";
            $("playHint").textContent = missing > 0 ? `Place ${missing} more` : "";
        } else if (state.phase === "running") {
            play.disabled = true;
            $("playLabel").textContent = "Defending…";
            $("playHint").textContent = `wave ${state.wave} of ${G.WAVES}`;
        } else {
            play.disabled = false;
            $("playLabel").textContent = "Try again";
            $("playHint").textContent = "";
        }
    }

    // ---------- input ----------
    function tileFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * G.SIZE);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * G.SIZE);
        if (x < 0 || y < 0 || x >= G.SIZE || y >= G.SIZE) return null;
        return { x, y };
    }

    canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType === "mouse") hover = tileFromEvent(e);
    });
    canvas.addEventListener("pointerleave", () => { hover = null; });
    canvas.addEventListener("click", (e) => {
        if (state.phase !== "setup") return;
        const tile = tileFromEvent(e);
        if (!tile) return;
        const tower = G.towerAt(state, tile.x, tile.y);
        if (tower) {
            G.removeTower(state, tower.id);
            selectedType = tower.type;
            toast(`Picked up the ${G.TOWERS[tower.type].name}`);
            saveLayout();
            refreshCards();
            return;
        }
        if (!selectedType) {
            toast("Pick a tower first", true);
            return;
        }
        const res = G.placeTower(state, selectedType, tile.x, tile.y);
        if (!res.ok) {
            toast(res.reason, true);
            return;
        }
        selectedType = res.moved ? null : nextUnplaced();
        saveLayout();
        refreshCards();
    });

    // Keep the layout across reloads while you're still planning.
    function saveLayout() {
        record.layout = layoutOf(state);
        writeRecord();
    }

    $("playButton").addEventListener("click", startOrRetry);

    function startOrRetry() {
        if (state.phase === "won" || state.phase === "lost") {
            resetRun();
            return;
        }
        const res = G.startRun(state);
        if (!res.ok) {
            toast(res.reason, true);
            return;
        }
        selectedType = null;
        hover = null;
        saveLayout();
        refreshCards();
    }

    document.querySelectorAll("[data-speed]").forEach((btn) => {
        btn.addEventListener("click", () => {
            speed = Number(btn.dataset.speed);
            document.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        });
    });

    document.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || !overlay.hidden) return;
        const key = e.key.toLowerCase();
        if (["1", "2", "3", "4"].includes(key)) {
            chooseType(TYPES[Number(key) - 1]);
        } else if (key === "enter" && e.target.tagName !== "BUTTON") {
            startOrRetry();
        } else if (key === "escape") {
            selectedType = null;
            refreshCards();
        }
    });

    // ---------- boot ----------
    function describeHorde() {
        const c = { walker: 0, runner: 0, brute: 0, king: 0 };
        map.waves.forEach((w) => w.forEach((s) => { c[s.type] += 1; }));
        const lean = { walker: "Walkers", runner: "Runners", brute: "Brutes" }[map.lean];
        const total = c.walker + c.runner + c.brute + c.king;
        $("horde").innerHTML = `Heavy on <b>${lean}</b> today. ${total} zombies over ${G.WAVES} waves: ${c.walker} walkers, ${c.runner} runners, ${c.brute} brutes, and the <b>Zombie King</b> at the end.`;
    }

    $("dayLabel").textContent = `Daily puzzle · Day ${map.day}${date !== today ? ` · ${date}` : ""}`;
    $("waveMax").textContent = G.WAVES;
    $("hpMax").textContent = G.START_HP;
    $("winBonus").textContent = G.WIN_BONUS;
    $("hpBonus").textContent = G.HP_BONUS;
    $("xpRule").textContent = G.LEVEL_XP.join(" / ");
    describeHorde();
    buildTowerCards();
    applyLayout(state, record.layout);
    selectedType = nextUnplaced();
    refreshCards();
    if (!record.runs) showIntro();
    new ResizeObserver(resize).observe(wrap);
    resize();
    requestAnimationFrame(frame);
})();
