import { rows } from '../../../persistence/sql.js';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  effectivePermissions,
  findMembership,
  roleCodesForMembership,
} from '../persistence/org-repository.js';
import { findApprovalForUpdate } from '../persistence/governance-repository.js';
import type {
  EffectivePermissionRow,
  MembershipRow,
} from '../persistence/types.js';
import { permissions, type PermissionCode } from '../domain/permissions.js';
import { IdentityError } from '../domain/errors.js';
import type { ApprovalRow } from '../persistence/types.js';
import { requestHash } from './crypto.js';

export interface PolicyActor {
  kind: 'USER' | 'SERVICE';
  userId: string;
  sessionId: string;
  displayName: string | null;
  mfa: boolean;
}

export interface ProtectedActionContext {
  actionKey: string;
  hashInput: unknown;
  resourceType: string;
  resourceId: string | null;
  resourceVersion?: number | null;
  currency?: string | null;
  amount?: string | null;
}

export interface PolicyCheck {
  actor: PolicyActor;
  tenantId: string;
  permission: PermissionCode;
  propertyRef?: string | null;
  propertyRefs?: string[];
  approvalId?: string | null;
  protectedAction?: ProtectedActionContext | null;
  skipApproval?: boolean;
}

export type PolicyReason =
  | 'OK'
  | 'NO_MEMBERSHIP'
  | 'MEMBERSHIP_INACTIVE'
  | 'NO_GRANT'
  | 'SCOPE_MISMATCH'
  | 'MFA_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_ALREADY_USED'
  | 'SELF_APPROVAL_DENIED';

export interface PolicyDecision {
  allowed: boolean;
  reason: PolicyReason;
  membership: MembershipRow | null;
  roles: string[];
  approvalRequired: boolean;
  mfaRequired: boolean;
}

const approvalRules: Partial<
  Record<PermissionCode, (action: ProtectedActionContext) => boolean>
> = {
  'role.grant': (action) =>
    action.actionKey === 'role.grant:TENANT' ||
    action.actionKey === 'role.grant:DENY',
};

export function requiresApproval(
  permission: PermissionCode,
  action: ProtectedActionContext | null | undefined,
): boolean {
  if (!action) return false;
  return approvalRules[permission]?.(action) ?? false;
}

function grantApplies(
  row: EffectivePermissionRow,
  propertyRef: string | null | undefined,
): boolean {
  if (row.scope_type === 'TENANT') return true;
  if (!propertyRef) return false;
  return row.property_ref === propertyRef;
}

export async function evaluatePolicy(
  em: EntityManager,
  check: PolicyCheck,
): Promise<PolicyDecision> {
  const base: PolicyDecision = {
    allowed: false,
    reason: 'NO_GRANT',
    membership: null,
    roles: [],
    approvalRequired: false,
    mfaRequired: permissions[check.permission].mfaRequired,
  };
  const membership = await findMembership(
    em,
    check.tenantId,
    check.actor.userId,
  );
  if (!membership) return { ...base, reason: 'NO_MEMBERSHIP' };
  base.membership = membership;
  if (membership.status !== 'ACTIVE')
    return { ...base, reason: 'MEMBERSHIP_INACTIVE' };
  base.roles = await roleCodesForMembership(em, membership.id);
  const effective = await effectivePermissions(em, membership.id);
  const forPermission = effective.filter(
    (row) => row.permission_code === check.permission,
  );
  if (forPermission.length === 0) return { ...base, reason: 'NO_GRANT' };
  const relevant = forPermission.filter((row) =>
    grantApplies(row, check.propertyRef),
  );
  if (relevant.length === 0) return { ...base, reason: 'SCOPE_MISMATCH' };
  if (relevant.some((row) => row.effect === 'DENY'))
    return { ...base, reason: 'NO_GRANT' };
  if (!relevant.some((row) => row.effect === 'GRANT'))
    return { ...base, reason: 'NO_GRANT' };
  if (permissions[check.permission].mfaRequired && !check.actor.mfa)
    return { ...base, reason: 'MFA_REQUIRED' };
  if (
    !check.skipApproval &&
    requiresApproval(check.permission, check.protectedAction)
  ) {
    const approval = check.approvalId
      ? await findApprovalForUpdate(em, check.tenantId, check.approvalId)
      : null;
    if (!approval) {
      return {
        ...base,
        reason: 'APPROVAL_REQUIRED',
        approvalRequired: true,
      };
    }
    const validation = await validateApproval(em, approval, check);
    if (validation !== 'OK')
      return {
        ...base,
        reason: validation,
        approvalRequired: validation === 'APPROVAL_REQUIRED',
      };
  }
  return { ...base, allowed: true, reason: 'OK' };
}

