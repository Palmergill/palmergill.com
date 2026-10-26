const { test, expect, signUp } = require('./helpers');

test.describe('signed out', () => {
    // /api/stocks/portfolio answers anonymous callers with a JSON 403, which
    // the page turns into its sign-in panel.
    test.use({ allowErrors: [/status of 403/] });

    test('anonymous visitors see a sign-in panel and no portfolio', async ({ page }) => {
        await page.goto('/stock-research/portfolio/');
        await expect(page.getByRole('heading', { name: 'Sign in to see your portfolio' })).toBeVisible();
        await expect(page.locator('#dashboard')).toBeHidden();
    });
});

test('a member uploads holdings, sees the breakdown, and nobody else does', async ({ page, browser }) => {
    await signUp(page);
    await page.goto('/stock-research/portfolio/');
    await page.getByText('Or paste CSV text').click();
    await page.getByPlaceholder(/Symbol,Quantity/).fill('Symbol,Quantity,Cost Basis\nAAPL,10,1500\nMSFT,4,1320\nSPAXX**,500,500');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();

    await expect(page.getByText('Imported 2 holdings. Skipped 1 row: cash or money market.')).toBeVisible();
    await expect(page.locator('#holdingsTable').getByRole('link', { name: 'AAPL' })).toBeVisible();
    // The suite has no market data provider, so assert on what was uploaded.
    await expect(page.locator('#holdingsTable')).toContainText('$1,500.00');
    await expect(page.locator('#holdingsTable')).toContainText('$330.00/sh');

    // A second account sees its own empty portfolio, not this one.
    const other = await browser.newPage();
    await signUp(other);
    await other.goto('/stock-research/portfolio/');
    await expect(other.getByRole('heading', { name: 'Add your portfolio' })).toBeVisible();
    await expect(other.locator('#dashboard')).toBeHidden();
    await other.close();
});
