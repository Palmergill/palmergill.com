// Shared API origin for every static frontend (poker, stock-research,
// bitcoin-chat, etc.). All apps issue requests to `${API_ORIGIN}/api/...`.
//
// Production: Vercel rewrites `/api/*` to the Railway FastAPI service, so a
// same-origin empty string just works. Local dev: `./start.sh` runs FastAPI
// with LOCAL_SITE_ROOT=true and serves both the static site and `/api/*` from
// the same process, so an empty string also works.
//
// For non-standard setups (e.g. serving the static site separately on :3000
// while FastAPI runs on :8000), set `window.PALMER_API_ORIGIN` before loading
// any app script.
(function () {
    if (typeof window.API_ORIGIN === 'string') return;
    window.API_ORIGIN = (typeof window.PALMER_API_ORIGIN === 'string')
        ? window.PALMER_API_ORIGIN
        : '';
})();
