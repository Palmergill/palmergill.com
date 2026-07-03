# Spec 15 — Ops & Maintenance

- **Quarter:** Q2 2027 (Apr–Jun), with items runnable earlier if convenient
- **Status:** draft
- **Depends on:** Spec 4 (test suite is the safety net for upgrades)
- **Areas:** `backend/` deps & Python version, `package.json`, `Dockerfile`, `DEPLOY.md`, `docs/`, Railway/Vercel config

## Summary

An end-of-year maintenance pass: dependency and runtime upgrades verified by
the test suite, deployment documentation brought back in line with reality,
secret/config hygiene, and a light backup/restore check — so year two starts
on a current, documented, restorable stack.

## Background / current state

- Stack: FastAPI backend (Python ≥3.10 per README) deployed on Railway
  (`railway.json`, `start-railway.sh`, `Dockerfile`); static front end on
  Vercel (`vercel.json`, `middleware.js`); SQLite locally / Postgres in
  production per ARCHITECTURE.
- `DEPLOY.md` exists but will be a year stale after Specs 1–14 land
  (new endpoints, cron/snapshot job, rate limiting, new sections).
- By Q2 2027 the repo has: CI from Spec 4, a snapshot cron from Spec 9,
  provider-health tooling from Spec 11 — all of which touch deploy config.

## Goals

1. All dependencies current within their major versions; Python and Node
   runtimes on active LTS/supported releases; upgrades proven by green CI.
2. `DEPLOY.md` describes the actual production setup end-to-end, verified
   by performing a deploy from it.
3. Production data (Postgres) is backed up and a restore has been done
   once, on purpose, before it's ever needed in anger.
4. Secrets inventory is current; nothing unused, nothing untracked.

## Requirements

### Upgrades

- **R1.** Python: bump to the current stable minor (3.13+ by spring 2027,
  pending library support); update `Dockerfile`, CI, and README's version
  note together. Backend deps (`fastapi`, `uvicorn`, `pydantic`, provider
  SDKs) to latest compatible; changelog-scan anything with a major bump
  before taking it.
- **R2.** Node/JS: refresh `package.json` dev deps; the front end has no
  runtime framework deps, so this is tooling only. Prune anything unused
  (audit why `node_modules` exists at root and document what needs it).
- **R3.** LLM/provider config: review model IDs and API versions used by
  `craps_ai.py` / `bitcoin_ai.py` / poker AI against current provider
  offerings; pin explicitly; note per-call cost in a comment where the
  model is chosen.
- **R4.** One upgrade PR per concern (Python runtime, backend deps, JS
  tooling), each gated on full CI plus a manual smoke of the LLM-backed
  endpoints (fixtures don't cover live API drift).

### Deployment documentation

- **R5.** Rewrite `DEPLOY.md` to cover: Railway service setup + env vars
  (complete list, with which features degrade without each), the snapshot
  cron (Spec 9), Vercel project config + `middleware.js` role, DNS,
  and the local-dev → production parity notes (`LOCAL_SITE_ROOT`).
- **R6.** Verification by use: perform one clean deploy (or Railway
  environment clone) following only the doc; every step that required
  out-of-doc knowledge gets written in.
- **R7.** Update `ARCHITECTURE.md` and `docs/` for everything the year
  added (new endpoints, rate limits, `/projects/`, `/casino-math/`);
  delete `BUGS.md`/`FINDINGS.md` closed-item backlog per the Spec 3 format.

### Data & config hygiene

- **R8.** Backup: confirm Railway Postgres backup coverage (plan-dependent);
  if absent, add a scheduled `pg_dump` to object storage. Either way,
  perform one restore into a scratch database and record the steps in
  `DEPLOY.md`.
- **R9.** Secrets audit: list every env var in Railway/Vercel; remove
  unused keys, rotate anything old or over-scoped (provider API keys,
  Basic Auth credentials), confirm none are committed (grep history for
  the known key names only — no full-history secret scan needed unless a
  hit shows).
- **R10.** `VERSION` file: adopt a simple scheme (date-based, e.g.
  `2027.04`) bumped on deploy, surfaced in `/health` output, so "what's
  running" is answerable.

## Technical design

Sequencing: R9 secrets audit first (cheapest, highest downside if stale),
then upgrades (R1–R4) while the test suite is fresh in mind, then docs
(R5–R7) once the stack is settled, then backup/restore (R8) last since it
depends on final config. Each item is independently landable — this spec is
a checklist quarter, not a build quarter.

## Acceptance criteria

- [ ] CI green on upgraded Python/deps; LLM endpoints smoke-tested live.
- [ ] A deploy performed from `DEPLOY.md` alone succeeds.
- [ ] Restore test completed; steps documented.
- [ ] Secrets inventory documented (names + purpose, not values); unused
      keys removed; stale keys rotated.
- [ ] `/health` reports the running version.
- [ ] README/ARCHITECTURE/docs match the shipped year (spot-check every
      path listed in README exists).

## Risks

- **Pydantic/FastAPI major-version drift** breaking request models —
  mitigated by Spec 4's contract tests and taking majors as their own PR
  with the migration guide open.
- **Restore test against the wrong database** — do it in a scratch
  environment, never production; the acceptance criterion says restore
  *into a scratch database* deliberately.

## Estimate

~2–3 weeks part-time spread across the quarter; pairs well as background
work while Spec 12's writing is in progress.
