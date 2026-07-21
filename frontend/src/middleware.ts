import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/unsubscribe'];
const API_PREFIX = '/api/';
const STATIC_PREFIXES = ['/_next/', '/favicon'];
const PUBLIC_ASSET_PATHS = new Set(['/logo.png', '/widget.css', '/widget.js']);

export function shouldBypassAuth(pathname: string) {
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || PUBLIC_ASSET_PATHS.has(pathname);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow static assets and API routes
  if (shouldBypassAuth(pathname)) {
    return NextResponse.next();
  }

  // Allow public pages
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for auth token in cookies or Authorization header
  const token =
    request.cookies.get('token')?.value ||
    request.headers.get('authorization')?.replace('Bearer ', '');

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next|favicon|login|register|unsubscribe).*)'],
};
