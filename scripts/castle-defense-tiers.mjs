// Sets Castle Defense's daily tiers. For every day in the range and each
// mode, it plays TRIALS seeded variations of that day's allotment (see
// castle-defense-trials.cjs) and puts each tier's kill count where the
// matching share of them fall short: tier 2 beats 40% of trials, tier 3 60%,
// tier 4 80%, tier 5 90%. Tier 1 is any score. Writes
// castle-defense/tiers.json, which the page reads.
//
//   node scripts/castle-defense-tiers.mjs [from YYYY-MM-DD] [to YYYY-MM-DD]
//
// Rerun after any balance change: the file records the rules it was made
// under, and the page ignores tiers from other rules.
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const TRIALS = 300;
// The share of trials that fall short of tiers 2–5.
const FAIL_SHARES = [0.4, 0.6, 0.8, 0.9];
const OUT = fileURLToPath(new URL("../castle-defense/tiers.json", import.meta.url));

if (!isMainThread) {
    const G = require("../castle-defense/castleDefenseGame.js");
    const { runTrials, cutoffFor } = require("./castle-defense-trials.cjs");
    parentPort.on("message", (date) => {
        const day = {};
        for (const mode of G.MODES) {
            const kills = runTrials(date, mode, TRIALS).map((t) => t.kills);
            // Ties at the bottom can stack two cut-offs on one score; each
            // tier still needs at least one more kill than the one below.
            const cuts = [];
            FAIL_SHARES.forEach((fail) => {
                const cut = cutoffFor(kills, +(1 - fail).toFixed(6));
                cuts.push(Math.max(cut, (cuts[cuts.length - 1] || 0) + 1));
            });
            day[mode] = cuts;
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
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
    // Tiers made under other rules or cut-offs are thrown away, not merged.
    const days = old && same(old.rules, G.RULES_BY_MODE) && same(old.failShares, FAIL_SHARES) ? old.days : {};
    const queue = dates.slice();
    let done = 0;
    const started = Date.now();
    const finish = () => {
        const sorted = Object.entries(days).sort(([a], [b]) => a.localeCompare(b));
        // One day per line keeps the diff of a regeneration readable.
        const lines = sorted.map(([date, day]) => `    ${JSON.stringify(date)}: ${JSON.stringify(day)}`);
        writeFileSync(
            OUT,
            `{\n  "rules": ${JSON.stringify(G.RULES_BY_MODE)},\n  "trials": ${TRIALS},\n  "failShares": ${JSON.stringify(FAIL_SHARES)},\n  "days": {\n${lines.join(",\n")}\n  }\n}\n`
        );
    };
    const workers = Math.min(availableParallelism(), queue.length);
    let live = workers;
    for (let i = 0; i < workers; i++) {
        const w = new Worker(fileURLToPath(import.meta.url));
        const next = () => (queue.length ? w.postMessage(queue.shift()) : (w.terminate(), --live || finish()));
        w.on("message", ({ date, day }) => {
            days[date] = day;
            done += 1;
            console.log(`${date}  ${Object.entries(day).map(([m, c]) => `${m} ${c.join("/")}`).join(", ")}  [${done}/${dates.length}, ${Math.round((Date.now() - started) / 1000)}s]`);
            next();
        });
        next();
    }
}
