# Spec 3 — Repo & Tracker Cleanup

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** draft
- **Depends on:** nothing; unblocks Spec 1's PR flow
- **Areas:** repo root, `BUGS.md`, `FINDINGS.md`, mockup directories

## Summary

One cleanup sprint: land or discard the current uncommitted working tree,
purge generated artifacts from version control, retire stale mockup
directories, and turn BUGS.md/FINDINGS.md into a live intake queue.

## Background / current state

- The working tree has ~20 modified files uncommitted (theme rollout
  mid-flight).
- `stock_data.db` (a runtime SQLite cache) and `logs/` sit in the repo root.
- Three mockup directories exist: `mockups/`, `craps-mockups/`,
  `blackjack-mockups/`. The craps and blackjack mockups have shipped as real
  implementations (see git history: "Implement mobile craps table design").
- `BUGS.md` and `FINDINGS.md` exist at the root; recent commits ("bugs",
  "Fix review findings") suggest they are being worked but their state is
  unclear.

## Goals

1. `git status` is clean and stays clean — generated files never show up.
2. Shipped mockups are archived; the live `mockups/` design-studies page is
   either curated or removed from nav.
3. BUGS.md/FINDINGS.md have a defined format and every open item is
   actionable or closed.

## Non-goals

- No history rewriting (`git filter-repo`) — removing files going forward is
  enough; the repo is not sensitive-data constrained.
- No CI setup (that arrives with Spec 4's tests).

## Requirements

- **R1. Working tree:** review the current diff; commit coherent pieces with
  real messages (split theme work from bug fixes), discard experiments.
  Nothing sits uncommitted for more than a working session afterward.
- **R2. Generated artifacts:** `git rm --cached stock_data.db logs/` and add
  to `.gitignore` alongside `backend/venv`, `__pycache__`, `node_modules`,
  `.DS_Store`. Verify the backend recreates `stock_data.db` on first run.
- **R3. Mockups:** delete `craps-mockups/` and `blackjack-mockups/` (their
  designs shipped; git history preserves them). Decide for `mockups/`:
  keep it as a linked design-studies page only if it is referenced from
  the home page or about page; otherwise delete.
- **R4. Trackers:** adopt one format for `BUGS.md` and `FINDINGS.md`:
  `- [ ] (area) description — found YYYY-MM-DD`, with a `## Closed` section
  trimmed quarterly. Merge FINDINGS.md into BUGS.md if the distinction isn't
  carrying weight (one intake queue is easier to burn down than two).
- **R5. Docs sync:** update `README.md`, `ARCHITECTURE.md`, and `docs/` to
  remove references to deleted paths.
- **R6. Vercel config:** confirm `vercel.json` and `middleware.js` don't
  route to removed directories.

## Acceptance criteria

- [ ] `git status` clean; `.gitignore` covers all generated artifacts.
- [ ] Fresh clone + `./start.sh` works (proves `stock_data.db` is
      regenerated, not required).
- [ ] Mockup directories resolved per R3; no dead links from any live page
      (crawl the nav manually or with a link checker).
- [ ] BUGS.md in the R4 format with every item actionable; FINDINGS.md
      merged or given a distinct charter.
- [ ] README path list matches the actual directory layout.

## Risks

- **Deleting something referenced in production.** Mitigation: grep all HTML/JS
  for each directory name before removal, and check `vercel.json` rewrites.
- **`stock_data.db` schema assumptions.** If the backend expects a pre-seeded
  DB, the fresh-clone test in acceptance criteria will catch it; fix by
  seeding on startup rather than re-committing the file.

## Estimate

2–4 days. Do this first in the quarter — it makes every later PR cleaner.
