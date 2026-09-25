# Site review — September 25, 2026

A broad pass over the production site and the local source: every public route, links and assets, mobile (iPhone 13) and desktop (1366 × 900) screenshots of 19 pages, signed-in member pages against the local server, backend auth and gating, frontend HTML injection, and the September 23 fixes. One bug found on the way in (Bitcoin demo mode showing outage styling) was fixed in `8e7d622` and is live; no other application code changed.

## Confirmed findings

### P2 — Stock Research's mobile menu button overlaps the logo

- Reproduce: open `/stock-research/` at phone width.
- Observed: the hamburger button is 58 px wide instead of 38 px and runs under the Palmergill.com logo. Every other page measures 38 × 38.
- Cause: `stock-research/style.css:548` sets `button { padding: 14px 28px }` globally, and `.site-nav__toggle` (`shared/site-nav.css:310`) sets a width but no padding, so the page rule wins under `border-box`.
- Fix: add `padding: 0` to `.site-nav__toggle` so the shared nav is immune to page-level button rules. Eight other page stylesheets have a bare `button {}` rule; they happen not to set horizontal padding today.

### P2 — Sportsbook odds jobs have never succeeded

- Observed: `/api/fantasy/state` reports `odds_lines`, `odds_props`, and `odds_futures` with `last_success: null` and status `skipped`. `/api/fantasy/props` returns no featured props and `/api/fantasy/games` has `as_of: null`.
- Cause: the collector skips these jobs when `ODDS_API_KEY` is unset or the monthly Odds API budget is exhausted (`backend/app/services/fantasy_collector.py:874`, `:877`). The public state endpoint doesn't say which.
- Impact: the market page degrades cleanly, since it leans on Kalshi and Polymarket, but anything built on game lines or props is running without data.
- Fix: check the run detail in admin or Railway's env. If the key is intentionally absent, consider not scheduling the jobs so the skipped rows stop reading as failures.

### P2 (needs verification) — Rate limits may share one bucket across all visitors

- Sign-in lockout (8 failures / 15 min) and the public craps `/translate` limit (20 / min) key on `client_ip()` (`backend/app/main.py:320`). That trusts forwarded headers only when `TRUST_PROXY_HEADERS` is set, and then takes the entry `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`.
- Production traffic goes Cloudflare → Vercel rewrite → Railway. If the flag is off, every request looks like it comes from Railway's proxy. If the hop count is 1, it likely resolves to Vercel's egress IP. Either way, a stranger's eight bad passwords would lock everyone, including the admin, out of sign-in for 15 minutes.
- Neither variable is documented in `DEPLOY.md`, so the production values couldn't be confirmed from the repo.
- Verify: in the admin analytics table, check whether `ip_address` varies across visitors. If it's one or two addresses, set the flag and hop count to match the real proxy chain and document them.

## Lower priority

- **Coverage for the September 23 fixes is gone.** The mobile-drawer `inert` behaviour and the comparison sample-data notice each got a unit test in `f2a8bd2`; both files were removed in `5d04aaa`, and no e2e spec covers them. Two short Playwright tests would pin them: Shift+Tab from the login field doesn't land in the closed drawer, and a signed-out AAPL comparison shows "Sample data".
- **Accessibility gaps.** `#compareInput` on Stock Research has only a placeholder, no label or `aria-label`. `/craps/` has no `h1`.
- **Stale project screenshot.** The homepage's Stock Research preview (`assets/project-screenshots/stock-research-1.png`) still shows the old "pulled live" and "Live Prices" copy that the September 23 fix removed from the page.
- **Kalshi quotes are 22 days old and still counted.** The disclosure is accurate, and the code documents that Kalshi's own markets stopped moving in August. Whether to keep blending them into implied value, or drop quotes past about 14 days, is a product call.
- **Anonymous gating under `/api/fantasy`.** The middleware enforces the admin role only for signed-in users. Anonymous calls under the `/api/fantasy` demo prefix pass through, so `/api/fantasy/admin/refresh` relies on its own in-route check (confirmed: it returns 403 signed out). Enforcing admin prefixes before the demo passthrough would make a future admin route safe by default.
- **No Content-Security-Policy header.** Other security headers are set in `vercel.json`. With inline scripts and styles throughout, a report-only CSP would be the realistic first step.
- **Small weight wins.** `palmer-gill-logo-small.png` is 46 KB and loads on every page for a 28 px icon. `?v=`-versioned scripts and styles are cached for 4 hours; they could be `immutable`.

## What's in good shape

- All 24 public routes return 200, and protected routes serve the sign-in page. The 111 unique links and assets resolve; the only non-200s were preconnect hints and LinkedIn's bot wall.
- No horizontal overflow on any of the 19 pages at either size. No console errors beyond the intended 403 from signed-out league and rankings requests.
- Signed-in local sweep of the league hub, weekly recap, draft recap, rankings, market, draft order, Stock Research, Bitcoin, and Casino: no errors or failed requests at either size.
- Auth is careful: scrypt hashing, HMAC-signed sessions separable from the password, admin claims pinned to the configured username, and member status rechecked on every request. `/docs` and `/openapi.json` are closed on the Railway origin, and CORS doesn't reflect arbitrary origins.
- Every `innerHTML` in admin, which renders visitor-supplied paths, events, and log messages, goes through `escapeHtml`. Elsewhere `innerHTML` is only used for clearing or static markup.
- Draft rooms require sign-in and cap open rooms per host. The public craps and poker endpoints are rate limited.
- All four September 23 findings landed: the comparison demo notice, the inert mobile drawer, the corrected blackjack tip, and the portrait crop.

## Verification and limits

- `npx playwright test`: **34 passed**. `backend/venv/bin/pytest -q`: **49 passed** (security regressions only, since `5d04aaa`).
- Screenshots were taken with Playwright against production (signed out) and against `league-local` as `leaguetester` (signed in). The browser pane's mobile emulation rendered scrolled content blank; that was a pane artifact, and the DOM and Playwright captures were correct.
- Not exercised: live provider data (the Stock Research and Bitcoin demo paths only), admin pages, account creation in production, and game logic beyond what e2e covers. Production env vars weren't visible, which is why the rate-limit finding is marked for verification.
