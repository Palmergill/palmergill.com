import { next } from '@vercel/functions';

const PUBLIC_PREFIXES = [
  '/poker',
  '/craps',
  '/api/poker',
];

const PROTECTED_PREFIXES = [
  '/stock-research',
  '/bitcoin-chat',
  '/admin',
  '/api',
];

const REALM = 'Palmer Gill Apps';

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

function unauthorized() {
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

export default function middleware(request) {
  const url = new URL(request.url);

  if (!isProtectedPath(url.pathname)) {
    return next();
  }

  const username = process.env.APP_AUTH_USERNAME || 'palmer';
  const password = process.env.APP_AUTH_PASSWORD;

  if (!password) {
    return process.env.VERCEL ? missingConfig() : next();
  }

  const credentials = decodeBasicAuth(request.headers.get('authorization'));
  if (
    !credentials ||
    credentials.username !== username ||
    credentials.password !== password
  ) {
    return unauthorized();
  }

  return next();
}

export const config = {
  matcher: [
    '/stock-research/:path*',
    '/bitcoin-chat/:path*',
    '/admin/:path*',
    '/api/:path*',
  ],
};
