const { test, expect, signUp } = require('./helpers');

function column(page, name) {
    return page.locator('section.column', { has: page.getByRole('heading', { name, exact: true }) });
}

test.describe('signed out', () => {
    // /api/gifts/board answers anonymous callers with a JSON 403, which the
    // page turns into its sign-in panel.
    test.use({ allowErrors: [/status of 403/] });

    test('anonymous visitors see the teaser and a sign-in link', async ({ page }) => {
        await page.goto('/gifts/');
        await expect(page.getByRole('heading', { name: 'Sign in to start your gift board' })).toBeVisible();
        await expect(page.locator('#signInLink')).toHaveAttribute('href', '/login/?next=/gifts/');
        await expect(page.locator('#boardView')).toBeHidden();
    });
});

test('a member keeps private ideas and a wishlist, and nobody else sees them', async ({ page, browser }) => {
    await signUp(page);
    await page.goto('/gifts/');
    await expect(column(page, 'My wishlist')).toBeVisible();

    // A person, two ideas for them, and something for my own wishlist.
    await page.getByPlaceholder('Name, e.g. Mom').fill('Mom');
    await page.getByPlaceholder('Name, e.g. Mom').press('Enter');
    const mom = column(page, 'Mom');
    await expect(mom.getByText('Private')).toBeVisible();
    await mom.getByPlaceholder('+ Add an idea for Mom').fill('Pasta maker');
    await mom.getByPlaceholder('+ Add an idea for Mom').press('Enter');
    await mom.getByPlaceholder('+ Add an idea for Mom').fill('Herb garden kit');
    await mom.getByPlaceholder('+ Add an idea for Mom').press('Enter');
    await expect(mom.locator('.card')).toHaveCount(2);

    const wishlist = column(page, 'My wishlist');
    await wishlist.getByPlaceholder("+ Add something you'd like").fill('Trail running shoes');
    await wishlist.getByPlaceholder("+ Add something you'd like").press('Enter');
    await expect(wishlist.locator('.card')).toHaveCount(1);

    // Edit an idea: price, link, and mark it bought.
    await page.getByRole('button', { name: 'Edit Pasta maker' }).click();
    const editor = page.locator('#itemEditor');
    await editor.getByLabel('Price').fill('89.50');
    await editor.getByLabel('Link').fill('https://example.com/pasta');
    await editor.getByLabel('Status').selectOption('bought');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();
    const pasta = mom.locator('.card', { hasText: 'Pasta maker' });
    await expect(pasta).toContainText('Bought');
    await expect(pasta).toContainText('$89.50');
    await expect(pasta.getByRole('link', { name: 'Pasta maker' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');

    // Moving an idea onto the wishlist asks first, then becomes "Wanted".
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Edit Herb garden kit' }).click();
    await editor.getByLabel('List').selectOption({ label: 'My wishlist' });
    await expect(page.locator('#publicWarning')).toBeVisible();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(wishlist.locator('.card', { hasText: 'Herb garden kit' })).toContainText('Wanted');
    await expect(mom.locator('.card')).toHaveCount(1);

    // Everything survives a reload.
    await page.reload();
    await expect(column(page, 'Mom').locator('.card')).toHaveCount(1);
    await expect(column(page, 'My wishlist').locator('.card')).toHaveCount(2);

    // A second member gets their own empty board.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signUp(other);
    await other.goto('/gifts/');
    await expect(column(other, 'My wishlist')).toBeVisible();
    await expect(other.locator('.card')).toHaveCount(0);
    await expect(other.locator('#board')).not.toContainText('Pasta maker');
    await otherContext.close();
});
