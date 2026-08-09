import { next } from '@vercel/functions';

const SESSION_COOKIE_NAME = 'pg_session';
const AUTH_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.APP_AUTH_RATE_LIMIT_WINDOW_SECONDS || 900);
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.APP_AUTH_RATE_LIMIT_MAX_ATTEMPTS || 8);
// Best-effort, per-isolate auth-failure tracking. On Vercel each instance is
// ephemeral and isolated, so MAX_ATTEMPTS is enforced per cold start, not
// globally. For a real lockout, back this with a shared store (Vercel KV /
// Redis). The current setup still raises the cost of online guessing — an
// attacker has to keep churning isolates to keep guessing.
const authFailureStore = new Map();

const PUBLIC_PREFIXES = [
  '/api/analytics',
  '/api/craps',
  '/poker',
  '/craps',
  '/craps-strategy',
  '/high-card-flush',
  '/api/poker',
  '/stock-research',
  '/bitcoin-chat',
  '/api/stocks',
  '/api/bitcoin',
  '/api/fantasy',
];

// Members-only pages. These live underneath a public prefix ('/api/fantasy'
// is public here, and the origin treats '/fantasy' as demo), so they have to
// be checked BEFORE the public short-circuit in isProtectedPath — otherwise
// they inherit anonymous access from their parent.
// Keep in sync with MEMBER_PATH_PREFIXES in backend/app/main.py.
const MEMBER_PREFIXES = [
  '/fantasy/league',
];

const PROTECTED_PREFIXES = [
  '/admin',
  '/api',
  '/fantasy/league',
];

// Signed in is not enough here: these expose logs, analytics, and collector
// controls, so they require the admin role rather than any member account.
const ADMIN_PREFIXES = [
  '/admin',
  '/api/admin',
  '/api/fantasy/admin',
];

const ROLE_ADMIN = 'admin';
const ROLE_MEMBER = 'member';

const OPTIONAL_AUTH_API_PREFIXES = [
  '/api/stocks',
  '/api/bitcoin',
  '/api/fantasy',
];

const REALM = 'Palmer Gill Apps';

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function signSessionValue(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

// Sign session tokens with a dedicated secret so a leaked token can't be used
// as an offline oracle to brute-force the account password. Falls back to the
// password to preserve existing deployments; set APP_SESSION_SECRET to decouple
// them and allow rotating sessions without changing the password.
//
// Whatever this resolves to must match the API service, which mints every
// session token now that member accounts live in its database. Both platforms
// already read APP_AUTH_PASSWORD, so the fallback keeps working — but set
// APP_SESSION_SECRET in both places to decouple sessions from the password.
function sessionSigningSecret(password) {
  return process.env.APP_SESSION_SECRET || password;
}

function parseCookies(cookieHeader) {
  const cookies = new Map();
  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }

  return cookies;
}

// Resolve the session cookie to { username, role }, or null. Mirrors
// `session_identity` in backend/app/main.py — the API service issues these
// tokens, this only verifies them.
async function sessionIdentity(request, adminUsername, password) {
  const token = parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE_NAME);
  if (!token) return null;

  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;

  const expectedSignature = await signSessionValue(sessionSigningSecret(password), payload);
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  let data;
  try {
    data = JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }

  if (!data || Number(data.exp || 0) <= Math.floor(Date.now() / 1000)) return null;

  const username = String(data.u || '');
  if (!username) return null;

  // A missing role claim is a token minted before member accounts existed;
  // only the admin could hold one. An explicit admin claim is likewise only
  // honored for the configured admin username.
  if (data.r === undefined || data.r === ROLE_ADMIN) {
    if (!timingSafeEqual(username, adminUsername)) return null;
    return { username: adminUsername, role: ROLE_ADMIN };
  }

  if (data.r === ROLE_MEMBER) {
    return { username, role: ROLE_MEMBER };
  }

  return null;
}

