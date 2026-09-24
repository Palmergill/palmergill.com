// One real round of each casino game, played through the page.
const { test, expect } = require('./helpers');

test('blackjack deals and settles a hand', async ({ page }) => {
    await page.goto('/blackjack/');
    await page.getByRole('button', { name: '$25', exact: true }).click();
    await page.locator('#dealButton').click();
    await expect(page.locator('#dealerCards > *').first()).toBeVisible();

    // Stand on whatever we get; decline insurance if it is offered.
    await expect(async () => {
        if (await page.locator('#declineInsuranceButton').isVisible()) {
            await page.locator('#declineInsuranceButton').click();
        }
        if (await page.locator('#standButton').isEnabled()) {
            await page.locator('#standButton').click();
        }
        await expect(page.locator('#dealButton')).toBeEnabled({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
});

test('craps takes a pass line bet and rolls', async ({ page }) => {
    await page.goto('/craps/');
    await expect(page.locator('#balance')).toHaveText('$1,000');
    await page.locator('#passLineBtn').click();
    await expect(page.locator('#balance')).toHaveText('$995');
    const before = await page.locator('#gameStatus').textContent();
    await page.locator('#rollButton').click();
    await expect(page.locator('#gameStatus')).not.toHaveText(before, { timeout: 10_000 });
});

test('high card flush deals seven cards', async ({ page }) => {
    await page.goto('/high-card-flush/');
    await page.locator('#dealButton').click();
    await expect(page.locator('#playerCards > *, [aria-label="Player cards"] > *')).toHaveCount(7);
});

test('poker seats the player at a table with bots', async ({ page }) => {
    await page.goto('/poker/');
    await page.locator('#start-btn').click();
    await expect(page.locator('#pot-amount')).not.toHaveText('0', { timeout: 15_000 });
    await expect(page.locator('#your-chips')).toBeVisible();
});

test('craps strategy runs a simulation', async ({ page }) => {
    await page.goto('/craps-strategy/');
    await page.locator('#preset').selectOption({ index: 1 });
    await page.locator('#runBtn').click();
    await expect(page.locator('#resultsPanel')).toBeVisible({ timeout: 30_000 });
});
