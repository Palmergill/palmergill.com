// End-to-end suite: boots the FastAPI backend with LOCAL_SITE_ROOT so one
// process serves both the static site and the API, against a throwaway
// SQLite file, then drives the real pages in Chromium.
const os = require('os');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 8031);
const DB_PATH = path.join(os.tmpdir(), `palmergill-e2e-${Date.now()}.db`);
const PYTHON = process.env.E2E_PYTHON || 'venv/bin/python';

module.exports = defineConfig({
    testDir: 'e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: `${PYTHON} -m uvicorn app.main:app --port ${PORT}`,
        cwd: 'backend',
        url: `http://localhost:${PORT}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
            DATABASE_URL: `sqlite:///${DB_PATH}`,
            LOCAL_SITE_ROOT: 'true',
            FANTASY_COLLECTION_DISABLED: 'true',
            APP_AUTH_PASSWORD: 'e2e-admin-password',
            // Rate limits are per-IP, and every test signs in from loopback.
            APP_AUTH_RATE_LIMIT_MAX_ATTEMPTS: '1000',
            DAILY_SIGNUP_LIMIT: '100000',
            OPENAI_API_KEY: '',
        },
    },
});
