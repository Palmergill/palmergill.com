// Castle Defense: spend the gold on a fixed day's map, then play.
const { test, expect, signUp } = require('./helpers');

// Day 1's map, pinned so the road and grass tiles below never move.
// Column 5 runs down from the top as road; (6, 3) and (2, 6) are grass.
const DAY_ONE = '/castle-defense/?date=2026-10-18';

// Click the centre of a board tile; the board is an 8 × 8 grid.
async function clickTile(page, x, y) {
    const box = await page.locator('#board').boundingBox();
    await page.mouse.click(box.x + ((x + 0.5) / 8) * box.width, box.y + ((y + 0.5) / 8) * box.height);
}

test('spend gold on towers and traps, then start the run', async ({ page }) => {
    await page.goto(DAY_ONE);
    await page.getByRole('button', { name: 'Start building' }).click();
    const gold = page.locator('#goldValue');
    const play = page.locator('#playButton');
    await expect(gold).toHaveText('1,000 gold');
    await expect(play).toBeDisabled();

    // Towers belong on the grass, traps on the road.
    await page.getByRole('button', { name: /Archer/ }).click();
    await clickTile(page, 5, 1);
    await expect(page.locator('#toast')).toHaveText(/Towers go on the grass/);
    await clickTile(page, 6, 3);
    await expect(gold).toHaveText('750 gold');

    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, 2, 6);
    await expect(page.locator('#toast')).toHaveText(/Traps go on the road/);
    await clickTile(page, 5, 1);
    await clickTile(page, 5, 2);
    await expect(gold).toHaveText('600 gold');
    await expect(page.getByRole('button', { name: /Spikes/ })).toContainText('×2 placed');

    // Clicking something you placed sells it back for full price.
    await clickTile(page, 5, 2);
    await expect(gold).toHaveText('675 gold');

    await expect(play).toBeEnabled();
    await play.click();
    await expect(page.locator('#playLabel')).toHaveText('Defending…');
    await expect(page.locator('#waveValue')).toHaveText('1');
    await expect(page.locator('#shopTitle')).toHaveText('Your defenses');
});

test('share copies the result and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(DAY_ONE);
    await page.getByRole('button', { name: 'Start building' }).click();
    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, 5, 1);
    await page.locator('#playButton').click();
    await page.getByRole('button', { name: '4×' }).click();

    // One trap can't hold for long; wait for the castle to fall.
    const share = page.getByRole('button', { name: 'Share result' });
    await expect(share).toBeVisible({ timeout: 90_000 });
    await share.click();
    await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^Castle Defense #1 — \d+ zombies\n🏰 Fell on wave \d+\n🔱\n/);
});

// ── today's leaderboard ─────────────────────────────────────────────────────

// One Spikes trap on today's road: a run that ends within seconds at 4×.
async function quickRun(page) {
    await page.goto('/castle-defense/');
    await page.getByRole('button', { name: 'Start building' }).click();
    const [x, y] = await page.evaluate(() => {
        const G = window.CastleDefenseGame;
        const map = G.dailyMap(G.localDateString());
        return map.path.filter(([tx, ty]) => G.isRoad(map, tx, ty))[3];
    });
    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, x, y);
    await page.locator('#playButton').click();
    await page.getByRole('button', { name: '4×' }).click();
    await expect(page.getByRole('button', { name: 'Share result' })).toBeVisible({ timeout: 90_000 });
}

test.describe('signed out', () => {
    // The run's POST is answered with the JSON 403 the card turns into a prompt.
    test.use({ allowErrors: [/status of 403/] });

    test('a run asks you to sign in, then posts itself once you have', async ({ page }) => {
        await quickRun(page);
        await expect(page.locator('#placeLine')).toContainText("Sign in to put this run on today's leaderboard");

        await signUp(page);
        await page.goto('/castle-defense/');
        await expect(page.locator('#toast')).toHaveText(/Posted your run — \d+(st|nd|rd|th) of \d+ today/);
        await expect(page.locator('#board-list .is-you')).toContainText('(you)');
    });
});

test('a signed-in run lands on the board and its place goes in the share', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signUp(page);
    await quickRun(page);
    await expect(page.locator('#placeLine')).toHaveText(/You're \d+(st|nd|rd|th) of \d+ today\./);
    await expect(page.locator('#board-list .is-you')).toBeVisible();

    await page.getByRole('button', { name: 'Share result' }).click();
    await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/\n🏆 \d+(st|nd|rd|th) of \d+ today/);
});
