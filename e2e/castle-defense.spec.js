// Castle Defense: a tower costs gold, a wave starts, and the road is off-limits.
const { test, expect } = require('./helpers');

// Click the centre of a board tile; the board is a 20 × 12 grid.
async function clickTile(page, x, y) {
    const box = await page.locator('#board').boundingBox();
    await page.mouse.click(box.x + ((x + 0.5) / 20) * box.width, box.y + ((y + 0.5) / 12) * box.height);
}

test('build a tower and start the first wave', async ({ page }) => {
    await page.goto('/castle-defense/');
    await page.getByRole('button', { name: 'Build your defenses' }).click();
    await expect(page.locator('#goldValue')).toHaveText('160');

    // Row 2 is road: building there is refused and costs nothing.
    await clickTile(page, 2, 2);
    await expect(page.locator('#toast')).toHaveText(/Keep the road clear/);
    await expect(page.locator('#goldValue')).toHaveText('160');

    await clickTile(page, 3, 4);
    await expect(page.locator('#goldValue')).toHaveText('110');

    // Clicking the new tower opens its upgrade panel.
    await clickTile(page, 3, 4);
    await expect(page.getByRole('button', { name: /Upgrade · 60 gold/ })).toBeVisible();

    await page.getByRole('button', { name: /Start wave 1/ }).click();
    await expect(page.locator('#waveValue')).toHaveText('1');
    await expect(page.getByRole('button', { name: /Wave 1 underway/ })).toBeDisabled();
});
