import type { Request, Response } from 'express';
import {
  AUTH_FLOW_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  sessionHasMfa,
} from './runtime.js';
import type { IdentityRuntime } from './runtime.js';

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

function cookieAttributes(
  runtime: IdentityRuntime,
  maxAgeSeconds: number,
  httpOnly: boolean,
) {
  const attributes = ['Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (httpOnly) attributes.push('HttpOnly');
  if (runtime.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

export function setSessionCookie(
  runtime: IdentityRuntime,
  response: Response,
  sessionId: string,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  response.append(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieAttributes(runtime, maxAgeSeconds, true)}`,
  );
  response.append(
    'set-cookie',
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${cookieAttributes(runtime, maxAgeSeconds, false)}`,
  );
}

export function clearSessionCookie(
  runtime: IdentityRuntime,
  response: Response,
): void {
  response.append(
    'set-cookie',
    `${SESSION_COOKIE}=; ${cookieAttributes(runtime, 0, true)}`,
  );
  response.append(
    'set-cookie',
    `${CSRF_COOKIE}=; ${cookieAttributes(runtime, 0, false)}`,
  );
}

function authFlowCookieAttributes(
  runtime: IdentityRuntime,
  maxAgeSeconds: number,
): string {
  const attributes = [
    'Path=/api/v1/auth',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
  ];
  if (runtime.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

export function setAuthFlowCookie(
  runtime: IdentityRuntime,
  response: Response,
  browserSecret: string,
  maxAgeSeconds: number,
): void {
  response.append(
    'set-cookie',
    `${AUTH_FLOW_COOKIE}=${encodeURIComponent(browserSecret)}; ${authFlowCookieAttributes(runtime, maxAgeSeconds)}`,
  );
}

export function clearAuthFlowCookie(
  runtime: IdentityRuntime,
  response: Response,
): void {
  response.append(
    'set-cookie',
    `${AUTH_FLOW_COOKIE}=; ${authFlowCookieAttributes(runtime, 0)}`,
  );
}

export function authFlowSecretFromRequest(request: Request): string | null {
  return readCookie(request, AUTH_FLOW_COOKIE);
}

export function sessionIdFromRequest(
  runtime: IdentityRuntime,
  request: Request,
): string | null {
  void runtime;
  return readCookie(request, SESSION_COOKIE);
}

export function csrfCookieFromRequest(request: Request): string | null {
  return readCookie(request, CSRF_COOKIE);
}

export function originAllowed(
  runtime: IdentityRuntime,
  origin: string,
): boolean {
  return origin === runtime.webOrigin || origin === runtime.apiOrigin;
}

export function headerString(request: Request, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function requestCorrelation(request: Request): string | null {
  const value = (request as Request & { correlationId?: string }).correlationId;
  return typeof value === 'string' ? value : null;
}

export function redirectAfterFrom(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\:]/.test(value)) return null;
  return value;
}

export function requestActor(
  runtime: IdentityRuntime,
  session: { id: string; user_id: string; auth_methods: string[] },
  displayName: string | null,
) {
  return {
    kind: 'USER' as const,
    userId: session.user_id,
    sessionId: session.id,
    displayName,
    mfa: sessionHasMfa(session.auth_methods),
  };
}
