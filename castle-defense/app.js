// Castle Defense page: draws the engine's state on a canvas and forwards
// clicks and keys to it. All rules live in castleDefenseGame.js.
(function () {
    const G = window.CastleDefenseGame;
    const STEP = G.STEP;
    const TYPES = [...G.TOWER_TYPES, ...G.TRAP_TYPES];
    const SHARE_ICON = { archer: "🏹", cannon: "💣", frost: "❄️", mage: "🔮", spikes: "🔱", tar: "🛢️", mine: "💥" };

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
    const storeKey = `castle-defense:v4:${date}`;

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
            return { best: null, runs: 0, layout: null, pending: null, ...JSON.parse(localStorage.getItem(storeKey) || "{}") };
        } catch {
            return { best: null, runs: 0, layout: null, pending: null };
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
        return s.defenses.map((d) => ({ type: d.type, x: d.x, y: d.y }));
    }

    function applyLayout(s, layout) {
        (layout || []).forEach((d) => G.place(s, d.type, d.x, d.y));
    }

    // Keep the layout across reloads while you're still planning.
    function saveLayout() {
        record.layout = layoutOf(state);
        writeRecord();
    }

    // ---------- leaderboard ----------
    // Only today's map is ranked; ?date= replays are for practice.
    const ranked = date === today;
    const API = `${window.API_ORIGIN || ""}/api/castle-defense`;
    // The latest post of this run: { kills, best, players } or { signedOut }.
    let placement = null;
    let posting = null;

    async function api(path, options = {}) {
        const response = await fetch(`${API}${path}`, {
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...options,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(typeof data.detail === "string" ? data.detail : "The leaderboard didn't answer.");
            err.status = response.status;
            throw err;
        }
        return data;
    }

    function ordinal(n) {
        const tens = n % 100;
        if (tens >= 11 && tens <= 13) return `${n}th`;
        return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
    }

    function placeText(best, players) {
        return `${ordinal(best.rank)} of ${players} today`;
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    // Rows for a board: the top `limit`, plus your own row if you're further down.
    function boardRows(board, limit) {
        const shown = board.entries.slice(0, limit);
        const row = (e) => `<li class="${e.you ? "is-you" : ""}"><span class="cd-board__rank">${e.rank}</span><span class="cd-board__name">${escapeHtml(e.name)}${e.you ? " (you)" : ""}</span><span class="cd-board__kills">${e.kills.toLocaleString()} <small>w${e.wave}</small></span></li>`;
        let html = shown.map(row).join("");
        if (board.you && !shown.some((e) => e.you)) html += `<li class="is-gap">…</li>${row(board.you)}`;
        return html;
    }

    async function loadBoard() {
        const note = $("boardNote");
        if (!ranked) {
            $("boardTitle").textContent = "Leaderboard";
            $("board-list").innerHTML = "";
            note.innerHTML = `You're replaying ${escapeHtml(prettyDate(date))}. Only today's map is ranked — <a href="/castle-defense/">play today's</a>.`;
            return;
        }
        try {
            const board = await api(`/leaderboard?day=${date}`);
            renderBoard(board);
            return board;
        } catch {
            note.textContent = "The leaderboard couldn't be loaded right now.";
            return null;
        }
    }

    function renderBoard(board) {
        $("board-list").innerHTML = boardRows(board, 10);
        $("boardCount").textContent = board.players ? `${board.players} ${board.players === 1 ? "player" : "players"}` : "";
        const note = $("boardNote");
        if (!board.players) note.textContent = "No scores yet today. Be the first.";
        else if (board.you) note.textContent = `You're ${placeText(board.you, board.players)}. Your best run counts.`;
        else note.innerHTML = `<a href="${signInHref()}">Sign in</a> to put your runs on the board.`;
    }

    function signInHref() {
        return `/login/?next=${encodeURIComponent("/castle-defense/")}`;
    }

    // Post a finished run. The server replays the layout and keeps the
    // account's best; anything signed out is kept to post after sign-in.
    function postRun(layout) {
        if (!ranked) return Promise.resolve(null);
        posting = api("/runs", { method: "POST", body: { day: date, layout } })
            .then(async (res) => {
                placement = res;
                if (record.pending) {
                    record.pending = null;
                    writeRecord();
                }
                res.board = await loadBoard();
                return res;
            })
            .catch((err) => {
                if (err.status === 403) {
                    record.pending = layout;
                    writeRecord();
                    placement = { signedOut: true };
                } else {
                    placement = { error: err.message };
                }
                return placement;
            });
        return posting;
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

    function text(str, x, y, size, color, outline = true) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = `800 ${Math.max(10, (size * scale) / dpr)}px "Plus Jakarta Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (outline) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(30, 26, 20, 0.6)";
            ctx.strokeText(str, (x * scale) / dpr, (y * scale) / dpr);
        }
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

    // ---------- defenses ----------
    function drawTower(c, type, cx, cy, angle, time, alpha = 1) {
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
        c.restore();
    }

    // `armed` is 0–1 for a mine re-arming; `active` means something is on the trap.
    function drawTrap(c, type, cx, cy, time, { alpha = 1, armed = 1, active = false } = {}) {
        c.save();
        c.globalAlpha = alpha;
        if (type === "spikes") {
            roundRect(c, cx - 0.32, cy - 0.32, 0.64, 0.64, 0.06);
            c.fillStyle = "#77736c";
            c.fill();
            c.strokeStyle = "#4f4c47";
            c.lineWidth = 0.03;
            c.stroke();
            const lift = active ? 0.04 : 0;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    const sx = cx - 0.2 + i * 0.2;
                    const sy = cy - 0.2 + j * 0.2;
                    c.fillStyle = "#d9d6cf";
                    c.beginPath();
                    c.moveTo(sx, sy - 0.08 - lift);
                    c.lineTo(sx + 0.06, sy + 0.05);
                    c.lineTo(sx - 0.06, sy + 0.05);
                    c.closePath();
                    c.fill();
                }
            }
        } else if (type === "tar") {
            c.fillStyle = "#2b2420";
            c.beginPath();
            c.ellipse(cx, cy, 0.36, 0.3, 0.3, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = "rgba(255, 255, 255, 0.12)";
            c.beginPath();
            c.ellipse(cx - 0.12, cy - 0.1, 0.12, 0.05, 0.3, 0, Math.PI * 2);
            c.fill();
            for (let i = 0; i < 3; i++) {
                const t = (time * 0.7 + i / 3) % 1;
                circle(c, cx + Math.sin(i * 2.1) * 0.18, cy + Math.cos(i * 1.7) * 0.12, 0.03 + t * 0.04, null, `rgba(120, 100, 85, ${1 - t})`, 0.02);
            }
        } else if (type === "mine") {
            circle(c, cx, cy, 0.24, "#4d4a45", "#2a2825", 0.035);
            circle(c, cx, cy, 0.15, "#6a665f");
            const ready = armed >= 1;
            const blink = ready ? 0.5 + 0.5 * Math.sin(time * 6) : 0.2;
            circle(c, cx, cy, 0.06, ready ? `rgba(230, 70, 50, ${0.5 + blink * 0.5})` : "#5a3a30");
            if (!ready) {
                c.strokeStyle = "rgba(255, 255, 255, 0.7)";
                c.lineWidth = 0.035;
                c.beginPath();
                c.arc(cx, cy, 0.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * armed);
                c.stroke();
            }
        }
        c.restore();
    }

    function drawDefense(c, d, time, alpha = 1) {
        if (G.DEFENSES[d.type].kind === "trap") {
            const s = G.stats(d.type, d.level || 1);
            const armed = d.type === "mine" && d.cooldown > 0 ? 1 - d.cooldown / s.rearm : 1;
            drawTrap(c, d.type, d.x + 0.5, d.y + 0.5, time, { alpha, armed, active: d.active });
        } else {
            drawTower(c, d.type, d.x + 0.5, d.y + 0.5, d.angle ?? -Math.PI / 2, time, alpha);
        }
    }

    // A small numbered badge in the corner once something has levelled.
    function drawLevel(d) {
        if (d.level < 2) return;
        const bx = d.x + 0.82;
        const by = d.y + 0.82;
        circle(ctx, bx, by, 0.15, d.level >= G.MAX_LEVEL ? "#e2b746" : "#fff7e0", "#8d6a1c", 0.025);
        text(String(d.level), bx, by + 0.005, 0.17, "#5a4310", false);
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
            text(e.text, e.x, e.y - 0.2 - t * 0.4, 0.2, "#ffd866");
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
        const time = setup ? clock : state.time;

        // While choosing, outline every tile the selected item could go on.
        if (setup && selectedType) {
            for (let x = 0; x < G.SIZE; x++) {
                for (let y = 0; y < G.SIZE; y++) {
                    const problem = G.placementProblem(state, selectedType, x, y);
                    if (problem && !/left/.test(problem)) continue;
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
                    ctx.lineWidth = 0.02;
                    roundRect(ctx, x + 0.05, y + 0.05, 0.9, 0.9, 0.1);
                    ctx.stroke();
                }
            }
        }

        // While planning, every tower shows its reach.
        if (setup) {
            state.defenses.forEach((d) => {
                if (d.kind !== "tower") return;
                const strong = hover && hover.x === d.x && hover.y === d.y;
                drawRange(d.x + 0.5, d.y + 0.5, G.stats(d.type, 1).range, strong);
            });
        }

        state.defenses.forEach((d) => {
            if (d.kind === "trap") drawDefense(ctx, d, time);
        });
        drawCastle();
        state.effects.forEach((e) => {
            if (e.kind === "splat") drawEffect(e);
        });
        state.defenses.forEach((d) => {
            if (d.kind === "tower") drawDefense(ctx, d, time);
        });
        state.zombies.forEach(drawZombie);
        state.projectiles.forEach(drawProjectile);
        state.defenses.forEach(drawLevel);
        state.effects.forEach((e) => {
            if (e.kind !== "splat") drawEffect(e);
        });

        if (setup && hover) {
            if (G.defenseAt(state, hover.x, hover.y)) {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                ctx.lineWidth = 0.04;
                roundRect(ctx, hover.x + 0.06, hover.y + 0.06, 0.88, 0.88, 0.14);
                ctx.stroke();
            } else if (selectedType) {
                const ok = G.canPlace(state, selectedType, hover.x, hover.y);
                const ghost = { type: selectedType, x: hover.x, y: hover.y, level: 1, angle: -Math.PI / 2 };
                if (G.DEFENSES[selectedType].kind === "tower") drawRange(hover.x + 0.5, hover.y + 0.5, G.stats(selectedType, 1).range, true, ok);
                drawDefense(ctx, ghost, clock, ok ? 0.75 : 0.35);
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
                toast(e.wave % G.KING_EVERY === 0 ? `Wave ${e.wave} — the Zombie King walks` : `Wave ${e.wave}`);
            } else if (e.type === "level-up") {
                const d = G.findDefense(state, e.id);
                if (d && e.level % 2 === 0) toast(`${G.DEFENSES[d.type].name} reached level ${e.level}`);
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
            btn.addEventListener("click", () => onClick(btn));
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
                <p>Zombies follow the road to your castle, and they never stop coming. Each one that gets in knocks down part of the wall; lose all ${G.START_HP} walls and it falls.</p>
                <ol class="cd-howto">
                    <li>Place today's towers and traps — everyone gets the same 0–${G.MAX_EACH} of each. Towers go on the grass, traps on the road.</li>
                    <li>Press play. From then on it runs itself, and everything levels up from its kills.</li>
                    <li>Your score is how many zombies you kill before the castle falls.</li>
                </ol>`,
            actions: [{ label: "Start building", primary: true, onClick: hideOverlay }]
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

    function buildSummary() {
        const counts = {};
        state.defenses.forEach((d) => { counts[d.type] = (counts[d.type] || 0) + 1; });
        return TYPES.filter((t) => counts[t]).map((t) => `${SHARE_ICON[t]}${counts[t] > 1 ? `×${counts[t]}` : ""}`).join(" ");
    }

    function shareText(kills, wave) {
        const lines = [`Castle Defense #${map.day} — ${kills.toLocaleString()} zombies`];
        if (placement && placement.best) {
            const medal = { 1: " 🥇", 2: " 🥈", 3: " 🥉" }[placement.best.rank] || "";
            const which = placement.improved ? "" : " (my best today)";
            lines.push(`🏆 ${placeText(placement.best, placement.players)}${medal}${which}`);
        }
        lines.push(`🏰 Fell on wave ${wave}`, buildSummary(), "https://palmergill.com/castle-defense/");
        return lines.join("\n");
    }

    async function copyText(str) {
        try {
            await navigator.clipboard.writeText(str);
            return true;
        } catch {
            // Older browsers, or a page without clipboard permission.
            const area = document.createElement("textarea");
            area.value = str;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.append(area);
            area.select();
            let ok = false;
            try {
                ok = document.execCommand("copy");
            } catch {
                ok = false;
            }
            area.remove();
            return ok;
        }
    }

    // Phones get the share sheet; everywhere else copies, and the button
    // itself says so — a toast would sit underneath this card.
    async function share(str, btn) {
        if (navigator.share && matchMedia("(pointer: coarse)").matches) {
            try {
                await navigator.share({ text: str });
                return;
            } catch (err) {
                if (err && err.name === "AbortError") return;
            }
        }
        if (await copyText(str)) {
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = "Share result"; }, 2000);
            return;
        }
        if (!$("shareFallback")) {
            const area = document.createElement("textarea");
            area.id = "shareFallback";
            area.className = "cd-share-fallback";
            area.readOnly = true;
            area.value = str;
            area.setAttribute("aria-label", "Your result — copy it from here");
            $("overlayBody").append(area);
        }
        $("shareFallback").select();
        btn.textContent = "Copy the text above";
    }

    function iconCanvas(type, size) {
        const c = document.createElement("canvas");
        c.width = size * 2;
        c.height = size * 2;
        const ic = c.getContext("2d");
        ic.setTransform(size * 2, 0, 0, size * 2, 0, 0);
        if (G.DEFENSES[type].kind === "trap") {
            roundRect(ic, 0.06, 0.06, 0.88, 0.88, 0.14);
            ic.fillStyle = "#c4a06b";
            ic.fill();
            drawTrap(ic, type, 0.5, 0.5, 0);
        } else {
            drawTower(ic, type, 0.5, 0.5, -Math.PI / 4, 0);
        }
        return c;
    }

    function finishRun({ kills, wave }) {
        const isBest = record.best == null || kills > record.best;
        record.runs += 1;
        if (isBest) record.best = kills;
        writeRecord();

        const badge = isBest
            ? `<span class="cd-final__best">${record.runs > 1 ? "New best today" : "Today's score"}</span>`
            : `<span class="cd-final__best">Best ${record.best.toLocaleString()}</span>`;
        const top = state.defenses.slice().sort((a, b) => b.kills - a.kills).slice(0, 4);
        showOverlay({
            eyebrow: `Day ${map.day}`,
            title: `The castle fell on wave ${wave}`,
            body: `
                <div class="cd-final">
                    <span class="cd-final__score">${kills.toLocaleString()}</span>
                    <span class="cd-final__label">zombies killed</span>
                    ${badge}
                </div>
                <p class="cd-place is-muted" id="placeLine"${ranked ? "" : " hidden"}>Posting to today's leaderboard…</p>
                <div class="cd-result-towers" id="resultTowers"></div>
                <section class="cd-result-board" id="resultBoard" hidden>
                    <h3 class="cd-group">Today's top 10 <span class="cd-result-board__count"></span></h3>
                    <ol class="cd-board"></ol>
                </section>
                <p class="cd-next">${date === today ? `New map in ${untilTomorrow()}` : `Replaying ${prettyDate(date)}`}</p>`,
            actions: [
                {
                    label: "Share result",
                    primary: true,
                    onClick: async (btn) => {
                        // The place belongs in the message, so let the post land first.
                        if (posting) await posting;
                        share(shareText(kills, wave), btn);
                    }
                },
                { label: "Try again", onClick: resetRun }
            ]
        });
        const list = $("resultTowers");
        top.forEach((d) => {
            const row = document.createElement("div");
            row.className = "cd-result-tower";
            row.append(iconCanvas(d.type, 30));
            row.insertAdjacentHTML("beforeend", `<span><b>${G.DEFENSES[d.type].name}</b> · level ${d.level}</span><span>${d.kills} kills · ${d.assists} assists</span>`);
            list.append(row);
        });
        placement = null;
        postRun(layoutOf(state)).then(async (res) => {
            showPlacement(res);
            if (!ranked) return;
            // Signed out or not, the day's top 10 is public.
            showResultBoard(res && res.board ? res.board : await loadBoard());
        });
    }

    function showResultBoard(board) {
        const box = $("resultBoard");
        if (!box || !board || !board.entries.length) return;
        box.hidden = false;
        box.querySelector("ol").innerHTML = boardRows(board, 10);
        box.querySelector(".cd-result-board__count").textContent = `${board.players} ${board.players === 1 ? "player" : "players"}`;
    }

    function showPlacement(res) {
        const line = $("placeLine");
        if (!line || !res) return;
        line.classList.toggle("is-muted", !res.best);
        if (res.best) {
            const best = res.improved
                ? `You're <b>${placeText(res.best, res.players)}</b>.`
                : `Your best today (${res.best.kills.toLocaleString()}) still stands — <b>${placeText(res.best, res.players)}</b>.`;
            line.innerHTML = best;
        } else if (res.signedOut) {
            line.innerHTML = `<a href="${signInHref()}">Sign in</a> to put this run on today's leaderboard — it'll post when you're back.`;
        } else {
            line.textContent = `Couldn't post this run: ${res.error}`;
        }
    }

    // Same map, same layout, fresh levels and a full purse.
    function resetRun() {
        const layout = layoutOf(state);
        state = G.createGame(map);
        applyLayout(state, layout);
        selectedType = null;
        acc = 0;
        hideOverlay();
        refreshPanel();
    }

    // ---------- shop & roster ----------
    const cards = {};

    function buildShop() {
        TYPES.forEach((type, i) => {
            const def = G.DEFENSES[type];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cd-tower";
            btn.setAttribute("aria-pressed", "false");
            btn.setAttribute("aria-keyshortcuts", String(i + 1));
            btn.append(iconCanvas(type, 40));
            btn.insertAdjacentHTML(
                "beforeend",
                `<span class="cd-tower__name">${def.name}</span><span class="cd-tower__blurb">${def.blurb}</span><span class="cd-tower__state"><span class="cd-tower__count"></span></span>`
            );
            btn.addEventListener("click", () => chooseType(type));
            $(def.kind === "tower" ? "shopTowers" : "shopTraps").append(btn);
            cards[type] = btn;
        });
    }

    let lastPanel = "";
    function refreshPanel() {
        lastPanel = "";
        updatePanel();
    }

    function updatePanel() {
        const setup = state.phase === "setup";
        const sig = setup
            ? `s|${selectedType}|${layoutOf(state).map((d) => `${d.type}@${d.x},${d.y}`).join(",")}`
            : `r|${state.defenses.map((d) => `${d.level}:${d.xp}:${d.kills}:${d.assists}`).join(",")}`;
        if (sig === lastPanel) return;
        lastPanel = sig;

        $("shop").hidden = !setup;
        $("roster").hidden = setup;
        const left = TYPES.reduce((n, t) => n + state.stock[t], 0);
        $("shopTitle").textContent = setup ? "Today's defenses" : "Your defenses";
        const count = $("pieceCount");
        count.textContent = setup ? `${left} to place` : `${state.defenses.length} built`;
        count.classList.toggle("is-out", setup && left === 0);

        if (setup) {
            TYPES.forEach((type) => {
                const btn = cards[type];
                const given = map.allotment[type];
                const remaining = state.stock[type];
                btn.setAttribute("aria-pressed", String(selectedType === type));
                btn.classList.toggle("is-poor", remaining === 0);
                btn.disabled = given === 0;
                btn.querySelector(".cd-tower__count").textContent = given ? `${remaining} of ${given} left` : "None today";
            });
            let note;
            if (selectedType) {
                const def = G.DEFENSES[selectedType];
                note = `Click ${def.kind === "tower" ? "the grass" : "the road"} to place ${/^[AEIOU]/.test(def.name) ? "an" : "a"} ${def.name}. Click anything you placed to pick it back up.`;
            } else if (!state.defenses.length) {
                note = "Pick a tower or trap to start building.";
            } else {
                note = left
                    ? `${left} more to place. You don't have to use them all — click anything you placed to pick it up, or press play.`
                    : "Everything's placed. Click anything to pick it up and move it, or press play.";
            }
            $("shopNote").textContent = note;
        } else {
            renderRoster();
            $("shopNote").textContent = "Levels come from kills (2 XP) and assists (1 XP).";
        }
    }

    function renderRoster() {
        const box = $("roster");
        box.innerHTML = "";
        state.defenses
            .slice()
            .sort((a, b) => b.kills + b.assists - (a.kills + a.assists))
            .forEach((d) => {
                const def = G.DEFENSES[d.type];
                const need = G.xpForNext(d);
                const floor = d.level > 1 ? G.LEVEL_XP[d.level - 2] : 0;
                const pct = need == null ? 100 : Math.min(100, ((d.xp - floor) / (need - floor)) * 100);
                const row = document.createElement("div");
                row.className = "cd-tower is-placed";
                row.append(iconCanvas(d.type, 40));
                row.insertAdjacentHTML(
                    "beforeend",
                    `<span class="cd-tower__name">${def.name}</span><span class="cd-tower__blurb">${def.kind === "tower" ? "Tower" : "Trap"} at ${"ABCDEFGH"[d.x]}${d.y + 1}</span><span class="cd-tower__state"><span class="cd-tower__level">Lv ${d.level}${need == null ? " · max" : ""}</span><span class="cd-xp"><span style="width:${pct}%"></span></span>${d.kills} K · ${d.assists} A</span>`
                );
                box.append(row);
            });
    }

    function chooseType(type) {
        if (state.phase !== "setup") return;
        selectedType = selectedType === type ? null : type;
        refreshPanel();
    }

    // ---------- HUD ----------
    let lastHud = "";
    function updateUi() {
        updatePanel();
        const hud = `${state.hp}|${state.wave}|${state.kills}|${state.phase}|${state.defenses.length}|${record.best}`;
        if (hud === lastHud) return;
        lastHud = hud;
        $("hpValue").textContent = state.hp;
        $("hpMax").textContent = state.maxHp;
        $("hpBar").style.width = `${(state.hp / state.maxHp) * 100}%`;
        $("hpBar").classList.toggle("is-low", state.hp / state.maxHp < 0.35);
        $("waveValue").textContent = state.wave;
        $("scoreValue").textContent = state.kills.toLocaleString();
        $("bestValue").textContent = record.best == null ? "—" : record.best.toLocaleString();

        const play = $("playButton");
        if (state.phase === "setup") {
            play.disabled = !state.defenses.length;
            $("playLabel").textContent = "Play";
            $("playHint").textContent = state.defenses.length ? "" : "Build something first";
        } else if (state.phase === "running") {
            play.disabled = true;
            $("playLabel").textContent = "Defending…";
            $("playHint").textContent = `wave ${state.wave}`;
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
        const existing = G.defenseAt(state, tile.x, tile.y);
        if (existing) {
            const res = G.remove(state, existing.id);
            selectedType = existing.type;
            toast(`Picked up the ${G.DEFENSES[existing.type].name}`);
            saveLayout();
            refreshPanel();
            return;
        }
        if (!selectedType) {
            toast("Pick a tower or trap first", true);
            return;
        }
        const res = G.place(state, selectedType, tile.x, tile.y);
        if (!res.ok) {
            toast(res.reason, true);
            return;
        }
        if (!state.stock[selectedType]) selectedType = null;
        saveLayout();
        refreshPanel();
    });

    $("playButton").addEventListener("click", startOrRetry);

    function startOrRetry() {
        if (state.phase === "over") {
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
        refreshPanel();
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
        const n = Number(key);
        if (n >= 1 && n <= TYPES.length) {
            chooseType(TYPES[n - 1]);
        } else if (key === "enter" && e.target.tagName !== "BUTTON") {
            startOrRetry();
        } else if (key === "escape") {
            selectedType = null;
            refreshPanel();
        }
    });

    // ---------- boot ----------
    function describeHorde() {
        const lean = { walker: "Walkers", runner: "Runners", brute: "Brutes" }[map.lean];
        const first = G.waveSpawns(map, 1).length;
        $("horde").innerHTML = `Heavy on <b>${lean}</b> today. Wave 1 is ${first} zombies; every wave after is bigger and tougher, and the <b>Zombie King</b> joins every ${G.KING_EVERY}th. It doesn't stop until the castle falls.`;
    }

    $("dayLabel").textContent = `Daily puzzle · Day ${map.day}${date !== today ? ` · ${date}` : ""}`;
    $("hpMax").textContent = G.START_HP;
    $("maxLevel").textContent = G.MAX_LEVEL;
    describeHorde();
    buildShop();
    applyLayout(state, record.layout);
    refreshPanel();
    if (!record.runs) showIntro();
    loadBoard();
    // A run finished while signed out posts itself once you're signed in.
    // The nav publishes window.SiteSession on DOMContentLoaded, which is
    // after this script runs, so wait for it.
    const siteSession = () => new Promise((resolve) => {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => resolve(window.SiteSession), { once: true });
        } else {
            resolve(window.SiteSession);
        }
    });
    if (ranked && record.pending) {
        siteSession().then((session) => {
            if (!session || !session.authenticated) return;
            postRun(record.pending).then((res) => {
                if (res && res.best) toast(`Posted your run — ${placeText(res.best, res.players)}`);
            });
        });
    }
    new ResizeObserver(resize).observe(wrap);
    resize();
    requestAnimationFrame(frame);
})();
