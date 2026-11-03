// Castle Defense: place a fixed day's allotment, then play.
const { test, expect, signUp } = require('./helpers');

// Day 1's map, pinned so the road and grass tiles below never move.
// Column 5 runs down from the top as road; (6, 3), (3, 4) and (2, 6) are grass.
// Its allotment: 2 Archers, 3 Cannons, 3 Frost, 1 Mage, 1 Flamethrower, 1 Spikes,
// no Tar pits, 2 Mines.
const DAY_ONE = '/castle-defense/?date=2026-10-18';

// Click the centre of a board tile; the board is an 8 × 8 grid.
async function clickTile(page, x, y) {
    // Picking a piece low in the sidebar can scroll the board out of view.
    await page.locator('#board').scrollIntoViewIfNeeded();
    const box = await page.locator('#board').boundingBox();
    await page.mouse.click(box.x + ((x + 0.5) / 8) * box.width, box.y + ((y + 0.5) / 8) * box.height);
}

test("place the day's allotment, then start the run", async ({ page }) => {
    await page.goto(DAY_ONE);
    // No intro card: the board is ready to build on.
    await expect(page.locator('#overlay')).toBeHidden();
    const count = page.locator('#pieceCount');
    const play = page.locator('#playButton');
    await expect(count).toHaveText('13 to place');
    // The kill count reads against the next tier, starting from the bottom
    // one. The server works the day's tiers out first, which takes a moment.
    await expect(page.locator('#nextValue')).toHaveText(/^\d+$/, { timeout: 60_000 });
    await expect(page.locator('#tierName')).toHaveText('Are you undead??');
    // The five tiers, under the day's best found score.
    await expect(page.locator('#tiers li')).toHaveCount(6);
    await expect(page.locator('#tiers li').first()).toHaveText(/^Best found\s*[\d,]+$/);
    await expect(play).toBeDisabled();
    await expect(page.getByRole('button', { name: /Tar pit/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Tar pit/ })).toContainText('None today');

    // Towers belong on the grass, traps on the road.
    await page.getByRole('button', { name: /Archer/ }).click();
    await clickTile(page, 5, 1);
    await expect(page.locator('#toast')).toHaveText(/Towers go on the grass/);
    await clickTile(page, 6, 3);
    await expect(count).toHaveText('12 to place');
    await expect(page.getByRole('button', { name: /Archer/ })).toContainText('1 of 2 left');

    await page.getByRole('button', { name: /Flamethrower/ }).click();
    await clickTile(page, 3, 4);
    await expect(count).toHaveText('11 to place');
    await expect(page.getByRole('button', { name: /Flamethrower/ })).toContainText('0 of 1 left');

    await page.getByRole('button', { name: /Spikes/ }).click();
    await clickTile(page, 2, 6);
    await expect(page.locator('#toast')).toHaveText(/Traps go on the road/);
    await clickTile(page, 5, 1);
    await expect(page.getByRole('button', { name: /Spikes/ })).toContainText('0 of 1 left');

    // That was the only Spikes; picking it up gives it back.
    await clickTile(page, 5, 1);
    await expect(page.getByRole('button', { name: /Spikes/ })).toContainText('1 of 1 left');
    await expect(count).toHaveText('11 to place');

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
    // The share names your tier, so let the day's tiers arrive first.
    await expect(page.locator('#tiers li')).toHaveCount(6, { timeout: 60_000 });
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
    // One Spikes trap is nowhere near day 1's top tier.
    expect(copied).toMatch(
        /^Castle Defense #1 · \d+ kills\n.+ · tier [1-4] of 5\n\d+% of the best found \([\d,]+\)\nFell on wave \d+ · 1 of 13 pieces\n(MVP: Spikes, level \d+, \d+ kills\n)?https:\/\/palmergill\.com\/castle-defense\/$/
    );
    await expect(page.locator('.cd-final__tier')).toContainText(/Tier [1-4] of 5 · \d+ more for /);
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
        await expect(page.locator('#placeLine')).toContainText('Sign in to post this run');

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
    expect(copied).toMatch(/\n\d+(st|nd|rd|th) of \d+ today\n/);
});

test("today's leaderboard opens from the header before you've played", async ({ page }) => {
    await page.goto('/castle-defense/');
    await page.getByRole('button', { name: /Leaderboard/ }).click();
    const card = page.getByRole('dialog');
    await expect(card.getByRole('heading', { name: "Today's leaderboard" })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    // Other tests may have posted runs already; either way the board answers.
    await expect(page.locator('#fullBoardNote')).toHaveText(/No scores yet today|\d+ players?/);

    // All time is a medal table of each day's 1st, 2nd and 3rd places.
    await card.getByRole('button', { name: 'All time' }).click();
    await expect(card.getByRole('heading', { name: 'All-time leaderboard' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fullBoardNote')).toHaveText(/No scores yet\.|\d+ players? over \d+ days?/);

    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toBeHidden();
    await expect(page.locator('#playLabel')).toHaveText('Play');
});

test('a signed-in run shows up on the all-time board', async ({ page }) => {
    await signUp(page);
    await quickRun(page);
    await expect(page.locator('#placeLine')).toHaveText(/You're \d+(st|nd|rd|th) of \d+ today\./);
    await page.getByRole('dialog').getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('button', { name: /Leaderboard/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'All time' }).click();
    const mine = page.locator('#fullBoard .is-you');
    await expect(mine).toContainText('(you)');
    await expect(mine).toContainText(/🥇 \d+ 🥈 \d+ 🥉 \d+/);
});

test('the rules open from the header and cover every defense', async ({ page }) => {
    await page.goto('/castle-defense/');
    await page.getByRole('button', { name: /Rules/ }).click();
    const card = page.getByRole('dialog');
    await expect(card.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'How to play' })).toHaveAttribute('aria-pressed', 'true');

    await card.getByRole('button', { name: 'Defenses' }).click();
    for (const name of ['Archer', 'Cannon', 'Frost', 'Mage', 'Flamethrower', 'Spikes', 'Tar pit', 'Mine']) {
        await expect(card.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await card.getByRole('button', { name: 'Zombies' }).click();
    await expect(card.locator('table')).toContainText('Zombie King');
    await card.getByRole('button', { name: 'Scoring' }).click();
    await expect(card.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();

    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toBeHidden();
});
