export interface PermissionDefinition {
  readonly descriptionKey: string;
  readonly mfaRequired: boolean;
}

export const permissions = {
  'tenant.read': {
    descriptionKey: 'permissions.tenant.read',
    mfaRequired: false,
  },
  'tenant.manage': {
    descriptionKey: 'permissions.tenant.manage',
    mfaRequired: true,
  },
  'membership.read': {
    descriptionKey: 'permissions.membership.read',
    mfaRequired: false,
  },
  'membership.invite': {
    descriptionKey: 'permissions.membership.invite',
    mfaRequired: false,
  },
  'membership.manage': {
    descriptionKey: 'permissions.membership.manage',
    mfaRequired: true,
  },
  'membership.revoke': {
    descriptionKey: 'permissions.membership.revoke',
    mfaRequired: true,
  },
  'role.read': { descriptionKey: 'permissions.role.read', mfaRequired: false },
  'role.manage': {
    descriptionKey: 'permissions.role.manage',
    mfaRequired: true,
  },
  'role.grant': { descriptionKey: 'permissions.role.grant', mfaRequired: true },
  'audit.read': {
    descriptionKey: 'permissions.audit.read',
    mfaRequired: false,
  },
  'approval.read': {
    descriptionKey: 'permissions.approval.read',
    mfaRequired: false,
  },
  'approval.approve': {
    descriptionKey: 'permissions.approval.approve',
    mfaRequired: true,
  },
  'property.read': {
    descriptionKey: 'permissions.property.read',
    mfaRequired: false,
  },
  'property.manage': {
    descriptionKey: 'permissions.property.manage',
    mfaRequired: true,
  },
  'property.resource.manage': {
    descriptionKey: 'permissions.property.resource.manage',
    mfaRequired: false,
  },
  'composition.manage': {
    descriptionKey: 'permissions.composition.manage',
    mfaRequired: true,
  },
  'channel.read': {
    descriptionKey: 'permissions.channel.read',
    mfaRequired: false,
  },
  'channel.connection.manage': {
    descriptionKey: 'permissions.channel.connection.manage',
    mfaRequired: true,
  },
  'channel.mapping.manage': {
    descriptionKey: 'permissions.channel.mapping.manage',
    mfaRequired: true,
  },
  'rate.manage': {
    descriptionKey: 'permissions.rate.manage',
    mfaRequired: true,
  },
  'reservation.read': {
    descriptionKey: 'permissions.reservation.read',
    mfaRequired: false,
  },
  'reservation.create': {
    descriptionKey: 'permissions.reservation.create',
    mfaRequired: false,
  },
  'reservation.modify': {
    descriptionKey: 'permissions.reservation.modify',
    mfaRequired: false,
  },
  'reservation.cancel': {
    descriptionKey: 'permissions.reservation.cancel',
    mfaRequired: false,
  },
  'guest.read': {
    descriptionKey: 'permissions.guest.read',
    mfaRequired: false,
  },
  'guest.manage': {
    descriptionKey: 'permissions.guest.manage',
    mfaRequired: false,
  },
  'frontdesk.read': {
    descriptionKey: 'permissions.frontdesk.read',
    mfaRequired: false,
  },
  'assignment.manage': {
    descriptionKey: 'permissions.assignment.manage',
    mfaRequired: false,
  },
  'stay.checkin': {
    descriptionKey: 'permissions.stay.checkin',
    mfaRequired: false,
  },
  'stay.move': {
    descriptionKey: 'permissions.stay.move',
    mfaRequired: false,
  },
  'stay.checkout': {
    descriptionKey: 'permissions.stay.checkout',
    mfaRequired: false,
  },
  'folio.read': {
    descriptionKey: 'permissions.folio.read',
    mfaRequired: false,
  },
  'folio.charge': {
    descriptionKey: 'permissions.folio.charge',
    mfaRequired: false,
  },
  'payment.record': {
    descriptionKey: 'permissions.payment.record',
    mfaRequired: false,
  },
  'payment.refund.request': {
    descriptionKey: 'permissions.payment.refund.request',
    mfaRequired: true,
  },
  'folio.adjust': {
    descriptionKey: 'permissions.folio.adjust',
    mfaRequired: true,
  },
  'invoice.issue': {
    descriptionKey: 'permissions.invoice.issue',
    mfaRequired: true,
  },
  'cashier.operate': {
    descriptionKey: 'permissions.cashier.operate',
    mfaRequired: false,
  },
  'business_day.close': {
    descriptionKey: 'permissions.business_day.close',
    mfaRequired: true,
  },
  'inventory.block': {
    descriptionKey: 'permissions.inventory.block',
    mfaRequired: false,
  },
  'maintenance.emergency': {
    descriptionKey: 'permissions.maintenance.emergency',
    mfaRequired: true,
  },
  'channel.sale.manage': {
    descriptionKey: 'permissions.channel.sale.manage',
    mfaRequired: true,
  },
  'channel.reconcile': {
    descriptionKey: 'permissions.channel.reconcile',
    mfaRequired: false,
  },
  'channel.reprocess': {
    descriptionKey: 'permissions.channel.reprocess',
    mfaRequired: false,
  },
  'task.read': {
    descriptionKey: 'permissions.task.read',
    mfaRequired: false,
  },
  'task.manage': {
    descriptionKey: 'permissions.task.manage',
    mfaRequired: false,
  },
  'task.complete': {
    descriptionKey: 'permissions.task.complete',
    mfaRequired: false,
  },
  'task.inspect': {
    descriptionKey: 'permissions.task.inspect',
    mfaRequired: false,
  },
  'maintenance.read': {
    descriptionKey: 'permissions.maintenance.read',
    mfaRequired: false,
  },
  'maintenance.manage': {
    descriptionKey: 'permissions.maintenance.manage',
    mfaRequired: false,
  },
  'report.operational.view': {
    descriptionKey: 'permissions.report.operational.view',
    mfaRequired: false,
  },
  'report.financial.view': {
    descriptionKey: 'permissions.report.financial.view',
    mfaRequired: false,
  },
  'report.export': {
    descriptionKey: 'permissions.report.export',
    mfaRequired: true,
  },
  'subscription.read': {
    descriptionKey: 'permissions.subscription.read',
    mfaRequired: false,
  },
  'platform.read': {
    descriptionKey: 'permissions.platform.read',
    mfaRequired: false,
  },
  'subscription.manage': {
    descriptionKey: 'permissions.subscription.manage',
    mfaRequired: true,
  },
  'platform.billing.manage': {
    descriptionKey: 'permissions.platform.billing.manage',
    mfaRequired: true,
  },
  'platform.support.manage': {
    descriptionKey: 'permissions.platform.support.manage',
    mfaRequired: true,
  },
  'platform.support.read': {
    descriptionKey: 'permissions.platform.support.read',
    mfaRequired: true,
  },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionCode = keyof typeof permissions;
export const permissionCodes = Object.keys(permissions) as PermissionCode[];

/**
 * Platform staff permissions live in the same catalog so they are visible to
 * the catalog endpoint and audited like any other code, but they are never
 * attached to tenant system roles: a platform permission grants no guest data
 * access, and a tenant permission grants no subscription management.
 */
export const platformPermissionCodes = [
  'platform.read',
  'subscription.manage',
  'platform.billing.manage',
  'platform.support.manage',
  'platform.support.read',
] as const;
export type PlatformPermissionCode = (typeof platformPermissionCodes)[number];
export function isPlatformPermissionCode(
  value: string,
): value is PlatformPermissionCode {
  return (platformPermissionCodes as readonly string[]).includes(value);
}

export const tenantPermissionCodes = permissionCodes.filter(
  (code) => !isPlatformPermissionCode(code),
);

export function isPermissionCode(value: string): value is PermissionCode {
  return Object.hasOwn(permissions, value);
}

export interface SystemRoleDefinition {
  readonly code: string;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly permissions: readonly PermissionCode[];
}

export const systemRoles = [
  {
    code: 'TENANT_OWNER',
    nameKey: 'roles.TENANT_OWNER',
    descriptionKey: 'roles.TENANT_OWNER.description',
    permissions: tenantPermissionCodes,
  },
  {
    code: 'TENANT_ADMIN',
    nameKey: 'roles.TENANT_ADMIN',
    descriptionKey: 'roles.TENANT_ADMIN.description',
    permissions: [
      'tenant.read',
      'membership.read',
      'membership.invite',
      'membership.manage',
      'membership.revoke',
      'role.read',
      'role.manage',
      'role.grant',
      'audit.read',
      'approval.read',
      'approval.approve',
      'property.read',
      'property.manage',
      'property.resource.manage',
      'composition.manage',
      'channel.read',
      'channel.connection.manage',
      'channel.mapping.manage',
      'rate.manage',
      'reservation.read',
      'reservation.create',
      'reservation.modify',
      'reservation.cancel',
      'guest.read',
      'guest.manage',
      'frontdesk.read',
      'assignment.manage',
      'stay.checkin',
      'stay.move',
      'stay.checkout',
      'folio.read',
      'folio.charge',
      'payment.record',
      'payment.refund.request',
      'folio.adjust',
      'invoice.issue',
      'cashier.operate',
      'business_day.close',
      'inventory.block',
      'maintenance.emergency',
      'channel.sale.manage',
      'channel.reconcile',
      'channel.reprocess',
      'task.read',
      'task.manage',
      'task.complete',
      'task.inspect',
      'maintenance.read',
      'maintenance.manage',
      'report.operational.view',
      'report.financial.view',
      'report.export',
      'subscription.read',
    ],
  },
  {
    code: 'AUDITOR',
    nameKey: 'roles.AUDITOR',
    descriptionKey: 'roles.AUDITOR.description',
    permissions: [
      'tenant.read',
      'membership.read',
      'role.read',
      'audit.read',
      'approval.read',
      'property.read',
      'channel.read',
      'reservation.read',
      'folio.read',
      'report.operational.view',
      'report.financial.view',
      'subscription.read',
    ],
  },
  {
    code: 'MEMBER',
    nameKey: 'roles.MEMBER',
    descriptionKey: 'roles.MEMBER.description',
    permissions: ['tenant.read', 'membership.read'],
  },
] as const satisfies readonly SystemRoleDefinition[];

export type RoleEffect = 'GRANT' | 'DENY';
export type ScopeType = 'TENANT' | 'PROPERTIES';

export function isScopeType(value: string): value is ScopeType {
  return value === 'TENANT' || value === 'PROPERTIES';
}
