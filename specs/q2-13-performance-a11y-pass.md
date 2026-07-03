# Spec 13 — Performance & Accessibility Pass

- **Quarter:** Q2 2027 (Apr–Jun)
- **Status:** draft
- **Depends on:** Spec 1 (single theme — audit once, not twice)
- **Areas:** every public page; `shared/`; `vercel.json`; service workers

## Summary

A structured audit-and-fix pass across all public pages: Lighthouse
performance, WCAG-AA accessibility (with real keyboard support for the
games), and correct meta/OG tags so shared links unfurl properly.

## Background / current state

- The site is dependency-light static HTML/CSS/vanilla JS — a strong
  starting point; the risks are page-specific: canvas/SVG charts
  (craps-strategy, bitcoin, stocks), game UIs built for pointer input, three
  service workers, and image-heavy pages (about, future case studies).
- No known audit has been run; no baseline numbers exist.
- Games are PWAs; craps got a mobile layout pass, others follow via Spec 5.

## Goals

1. Every public page scores ≥90 Lighthouse performance and ≥95
   accessibility on mobile emulation.
2. Blackjack and the craps simulator are fully operable by keyboard;
   all pages are screen-reader coherent.
3. Every page has correct title/description/OG/twitter meta; links unfurl
   with the right image and text.

## Non-goals

- No framework adoption, bundler introduction, or build-pipeline change —
  fixes stay within the current static architecture.
- No full WCAG AAA; AA is the bar.
- Poker multiplayer keyboard support is best-effort (real-time table UI;
  document gaps rather than block on them).

## Requirements

### Baseline & tracking

- **R1.** Script a Lighthouse run over all public routes
  (`npx lighthouse`/`lhci` in a small script committed to `scripts/`);
  record baseline JSON per page in the tracking issue. Re-run the same
  script for the after-numbers.

### Performance

- **R2.** Images: correct intrinsic sizes, `loading="lazy"` below the fold,
  modern formats where wins are real (the logo/wordmark PNGs and
  `palmer-lake.jpeg` are candidates); explicit width/height to kill CLS.
- **R3.** Fonts: system stack or `font-display: swap`; no render-blocking
  font requests.
- **R4.** Scripts: `defer` by default; shared modules (`site-nav`,
  `analytics`, `casino-profile`) audited for duplicate loads; no page loads
  JS it doesn't use.
- **R5.** Caching headers via `vercel.json`: long-cache immutable assets,
  short-cache HTML; verify the three game service workers respect updated
  assets (cache-version discipline from Spec 5 holds site-wide).

### Accessibility

- **R6.** Keyboard: full operability for blackjack (hit/stand/double/bet
  via keys + visible focus), the craps simulator form/results, all forms
  (login, stock search, chat), and nav (skip link, focus trap in modals).
- **R7.** Screen reader: landmarks on every page, headings hierarchical,
  game state changes announced via `aria-live` (dealt cards, roll results,
  win/loss — throttled so it narrates outcomes, not every animation frame),
  charts get text summaries (`aria-label` + a data-table fallback where the
  chart is the content, e.g. simulator results).
- **R8.** Contrast and motion: AA contrast verified page-by-page (should
  mostly hold from Spec 1's R6); `prefers-reduced-motion` respected by the
  win/loss and count-up animations.

### Meta & unfurls

- **R9.** Every page: unique `<title>`, meta description, canonical URL,
  OG title/description/image, twitter card. One shared OG image template
  (wordmark on warm background) plus per-app screenshots for the big pages.
- **R10.** `robots.txt` and a simple `sitemap.xml` for public pages;
  protected routes (`/admin/`, `/login/`) excluded.

## Technical design

- Work page-by-page, not category-by-category: one PR per page/app
  containing its perf + a11y + meta fixes, verified against the R1 script
  and manual keyboard/VoiceOver passes. Order: home, casino games,
  simulator, stock research, bitcoin, about/docs/projects.
- Add `scripts/audit.sh` (Lighthouse loop) and a `docs/` note on how to run
  it — this becomes the regression check for future work.
- aria-live regions implemented once as a small helper in `shared/` so all
  three games announce consistently.

## Acceptance criteria

- [ ] Before/after Lighthouse table for every public page; all pages meet
      the ≥90/≥95 bars on mobile emulation.
- [ ] A full blackjack hand and a full simulator run completed with
      keyboard only (recorded checklist).
- [ ] VoiceOver pass on home, blackjack, and simulator: state changes
      announced, charts have text alternatives.
- [ ] Paste-test unfurls (Slack/iMessage) for home, simulator, bitcoin,
      stock research, and one case study.
- [ ] `prefers-reduced-motion` disables win/loss animations (manual
      verify).
- [ ] Audit script committed and documented.

## Risks

- **Game a11y is genuinely hard** — felt-table UIs weren't built for
  linear navigation. The R6 scope (blackjack + simulator fully; poker
  best-effort) keeps it tractable; don't gold-plate.
- **Service workers serving stale fixed assets** — every fix PR that touches
  game assets bumps cache versions; the R5 verification catches misses.

## Estimate

~3 weeks part-time: 2–3 days tooling + baseline, then roughly one page/app
per 1–2 days, games longest.
