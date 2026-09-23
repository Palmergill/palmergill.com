# Site review — September 23, 2026

Reviewed the production site signed out, at desktop size and a 390 × 844 mobile viewport, alongside the local source. No application code changed.

## Confirmed findings

### P2 — Stock comparison displays generated prices without a demo disclosure

- Reproduce: open `/stock-research/` signed out and add `AAPL` using Compare, without first opening a stock detail view.
- Observed: the comparison shows a price, day change, market cap, and P/E. The surrounding page promises data “pulled live” and “Live Prices,” but no demo banner appears. Opening AAPL's detail view separately correctly discloses generated sample data.
- Cause: `stock-research/compare.js:79` builds its display model without retaining `_demo` or `_warning`. The detail view's disclosure logic is not called by comparison.
- Fix: retain provenance per result and display a sample-data notice whenever comparison contains demo values. Update the initial page copy to explain that live data requires sign-in.

### P2 — Closed mobile navigation contains focusable, invisible links

- Reproduce: at mobile width, open `/login/`, let the username field receive focus, then press Shift+Tab.
- Observed: focus moves to the off-screen drawer's “Login Protected access” link while the hamburger still reports collapsed. The closed drawer's links also remain exposed in the accessibility tree.
- Cause: `shared/site-nav.css:460` hides the panel only with a transform. `shared/site-nav.js:273` toggles its visual class and button labels without disabling interaction in the closed panel.
- Fix: make the closed mobile panel inert/hidden to keyboard and assistive technology, restoring it when opened and when switching to desktop. Verify forward/backward tab navigation and Escape focus behavior in a browser.

### P2 — Blackjack quick tips contradict its chart and strategy helper

- Reproduce: open `/blackjack/`, select Rules, and compare the hard-total chart with “EASY-TO-REMEMBER RULES OF THUMB.”
- Observed: the tip says hard 12–16 should stand against dealer 2–6. The chart says to hit hard 12 against 2 or 3; the helper in `blackjack/app.js:111` agrees with the chart.
- Source: `casino/blackjack rules and strategy.txt:269`.
- Fix: separate hard 12 from hard 13–16 in the quick tip so the written guidance agrees with the existing implementation.

### P3 — Mobile portrait crops the subject awkwardly

- At 390 × 844, the homepage portrait places the face near the bottom edge and uses much of its area for sky and the canopy support.
- The mobile rule changes the frame to 4:3 (`index.html:493`) while retaining `object-position: center 22%` (`index.html:132`).
- Fix: set a mobile-specific image position or use a separate crop that keeps the face comfortably inside the frame.

## Additional observations

- The warm palette, typography, and project hierarchy are consistent. The casino section has a distinct visual treatment that still shares navigation with the rest of the site.
- The homepage introduction is generic compared with the concrete identity/access and backend experience on About. Lead with that specialty and add a clearly labeled contact action near the introduction; the current invitation to send feedback has no adjacent contact link.
- The fantasy market loaded successfully and explicitly disclosed 19-day-old Kalshi quotes alongside fresh Polymarket data. That disclosure is useful, but the stale source merits operational investigation. This review did not establish why collection is stale or whether that age is intentional.
- The Bitcoin public demo loaded sample prices and recent blocks, while the chain-metrics area reported that metrics would return when the live service reconnects. That mixes demo and outage messaging. The underlying production service condition was not diagnosed here.
- The signed-out League Hub explains its account requirement and links to the public market board. The login page exposes signup after session state resolves.

## Verification and limits

- Frontend: `npm test -- --runInBand` — **34 suites, 623 tests passed**.
- Backend: `./venv/bin/pytest -q` from `backend/` — **1,109 tests passed**.
- Browser samples: homepage, About, Stock Research detail and comparison, Bitcoin Dashboard, fantasy market, signed-out League Hub, Login, Casino, and Blackjack table/rules.
- This was a sampled public-site review, not exhaustive coverage of every route or game state. Signed-in workflows, account creation, provider-backed live data, and admin functionality were not exercised. Production and the local checkout may differ; source explanations are given where local code supports the reproduced behavior.
