const { test: base, expect } = require('@playwright/test');

// Fail any test whose page throws or logs a console error. Pages can opt a
// known, expected failure out with `allowErrors`.
const test = base.extend({
    allowErrors: [[], { option: true }],
    page: async ({ page, allowErrors }, use) => {
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        await use(page);
        const unexpected = errors.filter((text) => !allowErrors.some((pattern) => pattern.test(text)));
        expect(unexpected, 'console errors').toEqual([]);
    },
});

let counter = 0;
function uniqueUsername(prefix = 'e2e') {
    counter += 1;
    return `${prefix}${Date.now().toString(36)}${process.pid % 1000}${counter}`.slice(0, 24);
}

const PASSWORD = 'correct-horse-battery';

async function signUp(page, username = uniqueUsername()) {
    await page.goto('/signup/');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).not.toHaveURL(/\/signup\//);
    return username;
}

module.exports = { test, expect, signUp, uniqueUsername, PASSWORD };
