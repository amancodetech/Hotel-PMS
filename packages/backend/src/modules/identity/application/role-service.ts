import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { IdentityError } from '../domain/errors.js';
import {
  isPermissionCode,
  permissionCodes,
  permissions,
  systemRoles,
  type PermissionCode,
} from '../domain/permissions.js';
import {
  countActiveAdmins,
  deleteRole,
  effectivePermissions,
  findGrantById,
  findMembershipById,
  findRoleByCode,
  findRoleById,
  insertGrant,
  insertRole,
  listGrants,
  listRoles,
  lockTenantAuthz,
  replaceRolePermissions,
  revokeGrant,
  updateRole,
} from '../persistence/org-repository.js';
import type {
  MembershipRow,
  RoleGrantRow,
  RoleRow,
} from '../persistence/types.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { one } from '../../../persistence/sql.js';
import { consumeApproval } from '../persistence/governance-repository.js';
import { recordAudit } from './audit-service.js';
import {
  evaluatePolicy,
  listEffectivePermissionViews,
  policyError,
} from './policy-service.js';
import type {
  EffectivePermissionView,
  PolicyActor,
  ProtectedActionContext,
} from './policy-service.js';

export interface RoleView extends RoleRow {
  permission_codes: string[];
}

export async function readRoles(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  propertyRef: string | null = null,
): Promise<RoleView[]> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'role.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return listRoles(em, tenantId);
    },
  );
}

export interface CreateRoleInput {
  actor: PolicyActor;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
  correlationId: string | null;
}

export async function createCustomRole(
  orm: MikroORM,
  input: CreateRoleInput,
): Promise<RoleView> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'role.manage',
      });
      if (!decision.allowed) throw policyError(decision);
      if (!decision.membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const code = input.code.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code))
        throw new IdentityError('INVALID_REQUEST', { field: 'code' });
      if (systemRoles.some((role) => role.code === code))
        throw new IdentityError('ROLE_CODE_CONFLICT');
      const unique = [...new Set(input.permissionCodes)];
      for (const permission of unique)
        if (!isPermissionCode(permission))
          throw new IdentityError('PERMISSION_UNKNOWN', { permission });
      await assertCanDelegatePermissions(
        em,
        decision.membership.id,
        unique,
        null,
      );
      const existing = await findRoleByCode(em, input.tenantId, code);
      if (existing) throw new IdentityError('ROLE_CODE_CONFLICT');
      const role = await insertRole(em, {
        tenantId: input.tenantId,
        code,
        name: input.name.trim().slice(0, 200),
        description: input.description?.slice(0, 500) ?? null,
        permissions: unique,
      });
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'role.create',
        resourceType: 'role',
        resourceId: role.id,
        outcome: 'SUCCESS',
        afterSafe: { code: role.code, permissions: unique },
        correlationId: input.correlationId,
      });
      return { ...role, permission_codes: unique.sort() };
    },
  );
}

export interface UpdateRoleInput {
  actor: PolicyActor;
  tenantId: string;
  roleId: string;
  name?: string;
  description?: string | null;
  status?: 'ACTIVE' | 'RETIRED';
  permissionCodes?: string[];
  correlationId: string | null;
}

export async function updateCustomRole(
  orm: MikroORM,
  input: UpdateRoleInput,
): Promise<RoleView> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'role.manage',
      });
      if (!decision.allowed) throw policyError(decision);
      if (!decision.membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const beforeAdmins = await countActiveAdmins(em, input.tenantId);
      const role = await findRoleById(em, input.tenantId, input.roleId);
      if (!role) throw new IdentityError('ROLE_NOT_FOUND');
      if (role.is_system) throw new IdentityError('SYSTEM_ROLE_PROTECTED');
      const beforePermissions =
        (await listRoles(em, input.tenantId)).find(
          (candidate) => candidate.id === role.id,
        )?.permission_codes ?? [];
      let unique: string[] | undefined;
      if (input.permissionCodes) {
        unique = [...new Set(input.permissionCodes)];
        for (const permission of unique)
          if (!isPermissionCode(permission))
            throw new IdentityError('PERMISSION_UNKNOWN', { permission });
        await assertCanDelegatePermissions(
          em,
          decision.membership.id,
          unique,
          null,
        );
      }
      const updated = await updateRole(em, input.tenantId, input.roleId, {
        name: input.name?.trim().slice(0, 200),
        description:
          input.description === undefined
            ? undefined
            : (input.description?.slice(0, 500) ?? null),
        status: input.status,
      });
      if (!updated) throw new IdentityError('ROLE_NOT_FOUND');
      if (unique) await replaceRolePermissions(em, role.id, unique);
      const afterAdmins = await countActiveAdmins(em, input.tenantId);
      if (beforeAdmins > 0 && afterAdmins === 0)
        throw new IdentityError('LAST_ADMIN_PROTECTED');
      const permissionCodesAfter = unique ?? beforePermissions;
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'role.update',
        resourceType: 'role',
        resourceId: role.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          name: role.name,
          status: role.status,
          permissions: beforePermissions,
        },
        afterSafe: {
          name: updated.name,
          status: updated.status,
          permissions: permissionCodesAfter,
        },
        correlationId: input.correlationId,
      });
      return { ...updated, permission_codes: permissionCodesAfter };
    },
  );
}

