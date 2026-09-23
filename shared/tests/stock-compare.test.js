function loadCompare() {
    jest.resetModules();
    require('../../stock-research/compare.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
}

describe('stock comparison data provenance', () => {
    beforeEach(() => {
        document.body.innerHTML = '<form id="compareForm"><input id="compareInput"></form><div id="compareChips"></div><div id="compareTable" hidden></div>';
        localStorage.clear();
        delete window.StockCompare;
    });

    afterEach(() => {
        delete global.fetch;
        delete window.StockCompare;
    });

    test('labels generated values and removes the notice after the demo ticker is removed', async () => {
        global.fetch = jest.fn((url) => Promise.resolve({
            ok: true,
            json: async () => url.includes('/prices?')
                ? { prices: [{ close: 100 }, { close: 102 }] }
                : { _demo: true, summary: { current_price: 102, market_cap: 1000000 } }
        }));
        loadCompare();
        window.StockCompare.addTicker('AAPL');
        await window.StockCompare.renderTable();

        const table = document.getElementById('compareTable');
        expect(table.querySelector('.compare-demo-notice').textContent).toMatch(/AAPL.*generated stock values/);
        expect(table.textContent).toContain('$102.00');

        document.querySelector('.compare-chip button').click();
        expect(table.hidden).toBe(true);
        expect(table.querySelector('.compare-demo-notice')).toBeNull();
    });

    test('does not label live values as samples', async () => {
        global.fetch = jest.fn((url) => Promise.resolve({
            ok: true,
            json: async () => url.includes('/prices?')
                ? { prices: [{ close: 100 }, { close: 102 }] }
                : { summary: { current_price: 102 } }
        }));
        loadCompare();
        window.StockCompare.addTicker('AAPL');
        await window.StockCompare.renderTable();

        expect(document.querySelector('.compare-demo-notice')).toBeNull();
        expect(document.querySelector('#compareTable').textContent).toContain('$102.00');
    });
});
