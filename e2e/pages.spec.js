// Every public page renders its headline (or, for the craps felt, its main
// control) without script errors.
const { test, expect } = require('./helpers');

const PAGES = [
    ['/', /Things I've built/],
    ['/about/', /What I bring/],
    ['/casino/', /Games/],
    ['/poker/', /Texas Hold'em/],
    ['/craps/', /Pass Line/],
    ['/craps-strategy/', /Craps Strategy Simulator/],
    ['/blackjack/', /Blackjack/],
    ['/high-card-flush/', /High Card Flush/],
    ['/bitcoin-chat/', /Bitcoin Dashboard/],
    ['/stock-research/', /Stock Research/],
    ['/fantasy/market/', /Implied Value/],
    ['/fantasy/draft-order/', /Fourth & Fortune/],
    ['/fourth-and-fortune-kickoff.html', /Fourth & Fortune/],
    ['/login/', /Sign in/],
    ['/signup/', /Create account/],
];

for (const [path, heading] of PAGES) {
    test(`${path} renders`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading }).or(page.getByRole('button', { name: heading })).first()).toBeVisible();
        await page.waitForLoadState('networkidle');
    });
}

test.describe('signed-out member surfaces', () => {
    // These call member-only APIs on load and show a signed-out state when
    // the API answers 403.
    test.use({ allowErrors: [/status of 403/] });

    test('/fantasy/ shows the empty league hub', async ({ page }) => {
        await page.goto('/fantasy/');
        await expect(page.getByRole('heading', { name: 'League Hub' })).toBeVisible();
        await page.waitForLoadState('networkidle');
    });

    test('/fantasy/rankings/ asks to sign in', async ({ page }) => {
        await page.goto('/fantasy/rankings/');
        await expect(page.getByRole('heading', { name: /Sign in to build your rankings/ })).toBeVisible();
    });
});

test('unknown paths 404', async ({ request }) => {
    const response = await request.get('/definitely-not-a-page.html');
    expect(response.status()).toBe(404);
});
