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
    await page.getByRole('link', { name: 'Holdings', exact: true }).click();
    await expect(page.locator('#holdingsTable').getByRole('link', { name: 'AAPL' })).toBeVisible();
    // The suite has no market data provider, so assert on what was uploaded.
    await expect(page.locator('#holdingsTable')).toContainText('$1,500');
    await expect(page.locator('#holdingsTable')).toContainText('$330.00/sh');

    // Tapping a row opens that holding, and its back link returns to the list.
    await page.locator('#holdingsTable tr[data-ticker="MSFT"] td').nth(2).click();
    await expect(page).toHaveURL(/#holding\/MSFT$/);
    await expect(page.locator('#holdingName')).toContainText('MSFT');
    await expect(page.locator('#holdingTiles')).toContainText('$330.00');
    await page.getByRole('link', { name: '← Holdings' }).click();
    await expect(page.locator('#holdingsTable')).toBeVisible();

    // A second account sees its own empty portfolio, not this one.
    const other = await browser.newPage();
    await signUp(other);
    await other.goto('/stock-research/portfolio/');
    await expect(other.getByRole('heading', { name: 'Add your portfolio' })).toBeVisible();
    await expect(other.locator('#dashboard')).toBeHidden();
    await other.close();
});

test('a multi-broker trade history uploads through the file picker and fills every tab', async ({ page }) => {
    await signUp(page);
    await page.goto('/stock-research/portfolio/');
    const csv = [
        'date,source,account,type,security,quantity,price,amount_usd,fees_usd,realized_gain_loss,notes',
        '2017-02-06,Uploaded CSV,Robinhood,buy,NVDA,10,25.00,250.00,0,,10 shares of NVDA purchased',
        '2018-05-01,Uploaded CSV,Robinhood,sell,NVDA,4,60.00,240.00,0,135.00,4 shares of NVDA sold',
        '2020-01-02,M1 Finance,M1 Finance My Portfolio,buy,VOO,0.12345,300.00,37.04,0,,0.12345 shares of VOO purchased',
        '2021-03-01,BTC transactions CSV,Crypto Account,buy,BTC,0.01,50000.00,500.00,1.50,,Bought BTC',
        '2025-12-10,Robinhood,Robinhood Roth IRA,buy,Twenty One Capital,40,11.50,460.00,0,,Twenty One Capital Class A purchased',
    ].join('\n');
    await page.setInputFiles('#fileInput', { name: 'trades.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByText('Imported 5 trades.')).toBeVisible();

    await page.getByRole('link', { name: 'Holdings', exact: true }).click();
    await expect(page.locator('#holdingsTable')).toContainText('Twenty One Capital');
    await expect(page.locator('#holdingsTable')).toContainText('BTC');

    await page.getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page.locator('#transactionsTable tbody tr')).toHaveCount(5);
    await page.locator('#filterSide').selectOption('sell');
    await expect(page.locator('#transactionsTable tbody tr')).toHaveCount(1);

    await page.getByRole('link', { name: 'Accounts', exact: true }).click();
    await expect(page.locator('#accountsTable')).toContainText('Crypto Account');

    await page.getByRole('link', { name: 'Gains', exact: true }).click();
    await expect(page.locator('#realizedSub')).toContainText('Your file reported +$135');
});
