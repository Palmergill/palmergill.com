/**
 * The skip link is injected rather than written into each page's markup, so
 * these guard the two things that make it actually usable: it has to be the
 * first focusable element in the body, and it has to point at a target that
 * can take keyboard focus. Poker is the one page with no <main>, so the #app
 * fallback is covered too.
 */
function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadNav() {
    jest.resetModules();
    require('../site-nav.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushPromises();
}

describe('skip-to-content link', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        window.history.replaceState({}, '', '/about/');
        global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('points at <main> and makes it focusable', async () => {
        document.body.innerHTML = '<main class="app-shell">content</main>';

        await loadNav();

        const skip = document.querySelector('.site-nav__skip');
        expect(skip.getAttribute('href')).toBe('#main-content');
        expect(skip.textContent).toBe('Skip to content');

        const main = document.querySelector('main');
        expect(main.id).toBe('main-content');
        expect(main.getAttribute('tabindex')).toBe('-1');
    });

    test('keeps an id the page already set', async () => {
        document.body.innerHTML = '<main id="main">content</main>';

        await loadNav();

        expect(document.querySelector('.site-nav__skip').getAttribute('href')).toBe('#main');
    });

    test('falls back to #app on pages without a <main>', async () => {
        document.body.innerHTML = '<div id="app">content</div>';

        await loadNav();

        expect(document.querySelector('.site-nav__skip').getAttribute('href')).toBe('#app');
        expect(document.getElementById('app').getAttribute('tabindex')).toBe('-1');
    });

    test('sits ahead of the nav so it is the first thing focused', async () => {
        document.body.innerHTML = '<main>content</main>';

        await loadNav();

        const classes = [...document.body.children].map((el) => el.className);
        expect(classes[0]).toBe('site-nav__skip');
        expect(classes[1]).toBe('site-nav');
    });
});
