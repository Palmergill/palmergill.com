# Spec 1 — Warm Retheme Completion

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** draft
- **Depends on:** nothing (already in flight)
- **Areas:** all static pages, `shared/site-nav.css`, per-app `style.css`

## Summary

Close out the warm retheme: the page-by-page conversion is essentially done
(as of June 2026) — what remains is flipping warm from opt-in to the only
theme, deleting legacy dark CSS, verifying the pages that were converted
without a running backend, and rewriting the stale docs design-system
content.

## Background / current state

- Converted and browser-verified warm: home, `about/`, `bitcoin-chat/`,
  `docs/` (chrome), `login/`, `stock-research/` (landing), `admin/` (chrome).
- Casino suite decision (stands): felt/Emerald Luxe **play surfaces stay
  dark by design**; only shared nav/chrome warmed via `body.theme-warm`.
- Mechanism today: opt-in `theme-warm` body class warms the shared nav
  (`shared/site-nav.css`, cache query at `?v=8`); each converted page also
  had its own palette swapped in place.
- Canonical warm tokens: bg `#faf6f0`, card `#ffffff`, surface `#f3eee4`,
  ink `#23201c`, soft `#5d574e`, muted `#928a7d`, line `#ece4d8`,
  line-strong `#d8cdba`, sage `#5b7152`/dim `#4c6044`, clay `#b96a4b`,
  sky `#5a7794`; Plus Jakarta Sans via Google Fonts.
- Known outstanding from the conversion:
  - `stock-research/` ticker detail (charts/fundamentals) and the `admin/`
    dashboard data views were converted blind — need a verification pass
    with the FastAPI backend running.
  - `docs/` design-system *content* (prose + swatches) still documents the
    old dark theme.
- The working tree has uncommitted theme-related edits across ~20 files —
  land or split those first (see Spec 3).

## Goals

1. Every public page renders in the warm theme with no dark-theme remnants.
2. `body.theme-warm` is removed as an opt-in mechanism — warm is simply the
   default stylesheet, with no class toggle.
3. Dead dark-theme CSS is deleted, not left commented out or gated.
4. Casino games keep their felt-table play surfaces but adopt warm chrome
   (nav, headers, panels, buttons) around them.

## Non-goals

- No dark-mode toggle or `prefers-color-scheme` support (can be a future
  spec once the warm baseline is stable).
- No layout or content changes — this is a reskin only.
- No changes to the admin dashboard beyond keeping it legible (it is private;
  lowest priority).

## Requirements

### Functional

- **R1.** Verification pass with the backend running (`./start.sh`) on the
  blind-converted views: `stock-research/` ticker detail charts/tables and
  `admin/` dashboard data; fix any unconverted colors found.
- **R2.** Shared design tokens (the canonical warm set above) live once as
  CSS custom properties in a shared stylesheet (extend
  `shared/site-nav.css` or add `shared/theme.css`); per-app CSS consumes the
  variables rather than restating hex values (currently palettes were
  swapped per-page — consolidate).
- **R3.** Casino play surfaces (felt table, Emerald Luxe, card faces, chips)
  are explicitly exempted and documented as such in the shared stylesheet.
- **R4.** Flip + delete: remove the `theme-warm` opt-in mechanism (warm is
  simply the default), delete legacy dark-theme CSS, and rewrite the
  `docs/` design-system content to document the warm palette. Afterward a
  repo-wide grep for old dark palette values and `theme-warm` returns no
  hits outside git history.

### Visual acceptance

- **R5.** Nav, footer, links, buttons, form fields, and code blocks are
  visually consistent across all converted pages (same tokens, same radii,
  same focus states).
- **R6.** Text contrast meets WCAG AA (4.5:1 body, 3:1 large text) — spot-check
  with the browser inspector on each page.

## Technical design

1. **Land the working tree (with Spec 3).** Split and commit the in-flight
   ~20-file diff so subsequent PRs are reviewable.
2. **Backend-verified pass (R1).** Run FastAPI locally, walk stock-research
   detail and admin data views, fix stragglers.
3. **Token consolidation (R2).** Pull the canonical palette into `:root`
   custom properties in a shared stylesheet; convert per-page hex values to
   variable references. Verify zero visual diff page by page.
4. **Flip + delete (R4, final PR).** Remove `theme-warm` plumbing from HTML
   and `shared/site-nav.js`/`site-nav.css`, delete dark rules, rewrite the
   `docs/` design-system content, run the grep. Bump the site-nav cache
   query and game service-worker versions.

Each step is verified in the browser preview at desktop and mobile widths.

## Acceptance criteria

- [ ] Stock-research detail and admin data views verified warm with live
      backend data.
- [ ] Shared token stylesheet exists; per-app CSS uses variables for chrome
      colors (no restated warm hex values — grep).
- [ ] `theme-warm` mechanism removed; grep for legacy dark palette values
      and `theme-warm` is clean; casino play surfaces unchanged.
- [ ] `docs/` design-system content documents the warm palette, not the old
      dark theme.
- [ ] Mobile (375px) and desktop (1280px) screenshots captured per page.
- [ ] `ARCHITECTURE.md`/README mention the single warm theme.

## Risks

- **Scope creep into redesign.** The play-surface exemption (R3) is the
  guard rail — if a change alters layout, it belongs in a different spec.
- **Token consolidation regressions.** Converting per-page hex to variables
  is mechanical but wide; do it one page per commit with visual diffs.
- **Stale service-worker CSS** on the casino pages after the flip — cache
  version bumps in step 4.

## Estimate

~1–2 weeks of part-time effort: most of the conversion already shipped in
June 2026; this is verification, consolidation, and deletion.
