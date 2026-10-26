// Sets Castle Defense's daily goals. For every day in the range and each
// mode, it plays TRIALS seeded variations of that day's allotment (see
// castle-defense-trials.cjs) and sets the goal where FAIL_SHARE of them fall
// short. Writes castle-defense/goals.json, which the page reads.
//
//   node scripts/castle-defense-goals.mjs [from YYYY-MM-DD] [to YYYY-MM-DD]
//
// Rerun after any balance change: the file records the rules it was made
// under, and the page ignores goals from other rules.
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const TRIALS = 300;
const FAIL_SHARE = 0.8;
const OUT = fileURLToPath(new URL("../castle-defense/goals.json", import.meta.url));

if (!isMainThread) {
    const G = require("../castle-defense/castleDefenseGame.js");
    const { runTrials, goalFor } = require("./castle-defense-trials.cjs");
    parentPort.on("message", (date) => {
        const day = {};
        for (const mode of G.MODES) {
            const kills = runTrials(date, mode, TRIALS).map((t) => t.kills);
            const goal = goalFor(kills, +(1 - FAIL_SHARE).toFixed(6));
            day[mode] = { goal, fail: +(kills.filter((k) => k < goal).length / kills.length).toFixed(3) };
        }
        parentPort.postMessage({ date, day });
    });
} else {
    const G = require("../castle-defense/castleDefenseGame.js");
    const [from = G.localDateString(), to = "2027-12-31"] = process.argv.slice(2);
    const dates = [];
    for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
    }
    const sameRules = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
    // Goals made under other rules are thrown away, not merged.
    const days = old && sameRules(old.rules, G.RULES_BY_MODE) ? old.days : {};
    const queue = dates.slice();
    let done = 0;
    const started = Date.now();
    const finish = () => {
        const sorted = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
        // One day per line keeps the diff of a regeneration readable.
        const lines = Object.entries(sorted).map(([date, day]) => `    ${JSON.stringify(date)}: ${JSON.stringify(day)}`);
        writeFileSync(OUT, `{\n  "rules": ${JSON.stringify(G.RULES_BY_MODE)},\n  "trials": ${TRIALS},\n  "failShare": ${FAIL_SHARE},\n  "days": {\n${lines.join(",\n")}\n  }\n}\n`);
    };
    const workers = Math.min(availableParallelism(), queue.length);
    let live = workers;
    for (let i = 0; i < workers; i++) {
        const w = new Worker(fileURLToPath(import.meta.url));
        const next = () => (queue.length ? w.postMessage(queue.shift()) : (w.terminate(), --live || finish()));
        w.on("message", ({ date, day }) => {
            days[date] = Object.fromEntries(Object.entries(day).map(([m, v]) => [m, v.goal]));
            done += 1;
            const fails = Object.entries(day).map(([m, v]) => `${m} ${v.goal} (${Math.round(v.fail * 100)}% fail)`).join(", ");
            console.log(`${date}  ${fails}  [${done}/${dates.length}, ${Math.round((Date.now() - started) / 1000)}s]`);
            next();
        });
        next();
    }
}