export async function deleteCustomRole(
  orm: MikroORM,
  input: {
    actor: PolicyActor;
    tenantId: string;
    roleId: string;
    correlationId: string | null;
  },
): Promise<void> {
  await runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'role.manage',
      });
      if (!decision.allowed) throw policyError(decision);
      const role = await findRoleById(em, input.tenantId, input.roleId);
      if (!role) throw new IdentityError('ROLE_NOT_FOUND');
      if (role.is_system) throw new IdentityError('SYSTEM_ROLE_PROTECTED');
      const activeGrant = await one<{ id: string }>(
        em,
        `select "id" from "role_grant"
          where "tenant_id" = ? and "role_id" = ? and "revoked_at" is null
          limit 1`,
        [input.tenantId, input.roleId],
      );
      if (activeGrant)
        throw new IdentityError('CONFLICT', { reason: 'granted' });
      const deleted = await deleteRole(em, input.tenantId, input.roleId);
      if (!deleted) throw new IdentityError('ROLE_NOT_FOUND');
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'role.delete',
        resourceType: 'role',
        resourceId: role.id,
        outcome: 'SUCCESS',
        beforeSafe: { code: role.code, name: role.name },
        correlationId: input.correlationId,
      });
    },
  );
}

export interface GrantRoleInput {
  actor: PolicyActor;
  tenantId: string;
  membershipId: string;
  roleId: string;
  effect: 'GRANT' | 'DENY';
  scopeType: 'TENANT' | 'PROPERTIES';
  propertyRefs: string[];
  expiresAt: string | null;
  reason: string | null;
  approvalId: string | null;
  correlationId: string | null;
}

export async function resolveGrantRole(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  roleId: string,
): Promise<RoleRow> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'role.grant',
      });
      if (!decision.allowed) throw policyError(decision);
      const role = await findRoleById(em, tenantId, roleId);
      if (!role || role.status !== 'ACTIVE')
        throw new IdentityError('ROLE_NOT_FOUND');
      return role;
    },
  );
}

export function grantActionKey(
  effect: 'GRANT' | 'DENY',
  scopeType: 'TENANT' | 'PROPERTIES',
): string {
  if (effect === 'DENY') return 'role.grant:DENY';
  return `role.grant:${scopeType}`;
}

export function grantHashInput(input: {
  membershipId: string | null;
  roleId: string;
  effect: string;
  scopeType: string;
  propertyRefs: string[];
  expiresAt: string | null;
  email?: string | null;
}) {
  return {
    membership_id: input.membershipId,
    role_id: input.roleId,
    effect: input.effect,
    scope_type: input.scopeType,
    property_refs: [...input.propertyRefs].sort(),
    expires_at: input.expiresAt,
    email: input.email ?? null,
  };
}

