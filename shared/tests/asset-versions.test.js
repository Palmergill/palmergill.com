/**
 * Asset-version agreement between each PWA page and its service worker.
 *
 * The service workers derive CACHE_NAME by hashing STATIC_ASSETS, so a
 * versioned URL is what invalidates the cache. Two failure modes follow, and
 * both have happened here before:
 *
 *   - the worker precaches a `?v=` the page no longer requests, so the asset
 *     is silently not precached at all (offline load falls back to network);
 *   - the page requests a `?v=` the worker never cached, same result.
 *
 * This asserts the two lists agree on every asset they share. It cannot catch
 * "edited app.js but bumped nothing" — only a content hash could — but it does
 * catch every partial bump, which is the shape the drift has actually taken.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APPS = ['poker', 'craps', 'blackjack', 'craps-strategy', 'high-card-flush'];

function readWorkerAssets(app) {
    const source = fs.readFileSync(path.join(ROOT, app, 'sw.js'), 'utf8');
    const block = source.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/);
    if (!block) throw new Error(`${app}/sw.js has no STATIC_ASSETS array`);
    return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function readPageAssets(app) {
    const source = fs.readFileSync(path.join(ROOT, app, 'index.html'), 'utf8');
    return [...source.matchAll(/(?:src|href)="([^"]+\?v=\d+)"/g)].map((match) => {
        const url = match[1];
        // Page-relative refs ("app.js?v=2") address the same file the worker
        // lists absolutely ("/poker/app.js?v=2").
        return url.startsWith('/') ? url : `/${app}/${url.replace(/^\.\//, '')}`;
    });
}

/** "/poker/app.js?v=20" -> ["/poker/app.js", "20"] */
function splitVersion(url) {
    const [pathname, query] = url.split('?v=');
    return [pathname, query];
}

describe.each(APPS)('%s asset versions', (app) => {
    test('the service worker precaches the versions the page requests', () => {
        const workerVersions = new Map(
            readWorkerAssets(app)
                .filter((url) => url.includes('?v='))
                .map(splitVersion)
        );

        const mismatches = readPageAssets(app)
            .map(splitVersion)
            .filter(([pathname]) => workerVersions.has(pathname))
            .filter(([pathname, version]) => workerVersions.get(pathname) !== version)
            .map(([pathname, version]) => (
                `${pathname}: page requests v=${version}, worker precaches v=${workerVersions.get(pathname)}`
            ));

        expect(mismatches).toEqual([]);
    });

    test('the mutable web manifest is revalidated by the CDN', () => {
        const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
        const rule = vercel.headers.find(({ source }) => source === `/${app}/(.*\\.json)`);
        const cacheControl = rule?.headers.find(({ key }) => key === 'Cache-Control')?.value || '';

        expect(cacheControl).toContain('max-age=0');
        expect(cacheControl).toContain('must-revalidate');
        expect(cacheControl).not.toContain('immutable');
    });

    test('the installed app launches inside its own scope', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(ROOT, app, 'manifest.json'), 'utf8')
        );

        expect(manifest.start_url).toBe(`/${app}/`);
        expect(manifest.scope).toBe(`/${app}/`);
    });
});
