// Castle Defense: the patch notes come up once, on the first load after a patch.
const { test, expect } = require('./helpers');

test('the patch notes show on the first load, then stay away', async ({ page }) => {
    await page.goto('/castle-defense/');
    const card = page.getByRole('dialog');
    await expect(card.getByRole('heading', { name: 'Patch 1.0' })).toBeVisible();
    await expect(card).toContainText('Flamethrower');

    // Rules opens from the notes.
    await card.getByRole('button', { name: 'Rules' }).click();
    await expect(card.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toBeHidden();

    await page.reload();
    await expect(page.locator('#playLabel')).toHaveText('Play');
    await expect(card).toBeHidden();
});