export async function grantRoleToMembership(
  orm: MikroORM,
  input: GrantRoleInput,
): Promise<RoleGrantRow> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const role = await findRoleById(em, input.tenantId, input.roleId);
      if (!role || role.status !== 'ACTIVE')
        throw new IdentityError('ROLE_NOT_FOUND');
      const hashInput = grantHashInput(input);
      const action: ProtectedActionContext = {
        actionKey: grantActionKey(input.effect, input.scopeType),
        hashInput,
        resourceType: 'role',
        resourceId: role.id,
        resourceVersion: role.version,
      };
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'role.grant',
        approvalId: input.approvalId,
        propertyRefs:
          input.scopeType === 'PROPERTIES' ? input.propertyRefs : [],
        protectedAction: action,
      });
      if (!decision.allowed) throw policyError(decision);
      if (!decision.membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const beforeAdmins = await countActiveAdmins(em, input.tenantId);
      const target = await findMembershipById(
        em,
        input.tenantId,
        input.membershipId,
      );
      if (!target || target.status === 'REVOKED')
        throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const propertyRefs = [...new Set(input.propertyRefs)];
      if (input.scopeType === 'PROPERTIES' && propertyRefs.length === 0)
        throw new IdentityError('GRANT_SCOPE_INVALID', {
          reason: 'empty_property_list',
        });
      if (input.scopeType === 'TENANT' && propertyRefs.length > 0)
        throw new IdentityError('GRANT_SCOPE_INVALID', {
          reason: 'tenant_scope_with_properties',
        });
      for (const propertyRef of propertyRefs)
        if (!/^[0-9a-f-]{36}$/.test(propertyRef))
          throw new IdentityError('GRANT_SCOPE_INVALID', {
            reason: 'property_ref_format',
          });
      const duplicate = await one<{ id: string }>(
        em,
        `select "id" from "role_grant"
          where "tenant_id" = ? and "membership_id" = ? and "role_id" = ?
            and "effect" = ? and "scope_type" = ? and "revoked_at" is null
            and ("expires_at" is null or "expires_at" > now())
          limit 1`,
        [
          input.tenantId,
          input.membershipId,
          input.roleId,
          input.effect,
          input.scopeType,
        ],
      );
      if (duplicate)
        throw new IdentityError('CONFLICT', { reason: 'grant_exists' });
      const delegated = await rolePermissionCodesOf(
        em,
        input.tenantId,
        input.roleId,
      );
      if (input.scopeType === 'PROPERTIES') {
        for (const propertyRef of propertyRefs)
          await assertCanDelegatePermissions(
            em,
            decision.membership.id,
            delegated,
            propertyRef,
          );
      } else {
        await assertCanDelegatePermissions(
          em,
          decision.membership.id,
          delegated,
          null,
        );
      }
      const grant = await insertGrant(em, {
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        roleId: input.roleId,
        effect: input.effect,
        scopeType: input.scopeType,
        propertyRefs,
        grantedBy: input.actor.userId,
        reason: input.reason,
        expiresAt: input.expiresAt,
      });
      if (input.approvalId) {
        const consumed = await consumeApproval(em, {
          tenantId: input.tenantId,
          approvalId: input.approvalId,
          consumedBy: input.actor.userId,
          resourceType: 'role_grant',
          resourceId: grant.id,
        });
        if (!consumed) throw new IdentityError('APPROVAL_ALREADY_USED');
      }
      if (input.effect === 'DENY') {
        const afterAdmins = await countActiveAdmins(em, input.tenantId);
        if (beforeAdmins > 0 && afterAdmins === 0)
          throw new IdentityError('LAST_ADMIN_PROTECTED');
      }
      await recordAudit(em, {
        tenantId: input.tenantId,
        propertyId: propertyRefs.length === 1 ? propertyRefs[0]! : null,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'role.grant',
        resourceType: 'role_grant',
        resourceId: grant.id,
        outcome: 'SUCCESS',
        afterSafe: {
          membership_id: grant.membership_id,
          role_code: role.code,
          role_version: role.version,
          effect: grant.effect,
          scope_type: grant.scope_type,
          property_refs: propertyRefs,
          approval_id: input.approvalId,
          expires_at: grant.expires_at,
        },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return grant;
    },
  );
}

