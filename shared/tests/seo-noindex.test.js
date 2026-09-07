const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NOINDEX_PAGES = [
    'admin/index.html',
    'login/index.html',
    'signup/index.html',
    'fantasy/league/index.html',
    'fantasy/rankings/index.html',
    'fourth-and-fortune-kickoff.html',
];

describe('search indexing exclusions', () => {
    test.each(NOINDEX_PAGES)('%s declares noindex', (filename) => {
        const html = fs.readFileSync(path.join(ROOT, filename), 'utf8');
        expect(html).toMatch(/<meta\s+name="robots"\s+content="[^"]*noindex/i);
        expect(html).not.toMatch(/<link\s+rel="canonical"/i);
    });

    test('robots.txt lets crawlers read page-level noindex directives', () => {
        const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
        expect(robots).not.toMatch(/^Disallow:\s*\/(?:admin|login|signup|fantasy\/league|fantasy\/rankings)\/?/m);
        expect(robots).not.toMatch(/^Disallow:\s*\/fourth-and-fortune-kickoff\.html/m);
    });
});
