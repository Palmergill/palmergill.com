const { test, expect, signUp } = require('./helpers');

test('draft order practice deals a hand', async ({ page }) => {
    await signUp(page);
    await page.goto('/fantasy/draft-order/');
    await page.locator('#startPracticeButton').click();
    await expect(page.locator('#startPracticeButton')).toBeHidden();
});

test('a member can create a rankings board', async ({ page }) => {
    await signUp(page);
    await page.goto('/fantasy/rankings/');
    await page.locator('#createBoardButton').click();
    await expect(page.locator('#publishButton')).toBeVisible();
});

test.describe('member league pages with no league data yet', () => {
    // The league APIs answer 404 until the collector has run, and the pages
    // fall back to their empty states.
    test.use({ allowErrors: [/status of 404/] });

    for (const [path, heading] of [
        ['/fantasy/week/', /Weekly Recap/],
        ['/fantasy/draft-recap/', /Draft/],
    ]) {
        test(`${path} renders for a member`, async ({ page }) => {
            await signUp(page);
            await page.goto(path);
            await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
            await page.waitForLoadState('networkidle');
        });
    }
});
