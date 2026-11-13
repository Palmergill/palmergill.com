// Castle Defense: the patch notes come up once, on the first load after a patch.
const { test, expect } = require('./helpers');

test('the patch notes show on the first load, then stay away', async ({ page }) => {
    // Patch 2.0 starts with the 2026-11-13 map.
    await page.goto('/castle-defense/?date=2026-11-13');
    const card = page.getByRole('dialog');
    await expect(card.getByRole('heading', { name: 'Patch 2.0' })).toBeVisible();
    await expect(card).toContainText('Sniper');

    // Rules opens from the notes.
    await card.getByRole('button', { name: 'Rules' }).click();
    await expect(card.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toBeHidden();

    await page.reload();
    await expect(page.locator('#playLabel')).toHaveText('Play');
    await expect(card).toBeHidden();
});
