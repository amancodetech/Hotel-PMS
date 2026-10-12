import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { systemRoles } from '../domain/permissions.js';
import { IdentityError } from '../domain/errors.js';
import {
  findMembership,
  findRoleByCode,
  insertGrant,
  insertMembership,
  insertRole,
  insertTenant,
  updateMembershipStatus,
} from '../persistence/org-repository.js';
import { one } from '../../../persistence/sql.js';
import { upsertUserBySubject } from '../persistence/session-repository.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';

export interface TenantOwnerInput {
  identitySubject: string;
  issuer: string;
  email: string | null;
  displayName: string | null;
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  owner: TenantOwnerInput;
}

export async function provisionTenant(
  orm: MikroORM,
  input: ProvisionTenantInput,
): Promise<{ tenantId: string; userId: string; membershipId: string }> {
  const tenantId = randomUUID();
  return runScopedTransaction(orm, { tenantId }, async (em) => {
    const tenant = await insertTenant(em, {
      id: tenantId,
      name: input.name,
      slug: input.slug,
    });
    for (const role of systemRoles) {
      await insertRole(em, {
        tenantId: tenant.id,
        code: role.code,
        name: role.nameKey,
        description: role.descriptionKey,
        isSystem: true,
        permissions: [...role.permissions],
      });
    }
    const user = await upsertUserBySubject(em, {
      identitySubject: input.owner.identitySubject,
      issuer: input.owner.issuer,
      email: input.owner.email,
      displayName: input.owner.displayName,
    });
    const membership = await insertMembership(em, {
      tenantId: tenant.id,
      userId: user.id,
      status: 'ACTIVE',
    });
    const ownerRole = await findRoleByCode(em, tenant.id, 'TENANT_OWNER');
    if (!ownerRole) throw new IdentityError('ROLE_NOT_FOUND');
    await insertGrant(em, {
      tenantId: tenant.id,
      membershipId: membership.id,
      roleId: ownerRole.id,
      effect: 'GRANT',
      scopeType: 'TENANT',
      propertyRefs: [],
      grantedBy: user.id,
      reason: 'provisioning',
    });
    return {
      tenantId: tenant.id,
      userId: user.id,
      membershipId: membership.id,
    };
  });
}

export interface AddMemberInput {
  tenantId: string;
  user: TenantOwnerInput;
  roleCode: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  scopeType?: 'TENANT' | 'PROPERTIES';
  propertyRefs?: string[];
}

export async function addMemberWithRole(
  orm: MikroORM,
  input: AddMemberInput,
): Promise<{ userId: string; membershipId: string }> {
  return runScopedTransaction(orm, { tenantId: input.tenantId }, async (em) => {
    const role = await findRoleByCode(em, input.tenantId, input.roleCode);
    if (!role) throw new IdentityError('ROLE_NOT_FOUND');
    const user = await upsertUserBySubject(em, {
      identitySubject: input.user.identitySubject,
      issuer: input.user.issuer,
      email: input.user.email,
      displayName: input.user.displayName,
    });
    let membership = await findMembership(em, input.tenantId, user.id);
    if (!membership)
      membership = await insertMembership(em, {
        tenantId: input.tenantId,
        userId: user.id,
        status: 'ACTIVE',
      });
    if (input.status === 'SUSPENDED' && membership.status !== 'SUSPENDED') {
      const suspended = await updateMembershipStatus(
        em,
        input.tenantId,
        membership.id,
        'SUSPENDED',
      );
      if (!suspended) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      membership = suspended;
    }
    const existingGrant = await one<{ id: string }>(
      em,
      `select "id" from "role_grant"
        where "tenant_id" = ? and "membership_id" = ? and "role_id" = ?
          and "revoked_at" is null
        limit 1`,
      [input.tenantId, membership.id, role.id],
    );
    if (!existingGrant)
      await insertGrant(em, {
        tenantId: input.tenantId,
        membershipId: membership.id,
        roleId: role.id,
        effect: 'GRANT',
        scopeType: input.scopeType ?? 'TENANT',
        propertyRefs: input.propertyRefs ?? [],
        grantedBy: null,
        reason: 'provisioning',
      });
    return { userId: user.id, membershipId: membership.id };
  });
}
