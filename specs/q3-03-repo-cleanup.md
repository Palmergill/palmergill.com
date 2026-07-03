# Spec 3 — Repo & Tracker Cleanup

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** shipped
- **Depends on:** nothing; unblocks Spec 1's PR flow
- **Areas:** repo root, `BUGS.md`, mockup directories

## Summary

One cleanup sprint: land or discard any uncommitted working tree, purge
generated artifacts from version control, retire stale mockup directories, and
turn BUGS.md into the live intake queue.

## Background / current state

- Started 2026-07-03: the working tree was clean before this cleanup pass, so
  the old "20 modified files" note is stale.
- `stock_data.db` (a runtime SQLite cache) and `logs/` sit in the repo root but
  are already ignored and not tracked.
- Three tracked mockup directories existed: `mockups/`, `craps-mockups/`,
  `blackjack-mockups/`. The craps and blackjack mockups have shipped as real
  implementations (see git history: "Implement mobile craps table design").
- `FINDINGS.md` has been merged into `BUGS.md` as the single intake queue.

## Goals

1. `git status` is clean and stays clean — generated files never show up.
2. Shipped mockups are archived; the live `mockups/` design-studies page is
   either curated or removed from nav.
3. `BUGS.md` has a defined format and every open item is actionable or closed.

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
- **R3. Mockups (decided Jul 2026):** delete all three — `craps-mockups/`,
  `blackjack-mockups/` (designs shipped; git history preserves them), and
  `mockups/`. Remove any links to them from live pages and nav.
- **R4. Trackers (decided Jul 2026):** merge `FINDINGS.md` into `BUGS.md`
  as one intake queue with the format
  `- [ ] (area) description — found YYYY-MM-DD` and a `## Closed` section
  trimmed quarterly.
- **R5. Docs sync:** update `README.md`, `ARCHITECTURE.md`, and `docs/` to
  remove references to deleted paths.
- **R6. Vercel config:** confirm `vercel.json` and `middleware.js` don't
  route to removed directories.

## Acceptance criteria

- [x] `git status` clean; `.gitignore` covers all generated artifacts
      (`*.db`, `stock_data.db`, `logs/`, `.env`, etc.; neither file is
      tracked — `git ls-files` returns no hits).
- [x] Fresh clone + `./start.sh` works: `start.sh` creates `logs/` itself,
      and `stock_data.db` is SQLAlchemy's on-demand SQLite file
      (`sqlite:///./stock_data.db` in `backend/app/database.py`) —
      neither requires a pre-seeded artifact.
- [x] Mockup directories resolved per R3; no dead links from any live page
      (crawl the nav manually or with a link checker).
- [x] BUGS.md in the R4 format with every item actionable; FINDINGS.md
      merged or given a distinct charter.
- [x] README path list matches the actual directory layout.

## Risks

- **Deleting something referenced in production.** Mitigation: grep all HTML/JS
  for each directory name before removal, and check `vercel.json` rewrites.
- **`stock_data.db` schema assumptions.** If the backend expects a pre-seeded
  DB, the fresh-clone test in acceptance criteria will catch it; fix by
  seeding on startup rather than re-committing the file.

## Estimate

2–4 days. Do this first in the quarter — it makes every later PR cleaner.
