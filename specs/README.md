# Feature Specs — 12-Month Roadmap (Jul 2026 – Jun 2027)

One spec per roadmap item. Status legend: `draft` → `accepted` →
`in progress` → `implemented` (built, pending a later phase) → `shipped`.

## Calibration (decided Jul 2026)

- **Purpose: personal playground.** Building for the fun of it. Spec 12
  (case studies) is optional — write them if the mood strikes, don't let
  them block build work. Portfolio polish is a side effect, not a goal.
- **Dark theme: deleted.** Spec 1's delete-don't-toggle assumption is
  confirmed. A future dark mode would be a fresh `prefers-color-scheme`
  project, not a preserved legacy theme.
- **Spec 5 pulled into Q3** (decided Jul 2026): the retheme close-out is
  smaller than planned, and Q4's simulator/blackjack work then lands on the
  unified casino shell instead of retrofitting it.
- **Time budget: 15+ hrs/week.** The plan as written has slack. Stretch
  candidates if quarters finish early: dark mode via
  `prefers-color-scheme`, poker gameplay depth (tournaments, better AI),
  extending the casino-math hub to games the site doesn't have yet
  (roulette math without building roulette).
- **Spec 16 added Jul 2026:** fantasy football dashboard, a net-new app
  spanning Q3→Q4 using the roadmap's stated slack. Timed to the NFL
  season (kickoff early Sep).
- **Specs 19–20 added Aug 2026, retroactively.** Fourth & Fortune and High
  Card Flush were both built and shipped without specs. The specs were
  written afterwards so the roadmap describes the site as it stands. Worth
  noting as a process observation rather than a rule: the roadmap is a
  planning aid for a personal playground, and building first is allowed —
  but a shipped feature with no spec has nowhere to record *why* it works
  the way it does, which is the expensive part to reconstruct.

## Q3 2026 (Jul–Sep) — Finish what's in flight, stabilize

| # | Spec | Status |
|---|------|--------|
| 1 | [Warm retheme completion](q3-01-warm-retheme-completion.md) | shipped |
| 2 | [Bitcoin dashboard redesign](q3-02-bitcoin-dashboard-redesign.md) | draft |
| 3 | [Repo & tracker cleanup](q3-03-repo-cleanup.md) | shipped |
| 4 | [Backend test baseline](q3-04-backend-test-baseline.md) | shipped |
| 5 | [Casino shell unification](q4-05-casino-shell-unification.md) | in progress — header/lobby/rebuy/responsive fixes shipped, chip/card CSS consolidation remains |
| 16 | [Fantasy football dashboard](q3-16-fantasy-football-dashboard.md) | in progress — P1–P4 built (data, UI, betting, chat) plus the Sep 2026 week board and week results; needs live OpenAI/Odds keys for prod verification |
| 17 | [ESPN league hub](q3-17-espn-league-hub.md) | in progress — P1–P5 built (data, hub, rosters, AI, start/sit); needs a live OpenAI key to verify model-backed overviews |
| 18 | [Personal rankings](q3-18-personal-rankings.md) | implemented — private boards, tiers, public sharing, and published-board site consensus |
| 19 | [Fourth & Fortune](q3-19-fourth-and-fortune.md) | shipped — commit-reveal draft-order game; spec written retroactively |
| 20 | [High Card Flush](q3-20-high-card-flush.md) | shipped — casino table game on the shared shell; spec written retroactively |

## Q4 2026 (Oct–Dec) — Casino as a coherent product

| # | Spec | Status |
|---|------|--------|
| 6 | [Craps strategy simulator v2](q4-06-craps-simulator-v2.md) | draft |
| 7 | [Blackjack strategy tools](q4-07-blackjack-strategy-tools.md) | draft |
| 8 | [Session stats dashboard](q4-08-session-stats-dashboard.md) | draft |

## Q1 2027 (Jan–Mar) — Data apps grow up

| # | Spec | Status |
|---|------|--------|
| 9 | [Stock research upgrades](q1-09-stock-research-upgrades.md) | draft |
| 10 | [Bitcoin historical views](q1-10-bitcoin-historical-views.md) | draft |
| 11 | [Backend hardening](q1-11-backend-hardening.md) | draft |

## Q2 2027 (Apr–Jun) — Portfolio polish and reach

| # | Spec | Status |
|---|------|--------|
| 12 | [Project case studies](q2-12-project-case-studies.md) | draft |
| 13 | [Performance & accessibility pass](q2-13-performance-a11y-pass.md) | draft |
| 14 | [Casino math hub](q2-14-casino-math-hub.md) | draft |
| 15 | [Ops & maintenance](q2-15-ops-maintenance.md) | draft |

## Conventions

- Specs describe the *what* and the *why*, plus enough technical design to start.
  They are living docs — update them when implementation diverges.
- Each spec lists **Depends on** so sequencing is explicit.
- Grounding: paths refer to the real codebase (static front end on Vercel,
  FastAPI backend in `backend/app` on Railway, shared front-end modules in
  `shared/`).
