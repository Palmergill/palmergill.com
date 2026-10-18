// Castle Defense: place three towers on a fixed day's map, then play.
const { test, expect } = require('./helpers');

// Day 1's map, pinned so the road and grass tiles below never move.
const DAY_ONE = '/castle-defense/?date=2026-10-18';

// Click the centre of a board tile; the board is an 8 × 8 grid.
async function clickTile(page, x, y) {
    const box = await page.locator('#board').boundingBox();
    await page.mouse.click(box.x + ((x + 0.5) / 8) * box.width, box.y + ((y + 0.5) / 8) * box.height);
}

test('place three towers and start the run', async ({ page }) => {
    await page.goto(DAY_ONE);
    await page.getByRole('button', { name: 'Place towers' }).click();
    const play = page.locator('#playButton');
    await expect(play).toBeDisabled();

    // Column 5 at the top is road: building there is refused.
    await clickTile(page, 5, 0);
    await expect(page.locator('#toast')).toHaveText(/Keep the road clear/);

    await clickTile(page, 6, 3); // Archer is picked first
    await clickTile(page, 2, 6); // then Cannon
    await expect(page.locator('#towerCount')).toHaveText('2/3 placed');
    await page.getByRole('button', { name: /Mage/ }).click();
    await clickTile(page, 4, 4);
    await expect(page.locator('#towerCount')).toHaveText('3/3 placed');

    // A fourth type has to wait until one is picked up.
    await page.getByRole('button', { name: /Frost/ }).click();
    await expect(page.locator('#toast')).toHaveText(/Three towers max/);
    await expect(page.locator('#towerNote')).toHaveText(/Want the Frost instead/);

    // Swap Frost in for the Mage: pick the Mage up, then Frost is placeable.
    await clickTile(page, 4, 4);
    await expect(page.locator('#towerCount')).toHaveText('2/3 placed');
    await page.getByRole('button', { name: /Frost/ }).click();
    await clickTile(page, 4, 4);
    await expect(page.locator('#towerCount')).toHaveText('3/3 placed');
    await expect(page.getByRole('button', { name: /Frost/ })).toContainText('Placed');
    await expect(page.getByRole('button', { name: /Mage/ })).toContainText('Not picked');

    await expect(play).toBeEnabled();
    await play.click();
    await expect(page.locator('#playLabel')).toHaveText('Defending…');
    await expect(page.locator('#waveValue')).toHaveText('1');
    await expect(page.getByRole('button', { name: /Mage/ })).toBeDisabled();
});
