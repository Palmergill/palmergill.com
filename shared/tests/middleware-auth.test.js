const fs = require('fs');
const path = require('path');

function loadMiddleware() {
    const file = path.resolve(__dirname, '../../middleware.js');
    const source = fs.readFileSync(file, 'utf8')
        .replace(
            "import { next } from '@vercel/functions';",
            'const next = globalThis.__edgeNext;',
        )
        .replace('export default async function middleware', 'async function middleware')
        .replace('export const config =', 'const config =');

    return new Function(`${source}\nreturn { middleware, config };`)();
}

describe('edge authentication fallback', () => {
    const originalPassword = process.env.APP_AUTH_PASSWORD;

    afterEach(() => {
        if (originalPassword === undefined) {
            delete process.env.APP_AUTH_PASSWORD;
        } else {
            process.env.APP_AUTH_PASSWORD = originalPassword;
        }
        delete global.__edgeNext;
        delete global.fetch;
        jest.restoreAllMocks();
    });

    test('accepts a protected request when the API recognizes a locally unrecognized session', async () => {
        process.env.APP_AUTH_PASSWORD = 'edge-secret-that-does-not-match';
        global.__edgeNext = jest.fn(() => ({ type: 'next' }));
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                authenticated: true,
                username: 'taylor',
                role: 'member',
            }),
        }));

        const { middleware } = loadMiddleware();
        const headers = new Map([
            ['accept', 'text/html'],
            ['cookie', 'pg_session=backend-issued-token'],
        ]);
        const request = {
            method: 'GET',
            url: 'https://palmergill.com/fantasy/league/',
            headers: { get: (name) => headers.get(name.toLowerCase()) || null },
        };

        await expect(middleware(request)).resolves.toEqual({ type: 'next' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [statusUrl, options] = global.fetch.mock.calls[0];
        expect(statusUrl.toString()).toBe('https://palmergill.com/login/session');
        expect(options).toEqual(expect.objectContaining({
            method: 'GET',
            cache: 'no-store',
            redirect: 'manual',
        }));
        expect(options.headers.Cookie).toBe('pg_session=backend-issued-token');
        expect(global.__edgeNext).toHaveBeenCalledTimes(1);
    });
});