export async function revokeRoleGrantById(
  orm: MikroORM,
  input: {
    actor: PolicyActor;
    tenantId: string;
    grantId: string;
    reason: string | null;
    correlationId: string | null;
  },
): Promise<void> {
  await runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'role.grant',
      });
      if (!decision.allowed) throw policyError(decision);
      const beforeAdmins = await countActiveAdmins(em, input.tenantId);
      const grant = await findGrantById(em, input.tenantId, input.grantId);
      if (!grant) throw new IdentityError('GRANT_NOT_FOUND');
      if (grant.revoked_at) throw new IdentityError('GRANT_ALREADY_REVOKED');
      const revoked = await revokeGrant(em, input.tenantId, input.grantId);
      if (!revoked) throw new IdentityError('GRANT_NOT_FOUND');
      const afterAdmins = await countActiveAdmins(em, input.tenantId);
      if (beforeAdmins > 0 && afterAdmins === 0)
        throw new IdentityError('LAST_ADMIN_PROTECTED');
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'role.grant.revoke',
        resourceType: 'role_grant',
        resourceId: grant.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          membership_id: grant.membership_id,
          role_id: grant.role_id,
        },
        reason: input.reason,
        correlationId: input.correlationId,
      });
    },
  );
}

export async function readGrants(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  membershipId: string | null,
  propertyRef: string | null = null,
): Promise<Awaited<ReturnType<typeof listGrants>>> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'role.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return listGrants(em, tenantId, membershipId);
    },
  );
}

export interface EffectivePermissionsResult {
  membership_id: string;
  role_codes: string[];
  permissions: EffectivePermissionView[];
}

export async function readEffectivePermissions(
  orm: MikroORM,
  input: {
    actor: PolicyActor;
    tenantId: string;
    membershipId: string | null;
    propertyRef?: string | null;
  },
): Promise<EffectivePermissionsResult> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      const selfMembership = await one<MembershipRow>(
        em,
        `select * from "membership"
          where "tenant_id" = ? and "user_id" = ? and "status" = 'ACTIVE'`,
        [input.tenantId, input.actor.userId],
      );
      const targetId = input.membershipId ?? selfMembership?.id ?? null;
      if (!targetId) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const isSelf = selfMembership?.id === targetId;
      const permission: PermissionCode = isSelf
        ? 'membership.read'
        : 'role.manage';
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission,
        propertyRef: input.propertyRef ?? null,
      });
      if (!decision.allowed) throw policyError(decision);
      const target = await findMembershipById(em, input.tenantId, targetId);
      if (!target) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const permissionRows = await listEffectivePermissionViews(em, target.id);
      const roleRows = await one<{ codes: string[] }>(
        em,
        `select coalesce(array_agg(distinct r."code" order by r."code"), '{}') as "codes"
           from "role_grant" g
           join "role" r on r."id" = g."role_id" and r."tenant_id" = g."tenant_id"
          where g."membership_id" = ?
            and g."effect" = 'GRANT'
            and g."revoked_at" is null
            and (g."expires_at" is null or g."expires_at" > now())`,
        [target.id],
      );
      return {
        membership_id: target.id,
        role_codes: roleRows?.codes ?? [],
        permissions: permissionRows,
      };
    },
  );
}

export async function assertCanDelegatePermissions(
  em: EntityManager,
  actorMembershipId: string,
  requested: string[],
  propertyRef: string | null,
): Promise<void> {
  if (requested.length === 0) return;
  const actorRows = await effectivePermissions(em, actorMembershipId);
  const granted = new Set(
    actorRows
      .filter(
        (row) =>
          row.effect === 'GRANT' &&
          (row.scope_type === 'TENANT' ||
            (propertyRef !== null && row.property_ref === propertyRef)),
      )
      .map((row) => row.permission_code),
  );
  const denied = new Set(
    actorRows
      .filter((row) => row.effect === 'DENY')
      .map((row) => row.permission_code),
  );
  for (const permission of requested)
    if (!granted.has(permission) || denied.has(permission))
      throw new IdentityError('PERMISSION_DENIED', { permission });
}

export async function rolePermissionCodesOf(
  em: EntityManager,
  tenantId: string,
  roleId: string,
): Promise<PermissionCode[]> {
  const result = (await em.execute(
    `select rp."permission_code" as "permission_code"
       from "role_permission" rp
       join "role" r on r."id" = rp."role_id"
      where r."tenant_id" = ? and r."id" = ?`,
    [tenantId, roleId] as never[],
  )) as Array<{ permission_code: string }>;
  return result.map((row) => row.permission_code as PermissionCode);
}

export function permissionCatalog() {
  return permissionCodes.map((code) => ({
    code,
    description_key: permissions[code].descriptionKey,
    mfa_required: permissions[code].mfaRequired,
  }));
}
