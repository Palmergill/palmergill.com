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
        await expect(page.locator('#signInLink')).toHaveAttribute('href', `/login/?next=${encodeURIComponent('/gifts/')}`);
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

test('members browse each other\'s wishlists, link a contact, and save ideas from it', async ({ page, browser }) => {
    // Member A: one private idea, one wishlist item.
    const aliceContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const aliceName = await signUp(alice);
    await alice.goto('/gifts/');
    await alice.getByPlaceholder('Name, e.g. Mom').fill('Dad');
    await alice.getByPlaceholder('Name, e.g. Mom').press('Enter');
    await alice.getByPlaceholder('+ Add an idea for Dad').fill('Top secret watch');
    await alice.getByPlaceholder('+ Add an idea for Dad').press('Enter');
    await alice.getByPlaceholder("+ Add something you'd like").fill('Pour-over kettle');
    await alice.getByPlaceholder("+ Add something you'd like").press('Enter');
    await expect(column(alice, 'My wishlist').locator('.card')).toHaveCount(1);
    await aliceContext.close();

    // Member B finds A under Wishlists: the wishlist item, never the idea.
    await signUp(page);
    await page.goto('/gifts/');
    await page.getByRole('link', { name: 'Wishlists' }).click();
    await page.locator('.member-card', { hasText: aliceName }).click();
    await expect(page).toHaveURL(new RegExp(`#wishlist/${aliceName.toLowerCase()}$`));
    await expect(page.locator('#wishlistTitle')).toHaveText(`${aliceName}'s wishlist`);
    await expect(page.locator('.wish')).toHaveCount(1);
    await expect(page.locator('#wishList')).toContainText('Pour-over kettle');
    await expect(page.locator('main')).not.toContainText('Top secret watch');

    // One click makes A a linked person on B's board, then save the item as an idea.
    await page.getByRole('button', { name: `Add ${aliceName} to my board` }).click();
    await expect(page.locator('#wishlistActions')).toContainText(`Linked to ${aliceName}`);
    await page.getByRole('button', { name: `Save as idea for ${aliceName}` }).click();
    await expect(page.locator('.wish')).toContainText(`Saved to ${aliceName}`);

    // On the board, A's column has the idea and the linked wishlist marked saved.
    await page.getByRole('link', { name: 'My board' }).click();
    const aliceColumn = column(page, aliceName);
    await expect(aliceColumn.locator('.card', { hasText: 'Pour-over kettle' })).toContainText('Idea');
    await expect(aliceColumn.locator('.linked')).toContainText(`From ${aliceName}'s wishlist (1)`);
    await expect(aliceColumn.locator('.linked__saved')).toHaveText('Saved');

    // The graph shows the same gifts as the board, and the choice sticks.
    const cardCount = await page.locator('.card').count();
    await page.getByRole('button', { name: 'Graph' }).click();
    await expect(page.locator('#graph')).toBeVisible();
    await expect(page.locator('.graph__item')).toHaveCount(cardCount);
    await expect(page.locator('.graph__person')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('#graph')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Pour-over kettle' }).locator('.graph__dot').click();
    await expect(page.locator('#itemEditor')).toBeVisible();
    await expect(page.locator('#itemEditor').getByLabel('Gift')).toHaveValue('Pour-over kettle');
});

test.describe('wishlist links', () => {
    test.use({ allowErrors: [/status of 403/] });

    test('a shared wishlist link survives the sign-in redirect', async ({ page }) => {
        await page.goto('/gifts/#wishlist/someone');
        await expect(page.locator('#signInLink')).toHaveAttribute('href', `/login/?next=${encodeURIComponent('/gifts/#wishlist/someone')}`);
    });
});

test.describe('product pictures', () => {
    // The last step loads an image that 404s on purpose.
    test.use({ allowErrors: [/status of 404/] });

    test('a gift shows its product picture, and a pasted image address works when lookup cannot', async ({ page }) => {
        // Serve the "retailer" image locally; the test never reaches the internet.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );
        await page.route('https://images.example.test/**', (route) => route.fulfill({ contentType: 'image/png', body: png }));

        await signUp(page);
        await page.goto('/gifts/');
        const wishlist = column(page, 'My wishlist');
        await wishlist.getByPlaceholder("+ Add something you'd like").fill('Pour-over kettle');
        await wishlist.getByPlaceholder("+ Add something you'd like").press('Enter');

        await page.getByRole('button', { name: 'Edit Pour-over kettle' }).click();
        const editor = page.locator('#itemEditor');
        await editor.getByLabel('Link').fill('https://shop.example.test/kettle');
        await editor.getByRole('button', { name: 'Find image' }).click();
        // Lookups are switched off in the test server, and the editor says so.
        await expect(page.locator('#imageHint')).toHaveText('Picture lookup is turned off here.');

        await editor.getByLabel('Image').fill('https://images.example.test/kettle.png');
        await expect(page.locator('#imagePreview')).toBeVisible();
        await editor.getByLabel('Image').fill('javascript:alert(1)');
        await editor.getByRole('button', { name: 'Save' }).click();
        await expect(page.locator('#editorError')).toHaveText('Image addresses must start with https://.');

        await editor.getByLabel('Image').fill('https://images.example.test/kettle.png');
        await editor.getByRole('button', { name: 'Save' }).click();
        const thumb = wishlist.locator('.card', { hasText: 'Pour-over kettle' }).locator('img.card__thumb');
        await expect(thumb).toHaveAttribute('src', 'https://images.example.test/kettle.png');
        await expect(thumb).toHaveAttribute('referrerpolicy', 'no-referrer');
        await expect(thumb).toBeVisible();

        // An image that fails to load is removed, not shown broken.
        await page.route('https://images.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
        await page.getByRole('button', { name: 'Edit Pour-over kettle' }).click();
        await editor.getByLabel('Image').fill('https://images.example.test/gone.png');
        await editor.getByRole('button', { name: 'Save' }).click();
        await expect(wishlist.locator('img.card__thumb')).toHaveCount(0);
    });
});
