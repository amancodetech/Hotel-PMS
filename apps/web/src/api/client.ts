import type { Phase3Components } from '@hotel/contracts';

type Schemas = Phase3Components['schemas'];

export interface PlatformSessionInfo {
  role_code: string;
  status: string;
  permissions: string[];
}

export type SessionResponse = Schemas['SessionResponse'] & {
  platform?: PlatformSessionInfo | null;
};
export type Membership = Schemas['Membership'];
export type EffectivePermission = Schemas['EffectivePermission'];
export type EffectivePermissions = Schemas['EffectivePermissions'];
export type Invitation = Schemas['Invitation'];
export type Role = Schemas['Role'];
export type RoleGrant = Schemas['RoleGrant'];
export type Permission = Schemas['Permission'];
export type AuditEvent = Schemas['AuditEvent'];
export type ApprovalRequest = Schemas['ApprovalRequest'];
export type TenantSelection = Schemas['TenantSelection'];

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, status: number, details: Record<string, unknown>) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function errorKey(error: unknown): string {
  if (error instanceof ApiError) return `errors.${error.code}`;
  return 'errors.INTERNAL_ERROR';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new ApiError(
      data?.code ?? 'INTERNAL_ERROR',
      response.status,
      data?.details ?? {},
    );
  return data as T;
}
