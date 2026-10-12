import type { PlatformPermissionCode } from '../../identity/domain/permissions.js';

export const platformRoleCodes = [
  'PLATFORM_ADMIN',
  'PLATFORM_SUPPORT',
] as const;
export type PlatformRoleCode = (typeof platformRoleCodes)[number];

export function isPlatformRoleCode(value: string): value is PlatformRoleCode {
  return (platformRoleCodes as readonly string[]).includes(value);
}

/**
 * Platform staff roles are code-defined (never tenant roles): an admin manages
 * subscriptions, billing and support grants; a support engineer can only read
 * the minimal platform directory and use explicit, time-boxed support grants.
 * No platform role carries any tenant permission.
 */
export const platformRolePermissions: Record<
  PlatformRoleCode,
  readonly PlatformPermissionCode[]
> = {
  PLATFORM_ADMIN: [
    'platform.read',
    'subscription.manage',
    'platform.billing.manage',
    'platform.support.manage',
    'platform.support.read',
  ],
  PLATFORM_SUPPORT: ['platform.read', 'platform.support.read'],
};

export function platformRoleHasPermission(
  roleCode: string,
  permission: PlatformPermissionCode,
): boolean {
  if (!isPlatformRoleCode(roleCode)) return false;
  return platformRolePermissions[roleCode].includes(permission);
}

export const supportScopes = ['tenant.read', 'audit.read'] as const;
export type SupportScope = (typeof supportScopes)[number];

export function isSupportScope(value: string): value is SupportScope {
  return (supportScopes as readonly string[]).includes(value);
}
