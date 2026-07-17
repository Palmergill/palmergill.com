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
