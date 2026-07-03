# Spec 11 — Backend Hardening

- **Quarter:** Q1 2027 (Jan–Mar)
- **Status:** draft
- **Depends on:** Spec 4 (test baseline — hardening changes land with tests)
- **Areas:** `backend/app/main.py`, all routers, `backend/app/log_handler.py`, `admin/`

## Summary

Production-grade the shared FastAPI backend: rate limiting on public
endpoints, uniform structured error responses, provider-health visibility in
the admin dashboard, and request logging good enough to debug incidents
after the fact.

## Background / current state

- Public unauthenticated endpoints: `/api/analytics/events` (ingest),
  `/api/craps/*` (LLM-backed strategy translation), stock/bitcoin demo
  routes, `/health`. The LLM-backed craps endpoint is the expensive one —
  each call costs real money.
- Auth: Basic Auth on admin/protected routes; demo mode elsewhere.
- Logging: `log_handler.py` feeds the `/admin/` log dashboard via
  `/api/admin/*`.
- No rate limiting anywhere today; error shapes vary by router.

## Goals

1. A scripted abuser can't run up LLM/provider bills or fill the database.
2. Every error response has the same shape; clients render failures
   predictably.
3. The admin dashboard answers "is it us or the provider?" in one glance.
4. Any 5xx in production can be traced to a request id in the logs.

## Non-goals

- No auth-system replacement (Basic Auth stays; accounts are out of scope
  site-wide).
- No WAF/CDN-level protections beyond what Vercel/Railway provide by
  default.
- No multi-region or scaling work — this is a single-instance service.

## Requirements

### Rate limiting

- **R1.** Per-IP sliding-window limits, tiered by cost:
  - LLM-backed (`POST /api/craps/translate`-class): 5/min, 30/day
  - analytics ingest: 60/min, with a 16KB body cap
  - public read APIs (stocks/bitcoin demo): 60/min
  - `/health`: unlimited
  Limits are constants in one module, not scattered per-route.
- **R2.** Exceeded limits return `429` with `Retry-After` and the standard
  error shape (R4); the craps UI and analytics client handle 429 gracefully
  (analytics: silent drop; craps: friendly "try again in a minute").
- **R3.** In-memory store is acceptable (single instance); wrap it behind a
  small interface so Redis can slot in later. Respect
  `X-Forwarded-For` correctly behind Railway's proxy (leftmost trusted hop
  only).

### Structured errors

- **R4.** One error envelope everywhere:
  `{"error": {"code": "rate_limited|invalid_input|provider_unavailable|not_found|internal", "message": <safe string>, "request_id": <id>}}`.
  Implemented as FastAPI exception handlers in `main.py`; routers raise
  typed exceptions instead of ad-hoc `HTTPException` payloads.
- **R5.** Internal errors never leak stack traces or provider error bodies
  to clients; full detail goes to logs keyed by `request_id`.

### Observability

- **R6.** Request-id middleware: generate/propagate `X-Request-ID`, include
  it in every log line and error envelope.
- **R7.** Provider health: each service client (`finnhub_client`,
  `polygon_client`, `bitcoin_coingecko`, `bitcoin_mempool_space`,
  `bitcoin_rpc`, LLM) records rolling success/failure counts and last-error
  into a health registry; `GET /api/admin/provider-health` exposes it and
  `/admin/` renders a status panel (green/yellow/red per provider, last
  error, last success time).
- **R8.** Slow-request logging: any request >2s logged with timing
  breakdown where available.
- **R9.** `/health` stays cheap (no provider fan-out); add
  `/health/detail` (protected) that includes the provider registry summary.

### Input hardening

- **R10.** Body-size caps on all POST endpoints; strict Pydantic models with
  `extra="forbid"` on public inputs; analytics event-name allowlist
  (coordinates with Spec 8 R5).

## Technical design

- Rate limiter as ASGI middleware with a route-tier lookup; sliding window
  via timestamp deques per (ip, tier). Memory bounded by pruning idle IPs.
- Exception handlers + a `BackendError(code, status, message)` hierarchy in
  one module; migrate routers incrementally (one PR per router), each PR
  adding/adjusting the Spec 4 contract tests for the new shape.
- Provider health registry: a decorator/wrapper around client call methods
  (`@tracked("finnhub")`) so instrumentation doesn't duplicate into every
  method body.
- Tests: limiter unit tests (window math, XFF parsing), 429 contract tests,
  error-envelope tests per router, health-registry tests with forced
  failures.

## Acceptance criteria

- [ ] Hammering the craps translate endpoint from one IP yields 429 after
      5 requests in a minute; other IPs unaffected (test with two client
      fixtures).
- [ ] Every 4xx/5xx across all routers matches the envelope schema
      (parametrized contract test).
- [ ] Killing a provider (invalid host locally) turns its admin panel
      status red within a few requests, with last-error visible; site pages
      degrade per their own specs rather than 500ing.
- [ ] A forced 500 is traceable: response `request_id` finds the full
      stack trace in the admin log view.
- [ ] Oversized analytics payload (>16KB) rejected with `invalid_input`.
- [ ] Frontend clients (craps strategy, analytics) handle 429/envelope
      errors gracefully (manual verify).

## Risks

- **Legit users behind shared IPs (CGNAT)** hitting limits — the tiers are
  generous for human use; the daily LLM cap is the only tight one, and the
  friendly 429 copy explains it.
- **Error-shape migration breaking existing frontends** — each router's
  migration PR includes grepping that router's frontend consumers for
  error-field access and updating them in the same PR.

## Estimate

~3 weeks part-time: 1 week rate limiting, 1 week error envelope migration,
1 week provider health + admin panel.
