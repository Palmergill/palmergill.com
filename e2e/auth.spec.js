const { test, expect, signUp, PASSWORD } = require('./helpers');

for (const path of ['/fantasy/week/', '/fantasy/draft-recap/', '/admin/']) {
    test(`${path} redirects signed-out visitors to login`, async ({ page }) => {
        await page.goto(path);
        await expect(page).toHaveURL(new RegExp(`/login/\\?next=${path.replace(/\//g, '\\/')}`));
    });
}

async function signIn(page, username, password = PASSWORD) {
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('member session', () => {
    // The week page's league API answers 404 on the empty test database.
    test.use({ allowErrors: [/status of 404/] });

    test('sign up, log out from the nav, and sign back in to a member page', async ({ page }) => {
        const username = await signUp(page);

        await page.goto('/fantasy/week/');
        await expect(page).toHaveURL(/\/fantasy\/week\//);

        await page.goto('/');
        await expect(page.locator('.site-nav__username')).toHaveText(username);
        await page.locator('.site-nav__logout').click();
        await expect(page).toHaveURL(/\/login\//);

        // Ask the server directly: the browser may serve the page from cache.
        const guarded = await page.request.get('/fantasy/week/', {
            headers: { accept: 'text/html' },
            maxRedirects: 0,
        });
        expect(guarded.status()).toBe(302);

        await page.goto('/login/?next=/fantasy/week/');
        await signIn(page, username);
        await expect(page).toHaveURL(/\/fantasy\/week\//);
    });
});

test('login ignores an off-site next target', async ({ page }) => {
    const username = await signUp(page);
    await page.context().clearCookies();
    await page.goto('/login/?next=https://evil.example/');
    await signIn(page, username);
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\//);
    await expect(page).not.toHaveURL(/\/login\//);
});

test.describe('rejections', () => {
    test.use({ allowErrors: [/status of 40[13]/] });

    test('a wrong password is rejected', async ({ page }) => {
        await page.goto('/login/');
        await signIn(page, 'nobody-here', 'not-the-password');
        await expect(page).toHaveURL(/\/login\//);
        await expect(page.locator('#loginStatus')).not.toBeEmpty();
    });

    test('members cannot reach the admin page', async ({ page }) => {
        await signUp(page);
        const response = await page.goto('/admin/');
        expect(response.status()).toBe(403);
        await expect(page).toHaveTitle(/Not your area/);
    });
});
