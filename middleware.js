import { next } from '@vercel/functions';

const SESSION_COOKIE_NAME = 'pg_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
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
  '/api/poker',
  '/login/session',
  '/login/logout',
  '/stock-research',
  '/bitcoin-chat',
  '/api/stocks',
  '/api/bitcoin',
];

const PROTECTED_PREFIXES = [
  '/admin',
  '/api',
];

const OPTIONAL_AUTH_API_PREFIXES = [
  '/api/stocks',
  '/api/bitcoin',
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
function sessionSigningSecret(password) {
  return process.env.APP_SESSION_SECRET || password;
}

async function createSessionToken(username, password) {
  const payload = base64UrlEncode(JSON.stringify({
    u: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  const signature = await signSessionValue(sessionSigningSecret(password), payload);
  return `${payload}.${signature}`;
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

async function validSessionCookie(request, username, password) {
  const token = parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE_NAME);
  if (!token) return false;

  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;

  const expectedSignature = await signSessionValue(sessionSigningSecret(password), payload);
  if (!timingSafeEqual(signature, expectedSignature)) return false;

  try {
    const data = JSON.parse(base64UrlDecode(payload));
    return (
      data &&
      timingSafeEqual(String(data.u || ''), username) &&
      Number(data.exp || 0) > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

function isProtectedPath(pathname) {
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

function withOriginAuth(request, username, password) {
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
  if (!(url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) return false;

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

function missingConfig() {
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

function safeNextPath(value, fallback = '/') {
  if (!value || typeof value !== 'string') return fallback;

  let url;
  try {
    url = new URL(value, 'https://palmergill.local');
  } catch {
    return fallback;
  }

  if (url.origin !== 'https://palmergill.local') return fallback;
  if (url.pathname === '/login' || url.pathname === '/login/') return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
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

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function handleLoginSession(request, username, password) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
  }

  if (!password) {
    return jsonResponse({ error: 'App authentication is not configured' }, 503);
  }

  if (authRateLimited(request)) {
    return tooManyAuthAttempts();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    recordAuthFailure(request);
    return jsonResponse({ error: 'Invalid login request' }, 400);
  }

  const submittedUsername = String(body?.username || '');
  const submittedPassword = String(body?.password || '');
  const redirect = safeNextPath(body?.next);
  if (
    !timingSafeEqual(submittedUsername, username) ||
    !timingSafeEqual(submittedPassword, password)
  ) {
    recordAuthFailure(request);
    return jsonResponse({ error: 'Invalid username or password' }, 401);
  }

  clearAuthFailures(request);
  const token = await createSessionToken(username, password);
  return jsonResponse(
    { ok: true, redirect },
    200,
    { 'Set-Cookie': sessionCookie(token, request) },
  );
}

function handleLogout(request) {
  const url = new URL('/login/', request.url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': clearSessionCookie(request),
    },
  });
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

export default async function middleware(request) {
  const url = new URL(request.url);
  const username = process.env.APP_AUTH_USERNAME || 'palmer';
  const password = process.env.APP_AUTH_PASSWORD;

  if (url.pathname === '/login/session') {
    return handleLoginSession(request, username, password);
  }

  if (url.pathname === '/login/logout') {
    return handleLogout(request);
  }

  if (
    isOptionalAuthApiPath(url.pathname) &&
    password &&
    await validSessionCookie(request, username, password)
  ) {
    clearAuthFailures(request);
    return withOriginAuth(request, username, password);
  }

  if (!isProtectedPath(url.pathname)) {
    return next();
  }

  if (!password) {
    return process.env.VERCEL ? missingConfig() : next();
  }

  if (await validSessionCookie(request, username, password)) {
    clearAuthFailures(request);
    return withOriginAuth(request, username, password);
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

  clearAuthFailures(request);
  return withOriginAuth(request, username, password);
}

export const config = {
  matcher: [
    '/stock-research/:path*',
    '/bitcoin-chat/:path*',
    '/login/session',
    '/login/logout',
    '/admin/:path*',
    '/api/:path*',
  ],
};
