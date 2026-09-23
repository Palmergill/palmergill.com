function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadNav() {
    jest.resetModules();
    require('../site-nav.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushPromises();
    await flushPromises();
}

describe('site navigation authentication', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        document.body.removeAttribute('data-site-nav-return-to');
        window.history.replaceState({}, '', '/about/');
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('replaces Login with the signed-in username and Logout controls', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ authenticated: true, username: 'palmer' })
        });

        await loadNav();

        expect(document.querySelector('.site-nav__username').textContent).toBe('palmer');
        expect(document.querySelector('.site-nav__logout').textContent).toContain('Logout');
        expect(document.querySelector('.site-nav__top-username').textContent).toBe('palmer');
        expect(document.querySelector('.site-nav__top-separator').textContent).toBe('·');
        expect(document.querySelector('[data-auth-control]')).toBeNull();
    });

    test('keeps Login visible when there is no authenticated session', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ authenticated: false })
        });

        await loadNav();

        expect(document.querySelector('[data-auth-control]').textContent).toContain('Login');
        expect(document.querySelector('.site-nav__logout')).toBeNull();
    });

    test('uses a page-provided return path instead of the current URL', async () => {
        window.history.replaceState({}, '', '/page-that-does-not-exist');
        document.body.dataset.siteNavReturnTo = '/';
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });

        await loadNav();

        expect(document.querySelector('[data-auth-control]').getAttribute('href')).toBe('/login/?next=%2F');
        expect(document.querySelector('[data-auth-top]').getAttribute('href')).toBe('/login/?next=%2F');
    });

    test('posts to the logout endpoint from the Logout button', async () => {
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ authenticated: true, username: 'palmer' })
            })
            .mockResolvedValueOnce({ ok: false });

        await loadNav();
        document.querySelector('.site-nav__logout').click();
        await flushPromises();

        expect(global.fetch).toHaveBeenLastCalledWith('/login/logout', expect.objectContaining({
            method: 'POST',
            credentials: 'same-origin'
        }));
    });
});

describe('mobile navigation panel', () => {
    let mobileQuery;

    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '<main id="main"><input id="username"></main>';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
        mobileQuery = { matches: true, addEventListener: jest.fn() };
        window.matchMedia = jest.fn(() => mobileQuery);
    });

    afterEach(() => {
        delete global.fetch;
        delete window.matchMedia;
    });

    test('keeps closed links inert, restores them on open and desktop, and returns focus on Escape', async () => {
        await loadNav();
        const panel = document.querySelector('.site-nav__panel');
        const toggle = document.querySelector('.site-nav__toggle');
        expect(panel.inert).toBe(true);
        expect(panel.getAttribute('aria-hidden')).toBe('true');

        toggle.click();
        expect(panel.inert).toBe(false);
        expect(panel.hasAttribute('aria-hidden')).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        panel.querySelector('a').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.activeElement).toBe(toggle);
        expect(panel.inert).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        mobileQuery.matches = false;
        mobileQuery.addEventListener.mock.calls[0][1]();
        expect(panel.inert).toBe(false);
        expect(panel.hasAttribute('aria-hidden')).toBe(false);
    });
});
