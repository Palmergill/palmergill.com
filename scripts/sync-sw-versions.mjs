#!/usr/bin/env node
// Keep each app's sw.js STATIC_ASSETS in step with the ?v= assets its
// index.html loads. Bumps stale versions in place and appends anything the
// page loads that the worker doesn't list yet.
//
//   node scripts/sync-sw-versions.mjs          rewrite workers, print what changed
//   node scripts/sync-sw-versions.mjs --check  exit 1 if any worker is out of date
//
// Mirrors test_service_worker_precaches_every_versioned_page_asset.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function pageAssets(appDir, html) {
    const assets = [];
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+\?v=\d+)"/g)) {
        assets.push(ref.startsWith('/') ? ref : `/${appDir}/${ref.replace(/^\.\//, '')}`);
    }
    return assets;
}

function syncWorker(appDir) {
    const workerPath = join(ROOT, appDir, 'sw.js');
    const html = readFileSync(join(ROOT, appDir, 'index.html'), 'utf8');
    const original = readFileSync(workerPath, 'utf8');
    let worker = original;
    const changes = [];

    for (const asset of pageAssets(appDir, html)) {
        const [path] = asset.split('?');
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const listed = new RegExp(`(['"])${escaped}\\?v=\\d+\\1`);
        const match = worker.match(listed);
        if (match) {
            if (match[0].slice(1, -1) !== asset) {
                changes.push(`${match[0].slice(1, -1)} -> ${asset}`);
                worker = worker.replace(listed, `$1${asset}$1`);
            }
            continue;
        }
        // Not listed at all: append it as the last STATIC_ASSETS entry.
        const start = worker.indexOf('const STATIC_ASSETS = [');
        const end = worker.indexOf('];', start);
        const lastEntry = start === -1 ? null : worker.slice(start, end).match(/\n(\s*)(['"]).*\2,?\s*$/);
        if (!lastEntry) throw new Error(`${appDir}/sw.js: no STATIC_ASSETS entries to append after`);
        const [, indent, quote] = lastEntry;
        const body = worker.slice(0, end).replace(/,?\s*$/, '');
        worker = `${body},\n${indent}${quote}${asset}${quote}\n${worker.slice(end)}`;
        changes.push(`+ ${asset}`);
    }

    if (worker !== original && !check) writeFileSync(workerPath, worker);
    return changes;
}

const apps = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules')
    .map((d) => d.name)
    .filter((name) => existsSync(join(ROOT, name, 'sw.js')) && existsSync(join(ROOT, name, 'index.html')));

let stale = false;
for (const app of apps) {
    const changes = syncWorker(app);
    if (!changes.length) continue;
    stale = true;
    console.log(`${app}/sw.js${check ? ' is out of date' : ''}:`);
    for (const change of changes) console.log(`  ${change}`);
}

if (check && stale) {
    console.log('\nRun: node scripts/sync-sw-versions.mjs');
    process.exit(1);
}
