const { test, expect, signUp, PASSWORD } = require('./helpers');

// Chromium's virtual authenticator stands in for Touch ID / a security key:
// it holds discoverable credentials and approves every prompt on its own.
async function addAuthenticator(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    return { cdp, authenticatorId };
}

async function addPasskey(page, password, name = 'Test device') {
    await page.goto('/account/');
    await page.getByLabel('Passkey name').fill(name);
    await page.getByLabel('Current password').fill(password);
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.locator('#passkeyStatus')).toHaveText(/Passkey added/);
    await expect(page.locator('.passkey-item__name')).toContainText([name]);
}

// The virtual authenticator answers the login page's autofill request on its
// own, so tests of the button switch autofill off first.
async function withoutAutofill(page) {
    await page.addInitScript(() => {
        if (window.PublicKeyCredential) {
            PublicKeyCredential.isConditionalMediationAvailable = async () => false;
        }
    });
}

async function signInWithPasskey(page, next = '/') {
    await page.goto(`/login/?next=${encodeURIComponent(next)}`);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
}

test.describe('member', () => {
    // The week page's league API answers 404 on the empty test database.
    test.use({ allowErrors: [/status of 404/] });

    test('a member adds a passkey and signs in with the button', async ({ page }) => {
        await withoutAutofill(page);
        await addAuthenticator(page);
        const username = await signUp(page);
        await addPasskey(page, PASSWORD);

        await page.context().clearCookies();
        await signInWithPasskey(page, '/fantasy/week/');
        await expect(page).toHaveURL(/\/fantasy\/week\//);
        await page.goto('/');
        await expect(page.locator('.site-nav__username')).toHaveText(username);
    });
});

test('the username field offers a saved passkey through autofill', async ({ page }) => {
    await addAuthenticator(page);
    const username = await signUp(page);
    await addPasskey(page, PASSWORD);

    await page.context().clearCookies();
    await page.goto('/login/?next=/');
    // No click: the autofill request resolves with the saved passkey.
    await expect(page).not.toHaveURL(/\/login\//);
    await expect(page.locator('.site-nav__username')).toHaveText(username);
});

test('the admin can sign in with a passkey and reach the admin page', async ({ page }) => {
    await withoutAutofill(page);
    await addAuthenticator(page);
    await page.goto('/login/');
    await page.getByLabel('Username').fill('palmer');
    await page.getByLabel('Password').fill('e2e-admin-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login\//);

    await addPasskey(page, 'e2e-admin-password', 'Admin device');

    await page.context().clearCookies();
    await signInWithPasskey(page, '/admin/');
    await expect(page).toHaveURL(/\/admin\//);
    const response = await page.request.get('/api/admin/logs/summary', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
});

test.describe('rejections', () => {
    test.use({ allowErrors: [/status of 40[01]/] });

    test('adding a passkey needs the current password', async ({ page }) => {
        await addAuthenticator(page);
        await signUp(page);
        await page.goto('/account/');
        await page.getByLabel('Current password').fill('not-my-password');
        await page.getByRole('button', { name: 'Add a passkey' }).click();
        await expect(page.locator('#passkeyStatus')).toHaveText("That password isn't right.");
        await expect(page.locator('.passkey-item')).toHaveCount(0);
    });

    test('a removed passkey no longer signs in', async ({ page }) => {
        await withoutAutofill(page);
        await addAuthenticator(page);
        await signUp(page);
        await addPasskey(page, PASSWORD);

        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: /Remove passkey/ }).click();
        await expect(page.locator('.passkey-item')).toHaveCount(0);

        await page.context().clearCookies();
        await signInWithPasskey(page);
        await expect(page.locator('#loginStatus')).toHaveText(/isn't set up for this site/);
        await expect(page).toHaveURL(/\/login\//);
    });

    test('the account page asks signed-out visitors to sign in', async ({ page }) => {
        await page.goto('/account/');
        await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login/?next=/account/');
    });
});