// The API service owns member accounts and mints every session cookie. The
// edge normally verifies the cookie locally to avoid a network round trip,
// but the two deployments can temporarily disagree while environment changes
// roll out (most notably APP_SESSION_SECRET). In that case, ask the authority
// that issued the cookie before treating a successful login as signed out.
//
// Only callers with a pg_session cookie reach this fallback, and the status
// endpoint is explicitly no-store, so anonymous page loads remain local and a
// stale identity cannot be cached at the edge.
async function sessionIdentityFromApi(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  if (!parseCookies(cookieHeader).has(SESSION_COOKIE_NAME)) return null;

  try {
    const response = await fetch(new URL('/login/session', request.url), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
      },
      cache: 'no-store',
      redirect: 'manual',
    });
    if (!response.ok) return null;

    const data = await response.json();
    const username = String(data?.username || '');
    if (!data?.authenticated || !username) return null;
    if (data.role !== ROLE_ADMIN && data.role !== ROLE_MEMBER) return null;

    return { username, role: data.role };
  } catch {
    // A failed authority check is a failed authentication check. The normal
    // redirect/challenge below remains the safe failure mode.
    return null;
  }
}

function isMemberPath(pathname) {
  return MEMBER_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

function isProtectedPath(pathname) {
  // Checked first: a members-only page nested under a public prefix must not
  // be exempted by its parent.
  if (isMemberPath(pathname)) {
    return true;
  }

  if (PUBLIC_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))) {
    return false;
  }

  return PROTECTED_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

