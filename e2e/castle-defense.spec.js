// Castle Defense: place a fixed day's allotment, then play.
const { test, expect, signUp } = require('./helpers');

// Day 1's map, pinned so the road and grass tiles below never move.
// Column 5 runs down from the top as road; (6, 3) and (2, 6) are grass.
// Its allotment: 2 Archers, 3 Cannons, 3 Frost, 1 Mage, 1 Spikes, 1 Tar pit, no Mines.
const DAY_ONE = '/castle-defense/?date=2026-10-18';

// Click the centre of a board tile; the board is an 8 × 8 grid.
async function clickTile(page, x, y) {
    const box = await page.locator('#board').boundingBox();
    await page.mouse.click(box.x + ((x + 0.5) / 8) * box.width, box.y + ((y + 0.5) / 8) * box.height);
}

test("place the day's allotment, then start the run", async ({ page }) => {
    await page.goto(DAY_ONE);
    const count = page.locator('#pieceCount');
    const play = page.locator('#playButton');
    await expect(count).toHaveText('11 to place');
    await expect(play).toBeDisabled();
    await expect(page.getByRole('button', { name: /Mine/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Mine/ })).toContainText('None today');

    // Towers belong on the grass, traps on the road.
    await page.getByRole('button', { name: /Archer/ }).click();
    await clickTile(page, 5, 1);
    await expect(page.locator('#toast')).toHaveText(/Towers go on the grass/);
    await clickTile(page, 6, 3);
    await expect(count).toHaveText('10 to place');
    await expect(page.getByRole('button', { name: /Archer/ })).toContainText('1 of 2 left');

    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, 2, 6);
    await expect(page.locator('#toast')).toHaveText(/Traps go on the road/);
    await clickTile(page, 5, 1);
    await expect(page.getByRole('button', { name: /Spikes/ })).toContainText('0 of 1 left');

    // That was the only Spikes; picking it up gives it back.
    await clickTile(page, 5, 1);
    await expect(page.getByRole('button', { name: /Spikes/ })).toContainText('1 of 1 left');
    await expect(count).toHaveText('10 to place');

    // You don't have to place everything.
    await expect(play).toBeEnabled();
    await play.click();
    await expect(page.locator('#playLabel')).toHaveText('Defending…');
    await expect(page.locator('#waveValue')).toHaveText('1');
    await expect(page.locator('#shopTitle')).toHaveText('Your defenses');
});

test('share copies the result and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(DAY_ONE);
    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, 5, 1);
    await page.locator('#playButton').click();
    await page.getByRole('button', { name: '4×' }).click();

    // One trap can't hold for long; wait for the castle to fall.
    const share = page.getByRole('button', { name: 'Share result' });
    await expect(share).toBeVisible({ timeout: 90_000 });
    // A replay of a past day isn't ranked, so there's no top 10 to show.
    await expect(page.locator('#resultBoard')).toBeHidden();
    await share.click();
    await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^Castle Defense #1 — \d+ zombies\n🏰 Fell on wave \d+\n🔱\n/);
});

// ── today's leaderboard ─────────────────────────────────────────────────────

// A run that ends in seconds whatever today's allotment is: one tower on the
// grass farthest from the road, where it can't reach a single zombie.
async function quickRun(page) {
    await page.goto('/castle-defense/');
    const piece = await page.evaluate(() => {
        const G = window.CastleDefenseGame;
        const map = G.dailyMap(G.localDateString());
        const type = G.TOWER_TYPES.find((t) => map.allotment[t] > 0);
        const gap = (x, y) => Math.min(...map.path.map(([px, py]) => Math.hypot(px - x, py - y)));
        let far = null;
        for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
            if (G.isGrass(map, x, y) && (!far || gap(x, y) > gap(far[0], far[1]))) far = [x, y];
        }
        return { name: G.DEFENSES[type].name, x: far[0], y: far[1] };
    });
    await page.getByRole('button', { name: new RegExp(piece.name) }).click();
    await clickTile(page, piece.x, piece.y);
    await page.locator('#playButton').click();
    await page.getByRole('button', { name: '4×' }).click();
    await expect(page.getByRole('button', { name: 'Share result' })).toBeVisible({ timeout: 60_000 });
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
    // The day's top 10 comes up on the result card, with you marked.
    await expect(page.locator('#resultBoard')).toBeVisible();
    await expect(page.locator('#resultBoard li').first()).toBeVisible();
    expect(await page.locator('#resultBoard li:not(.is-gap)').count()).toBeLessThanOrEqual(11);
    await expect(page.locator('#resultBoard .is-you')).toContainText('(you)');

    await page.getByRole('button', { name: 'Share result' }).click();
    await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/\n🏆 \d+(st|nd|rd|th) of \d+ today/);
});

// ── the open field ──────────────────────────────────────────────────────────

// Day 1's open field: the castle at (4, 4), a tree at (2, 2), and no road.
// Its allotment: 1 Archer, 3 Cannons, 2 Frost, 1 Mage, 3 Tar pits, 3 Mines, no Spikes.
const DAY_ONE_OPEN = '/castle-defense/?mode=open&date=2026-10-18';

test('the open field opens straight onto the board, takes traps on the grass and sends the horde in from an edge', async ({ page }) => {
    await page.goto(DAY_ONE_OPEN);
    // No intro card: the board is ready to build on.
    await expect(page.locator('#overlay')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Open field' })).toHaveAttribute('aria-current', 'page');
    // Switching back keeps the day.
    await expect(page.getByRole('link', { name: 'Classic' })).toHaveAttribute('href', './?date=2026-10-18');
    await expect(page.locator('#pieceCount')).toHaveText('13 to place');

    await page.getByRole('button', { name: /Archer/ }).click();
    await clickTile(page, 4, 4);
    await expect(page.locator('#toast')).toHaveText("That's the castle.");
    await clickTile(page, 2, 2);
    await expect(page.locator('#toast')).toHaveText("You can't build there.");
    await clickTile(page, 3, 4);

    // Any grass will do for a trap out here.
    await page.getByRole('button', { name: /Tar pit/ }).click();
    await clickTile(page, 2, 4);
    await expect(page.getByRole('button', { name: /Tar pit/ })).toContainText('2 of 3 left');

    await page.locator('#playButton').click();
    await expect(page.locator('#toast')).toHaveText('Wave 1 from the west');
    await expect(page.locator('#waveValue')).toHaveText('1');
});
