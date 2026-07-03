# Spec 12 — Project Case Studies

- **Quarter:** Q2 2027 (Apr–Jun)
- **Status:** draft
- **Depends on:** the year's shipped work (it's the subject matter)
- **Areas:** new `writing/` or `projects/` section, `about/`, `index.html`, `shared/site-nav.js`

## Summary

Write and publish a short case-study page for each major project — the craps
simulator's math and LLM contract, the poker engine, the bitcoin dashboard,
and the warm retheme — so the site works as a professional artifact for
visitors who want to understand the work, not just click around it.

## Background / current state

- `about/` covers professional background and "selected project context";
  `assets/project-screenshots/` and `assets/Resume2026.pdf` exist.
- The home page is a project launcher; nothing on the site currently
  explains *how* anything was built or *why* decisions were made.
- Rich material already exists in-repo to draw from: `craps-strategy/FEATURES.md`
  (the two-stage LLM contract, seeded determinism), `poker/ARCHITECTURE.md`
  and `poker/API.md`, this `specs/` directory, and git history.

## Goals

1. A hiring manager or peer can read one page per project and come away
   with the problem, the interesting decisions, and the outcome.
2. Case studies are skimmable in ~3 minutes each, with screenshots and a
   "try it" link.
3. The home page and about page route visitors to them naturally.

## Non-goals

- No blog platform, RSS, CMS, or comment system — static pages in the
  existing site style.
- No recurring publishing cadence commitment; four solid pages beat a
  feed that goes stale.
- No SEO campaign beyond correct meta tags (Spec 13 covers those).

## Requirements

### The four case studies

- **R1. Craps strategy simulator** — the flagship. Cover: the two-stage
  contract (LLM returns money-free `StrategyIntent`; deterministic
  `normalize()` produces the concrete spec) and why that split makes LLM
  output safe to simulate; seeded reproducibility (mulberry32, per-trial
  seed mixing, shareable runs); the expected-edge vs realized-P/L framing;
  one bug story from git history (e.g. come-out odds resolution) and the
  test that now guards it.
- **R2. Poker app** — the engine and multiplayer: hand evaluation, side
  pots, the WebSocket push channel, server-managed chips, and the AI
  opponent's legal-action guarantee.
- **R3. Bitcoin dashboard** — chat-first to dashboard-first redesign:
  provider fan-out with per-card degradation, caching strategy, and writing
  metric copy for beginners.
- **R4. The retheme** — a short design piece: dark neon-terminal to warm
  light, the token system, and before/after screenshots.

### Format & structure

- **R5.** Every case study follows the same skeleton: one-paragraph summary
  → the problem → 2–4 "interesting decisions" sections → outcome/what I'd do
  differently → try-it link + key source links (GitHub paths).
- **R6.** Pages live under `/projects/<slug>/` as static HTML in the site
  theme; an index at `/projects/` lists all four with one-line hooks.
- **R7.** Screenshots stored in `assets/project-screenshots/` (curate the
  existing ones, capture missing ones at consistent viewport sizes);
  before/after pairs for the retheme piece.
- **R8.** Navigation: home page project cards gain a "how it's built" link;
  `about/` selected-projects section links each project to its case study;
  site nav gains "Projects".

### Voice

- **R9.** First person, concrete, technical-but-hospitable — same register
  as the site's beginner glosses but aimed at practitioners. No marketing
  language. Numbers where they exist (trial counts, test counts,
  before/after Lighthouse scores from Spec 13).

## Technical design

- Static pages using the shared warm tokens and `site-nav`; a small shared
  `projects/case-study.css` for the article layout (measure ~65ch, figure
  captions, code blocks) rather than per-page styles.
- Code snippets are short excerpts, hand-checked against the current source
  at publish time; link to the file path for the full context.
- Each page gets proper OG/meta tags so links unfurl (feeds Spec 13's
  checklist).

## Acceptance criteria

- [ ] Four case studies live under `/projects/`, index page links all,
      nav updated everywhere (grep for nav templates/`site-nav.js`).
- [ ] Each follows the R5 skeleton and reads in ≤3 minutes
      (~600–900 words).
- [ ] Every code excerpt matches current source (spot-check at publish).
- [ ] Screenshots consistent (same widths, warm theme) and lazy-loaded.
- [ ] Links unfurl correctly when pasted into Slack/iMessage (manual
      check).
- [ ] README/docs updated with the new section.

## Risks

- **Writing stalls** — this work competes badly with building. Mitigation:
  timebox one case study per two-week block, flagship first; three shipped
  pages beat four drafts.
- **Drift** — case studies describe code that keeps changing. The R5
  "outcome" section dates the piece ("as of spring 2027") so accuracy has a
  timestamp instead of a maintenance burden.

## Estimate

~4 weeks part-time across the quarter, interleaved: 1 week flagship,
2 weeks the other three, 1 week index, nav, screenshots, polish.