function isOptionalAuthApiPath(pathname) {
  return OPTIONAL_AUTH_API_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

function isAdminPath(pathname) {
  return ADMIN_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

// The admin keeps being announced to the origin with Basic credentials, which
// is how this has always worked. A member is NOT: forwarding the admin's
// credentials would hand every signed-in account admin rights at the origin.
// Their `pg_session` cookie rides along with the proxied request and the API
// service validates it there.
function withOriginAuth(request, identity, username, password) {
  if (identity.role !== ROLE_ADMIN) {
    return next();
  }

  if (!new URL(request.url).pathname.startsWith('/api/')) {
    return next();
  }

  const headers = new Headers(request.headers);
  headers.set('authorization', `Basic ${btoa(`${username}:${password}`)}`);
  return next({ request: { headers } });
}

function shouldRedirectToLogin(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  // Page requests get the login form. A Basic-auth challenge on a normal
  // navigation surfaces as a browser modal, which is a dead end for a member
  // who simply is not signed in yet.
  const isPage = url.pathname === '/admin'
    || url.pathname.startsWith('/admin/')
    || isMemberPath(url.pathname);
  if (!isPage) return false;

  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html') || accept.includes('*/*');
}

function loginRedirect(request) {
  const url = new URL(request.url);
  const loginUrl = new URL('/login/', url.origin);
  loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl, 302);
}

function unauthorized(request) {
  if (shouldRedirectToLogin(request)) {
    return loginRedirect(request);
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}

const MISSING_CONFIG_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temporarily unavailable — Palmer Gill</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf6f0; color: #23201c; font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 420px; margin: 24px; padding: 36px 32px; background: #ffffff; border: 1px solid #ece4d8; border-radius: 18px; text-align: center; box-shadow: 0 10px 30px rgba(60, 50, 35, 0.08); }
  h1 { font-size: 1.25rem; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { color: #5d574e; margin: 0 0 22px; line-height: 1.55; font-size: 0.95rem; }
  a { display: inline-block; padding: 10px 20px; border-radius: 999px; background: #5b7152; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  a:hover { background: #4c6044; }
</style>
</head>
<body>
<div class="card">
  <h1>This section is temporarily unavailable</h1>
  <p>Sign-in isn't configured on this deployment, so protected pages can't be shown right now.</p>
  <a href="/">Back to projects</a>
</div>
</body>
</html>`;

const FORBIDDEN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not your area — Palmer Gill</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf6f0; color: #23201c; font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 420px; margin: 24px; padding: 36px 32px; background: #ffffff; border: 1px solid #ece4d8; border-radius: 18px; text-align: center; box-shadow: 0 10px 30px rgba(60, 50, 35, 0.08); }
  h1 { font-size: 1.25rem; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { color: #5d574e; margin: 0 0 22px; line-height: 1.55; font-size: 0.95rem; }
  a { display: inline-block; padding: 10px 20px; border-radius: 999px; background: #5b7152; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  a:hover { background: #4c6044; }
</style>
</head>
<body>
<div class="card">
  <h1>This part is admin-only</h1>
  <p>Your account is signed in, but logs and site internals are limited to the site owner.</p>
  <a href="/">Back to projects</a>
</div>
</body>
</html>`;

function forbidden(request) {
  const accept = request.headers.get('accept') || '';
  if ((request.method === 'GET' || request.method === 'HEAD') && accept.includes('text/html')) {
    return new Response(FORBIDDEN_PAGE, {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return jsonResponse({ error: 'Admin access required' }, 403);
}

function missingConfig(request) {
  const accept = (request && request.headers.get('accept')) || '';
  if (accept.includes('text/html')) {
    return new Response(MISSING_CONFIG_PAGE, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response('App authentication is not configured', {
    status: 503,
  });
}

function tooManyAuthAttempts() {
  return jsonResponse(
    { error: 'Too many sign-in attempts. Try again later.' },
    429,
    { 'Retry-After': String(AUTH_RATE_LIMIT_WINDOW_SECONDS) },
  );
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// The real client IP is the hop the trusted edge proxy appended, counting from
// the right of X-Forwarded-For. Entries to its left are client-supplied and
// spoofable, so keying rate limits on the leftmost entry lets an attacker
// rotate fake IPs to evade them.
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || 1));

function clientIp(request) {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) {
      return hops[hops.length - Math.min(TRUSTED_PROXY_HOPS, hops.length)];
    }
  }

  return request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    'unknown';
}

function authRateLimitKey(request) {
  return clientIp(request);
}

function recentAuthFailures(key, now = Date.now()) {
  const cutoff = now - (AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000);
  const attempts = (authFailureStore.get(key) || []).filter((t) => t > cutoff);
  if (attempts.length) {
    authFailureStore.set(key, attempts);
  } else {
    authFailureStore.delete(key);
  }
  return attempts;
}

function authRateLimited(request) {
  return recentAuthFailures(authRateLimitKey(request)).length >= AUTH_RATE_LIMIT_MAX_ATTEMPTS;
}

function recordAuthFailure(request) {
  const key = authRateLimitKey(request);
  const attempts = recentAuthFailures(key);
  attempts.push(Date.now());
  authFailureStore.set(key, attempts);
}

function clearAuthFailures(request) {
  authFailureStore.delete(authRateLimitKey(request));
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let mismatch = aBytes.length !== bBytes.length ? 1 : 0;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

function decodeBasicAuth(value) {
  if (!value?.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = atob(value.slice('Basic '.length));
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

// Sign-in, sign-up, and sign-out are handled by the API service (see
// backend/app/main.py) because member accounts live in its database, which
// the edge runtime can't reach. vercel.json rewrites /login/session,
// /login/signup, and /login/logout there; this middleware only verifies the
// session cookie that service issues.
export default async function middleware(request) {
  const url = new URL(request.url);
  const username = process.env.APP_AUTH_USERNAME || 'palmer';
  const password = process.env.APP_AUTH_PASSWORD;

  let identity = password ? await sessionIdentity(request, username, password) : null;
  if (!identity && isProtectedPath(url.pathname)) {
    identity = await sessionIdentityFromApi(request);
  }

  if (identity && isAdminPath(url.pathname)) {
    clearAuthFailures(request);
    if (identity.role !== ROLE_ADMIN) {
      return forbidden(request);
    }
    return withOriginAuth(request, identity, username, password);
  }

  if (isOptionalAuthApiPath(url.pathname) && identity) {
    clearAuthFailures(request);
    return withOriginAuth(request, identity, username, password);
  }

  if (!isProtectedPath(url.pathname)) {
    return next();
  }

  if (!password) {
    return process.env.VERCEL ? missingConfig(request) : next();
  }

  if (identity) {
    clearAuthFailures(request);
    return withOriginAuth(request, identity, username, password);
  }

  if (request.headers.get('authorization') && authRateLimited(request)) {
    return tooManyAuthAttempts();
  }

  const credentials = decodeBasicAuth(request.headers.get('authorization'));
  if (
    !credentials ||
    !timingSafeEqual(credentials.username, username) ||
    !timingSafeEqual(credentials.password, password)
  ) {
    if (request.headers.get('authorization')) {
      recordAuthFailure(request);
    }
    return unauthorized(request);
  }

  // Basic credentials are the admin's, so this is always an admin identity.
  clearAuthFailures(request);
  return withOriginAuth(request, { username, role: ROLE_ADMIN }, username, password);
}

export const config = {
  matcher: [
    '/stock-research/:path*',
    '/bitcoin-chat/:path*',
    '/admin/:path*',
    '/api/:path*',
    // The rest of /fantasy is public and deliberately unmatched; only the
    // members-only league hub runs through the edge.
    '/fantasy/league/:path*',
  ],
};