export async function validateApproval(
  em: EntityManager,
  approval: ApprovalRow,
  check: PolicyCheck,
  options: { ignoreConsumed?: boolean } = {},
): Promise<PolicyReason> {
  const action = check.protectedAction;
  if (!action) return 'OK';
  if (approval.status !== 'APPROVED') return 'APPROVAL_REQUIRED';
  if (Date.parse(approval.expires_at) <= Date.now()) return 'APPROVAL_REQUIRED';
  if (!options.ignoreConsumed && approval.consumed_at !== null)
    return 'APPROVAL_ALREADY_USED';
  if (approval.action !== action.actionKey) return 'APPROVAL_INVALID';
  if (approval.request_hash !== requestHash(action.hashInput))
    return 'APPROVAL_INVALID';
  if (action.resourceId !== null && approval.resource_id !== action.resourceId)
    return 'APPROVAL_INVALID';
  if (
    action.resourceVersion !== undefined &&
    action.resourceVersion !== null &&
    approval.resource_version !== action.resourceVersion
  )
    return 'APPROVAL_INVALID';
  if (
    action.currency !== undefined &&
    action.currency !== null &&
    approval.currency !== action.currency
  )
    return 'APPROVAL_INVALID';
  if (
    action.amount !== undefined &&
    action.amount !== null &&
    approval.amount !== action.amount
  )
    return 'APPROVAL_INVALID';
  if (approval.decided_by === check.actor.userId) return 'SELF_APPROVAL_DENIED';
  if (!approval.decided_by) return 'APPROVAL_INVALID';
  const deciderActor = {
    kind: 'USER' as const,
    userId: approval.decided_by,
    sessionId: 'approval-decider',
    displayName: null,
    mfa: true,
  };
  const references =
    check.propertyRefs && check.propertyRefs.length > 0
      ? check.propertyRefs
      : [check.propertyRef ?? null];
  for (const propertyRef of references) {
    const approvalAuthority = await evaluatePolicy(em, {
      actor: deciderActor,
      tenantId: check.tenantId,
      permission: 'approval.approve',
      propertyRef,
    });
    if (!approvalAuthority.allowed) return 'APPROVAL_INVALID';
    const actionAuthority = await evaluatePolicy(em, {
      actor: deciderActor,
      tenantId: check.tenantId,
      permission: check.permission,
      propertyRef,
    });
    if (!actionAuthority.allowed) return 'APPROVAL_INVALID';
  }
  return 'OK';
}

export interface EffectivePermissionView {
  permission: string;
  granted: boolean;
  denied: boolean;
  tenant_scope: boolean;
  property_refs: string[];
  grant_ids: string[];
}

export async function listEffectivePermissionViews(
  em: EntityManager,
  membershipId: string,
): Promise<EffectivePermissionView[]> {
  const effective = await effectivePermissions(em, membershipId);
  const byPermission = new Map<string, EffectivePermissionView>();
  for (const row of effective) {
    const view = byPermission.get(row.permission_code) ?? {
      permission: row.permission_code,
      granted: false,
      denied: false,
      tenant_scope: false,
      property_refs: [],
      grant_ids: [],
    };
    if (row.effect === 'DENY') view.denied = true;
    if (row.effect === 'GRANT') {
      view.granted = true;
      if (row.scope_type === 'TENANT') view.tenant_scope = true;
      if (row.scope_type === 'PROPERTIES' && row.property_ref)
        view.property_refs.push(row.property_ref);
    }
    if (!view.grant_ids.includes(row.grant_id))
      view.grant_ids.push(row.grant_id);
    byPermission.set(row.permission_code, view);
  }
  return [...byPermission.values()].sort((a, b) =>
    a.permission.localeCompare(b.permission),
  );
}

export function policyError(decision: PolicyDecision): IdentityError {
  const codes = {
    NO_MEMBERSHIP: 'MEMBERSHIP_INACTIVE',
    MEMBERSHIP_INACTIVE: 'MEMBERSHIP_INACTIVE',
    NO_GRANT: 'PERMISSION_DENIED',
    SCOPE_MISMATCH: 'PERMISSION_DENIED',
    MFA_REQUIRED: 'MFA_REQUIRED',
    APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
    APPROVAL_INVALID: 'APPROVAL_NOT_FOUND',
    APPROVAL_ALREADY_USED: 'APPROVAL_ALREADY_USED',
    SELF_APPROVAL_DENIED: 'SELF_APPROVAL_DENIED',
    OK: 'PERMISSION_DENIED',
  } as const;
  return new IdentityError(codes[decision.reason], {
    roles: decision.roles,
  });
}

export async function assertServicePermission(
  em: EntityManager,
  tenantId: string,
  permission: PermissionCode,
  propertyRef: string | null = null,
): Promise<void> {
  const decision = await evaluatePolicy(em, {
    actor: {
      kind: 'SERVICE',
      userId: 'service:distribution',
      sessionId: 'service',
      displayName: 'distribution service',
      mfa: true,
    },
    tenantId,
    permission,
    propertyRef,
  });
  if (!decision.allowed) throw policyError(decision);
}

export async function countPermissionRows(
  em: EntityManager,
  membershipId: string,
  permission: PermissionCode,
): Promise<number> {
  const result = await rows<{ count: number }>(
    em,
    `select count(*)::int as "count" from "role_permission" rp
       join "role_grant" g on g."role_id" = rp."role_id"
      where g."membership_id" = ? and rp."permission_code" = ?`,
    [membershipId, permission],
  );
  return result[0]?.count ?? 0;
}
