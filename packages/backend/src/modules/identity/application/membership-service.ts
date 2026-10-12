import type { MikroORM } from '@mikro-orm/postgresql';
import { IdentityError } from '../domain/errors.js';
import {
  findInvitationByTokenHash,
  findInvitationByTokenHashForUpdate,
  findInvitationById,
  insertInvitation,
  listInvitations,
  markInvitationAccepted,
  revokeInvitation,
} from '../persistence/governance-repository.js';
import {
  countActiveAdmins,
  findMembership,
  findMembershipById,
  findRoleById,
  insertGrant,
  insertMembership,
  listGrants,
  listMemberships,
  lockTenantAuthz,
  revokeActiveGrantsForMembership,
  updateMembershipStatus,
} from '../persistence/org-repository.js';
import {
  consumeApproval,
  findApprovalById,
} from '../persistence/governance-repository.js';
import type { InvitationRow, MembershipViewRow } from '../persistence/types.js';
import {
  runScopedTransaction,
  setRequestContext,
} from '../../../persistence/tenant-context.js';
import { one, rows } from '../../../persistence/sql.js';
import { recordAudit } from './audit-service.js';
import { randomToken, sha256Hex } from './crypto.js';
import {
  evaluatePolicy,
  policyError,
  validateApproval,
} from './policy-service.js';
import type { PolicyActor, ProtectedActionContext } from './policy-service.js';
import {
  assertCanDelegatePermissions,
  grantActionKey,
  grantHashInput,
  rolePermissionCodesOf,
} from './role-service.js';

export async function readMemberships(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  propertyRef: string | null = null,
): Promise<MembershipViewRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'membership.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return listMemberships(em, tenantId);
    },
  );
}

export async function readSelfMembership(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
): Promise<MembershipViewRow> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const membership = await one<MembershipViewRow>(
        em,
        `select m.*, t."name" as "tenant_name", t."slug" as "tenant_slug",
              t."status" as "tenant_status",
              u."email" as "user_email", u."display_name" as "user_display_name"
         from "membership" m
         join "tenant" t on t."id" = m."tenant_id"
         join "app_user" u on u."id" = m."user_id"
        where m."tenant_id" = ? and m."user_id" = ?`,
        [tenantId, actor.userId],
      );
      if (!membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      if (membership.status !== 'ACTIVE')
        throw new IdentityError('MEMBERSHIP_INACTIVE');
      return membership;
    },
  );
}

export interface InviteMemberInput {
  actor: PolicyActor;
  tenantId: string;
  email: string;
  roleId: string | null;
  scopeType: 'TENANT' | 'PROPERTIES';
  scopeRefs: string[];
  expiresInHours: number;
  reason: string | null;
  approvalId: string | null;
  correlationId: string | null;
}

export async function inviteMember(
  orm: MikroORM,
  input: InviteMemberInput,
): Promise<{ invitation: InvitationRow; token: string }> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'membership.invite',
      });
      if (!decision.allowed) throw policyError(decision);
      if (!decision.membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new IdentityError('INVALID_REQUEST', { field: 'email' });
      const scopeRefs = [...new Set(input.scopeRefs)];
      if (input.scopeType === 'PROPERTIES' && scopeRefs.length === 0)
        throw new IdentityError('GRANT_SCOPE_INVALID', {
          reason: 'empty_property_list',
        });
      if (input.scopeType === 'TENANT' && scopeRefs.length > 0)
        throw new IdentityError('GRANT_SCOPE_INVALID', {
          reason: 'tenant_scope_with_properties',
        });
      let roleVersion: number | null = null;
      if (input.roleId) {
        const role = await findRoleById(em, input.tenantId, input.roleId);
        if (!role || role.status !== 'ACTIVE')
          throw new IdentityError('ROLE_NOT_FOUND');
        roleVersion = role.version;
        const action: ProtectedActionContext = {
          actionKey: grantActionKey('GRANT', input.scopeType),
          hashInput: grantHashInput({
            membershipId: null,
            roleId: role.id,
            effect: 'GRANT',
            scopeType: input.scopeType,
            propertyRefs: scopeRefs,
            expiresAt: null,
            email,
          }),
          resourceType: 'role',
          resourceId: role.id,
          resourceVersion: role.version,
        };
        const grantDecision = await evaluatePolicy(em, {
          actor: input.actor,
          tenantId: input.tenantId,
          permission: 'role.grant',
          approvalId: input.approvalId,
          protectedAction: action,
        });
        if (!grantDecision.allowed) throw policyError(grantDecision);
        const delegated = await rolePermissionCodesOf(
          em,
          input.tenantId,
          role.id,
        );
        if (input.scopeType === 'PROPERTIES') {
          for (const propertyRef of scopeRefs)
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
      }
      const token = randomToken(32);
      const invitation = await insertInvitation(em, {
        tenantId: input.tenantId,
        email,
        roleId: input.roleId,
        roleVersion,
        scopeType: input.scopeType,
        scopeRefs,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(
          Date.now() + input.expiresInHours * 3_600_000,
        ).toISOString(),
        createdBy: input.actor.userId,
        invitedByMembershipId: decision.membership.id,
        approvalId: input.approvalId,
      });
      if (input.approvalId) {
        const consumed = await consumeApproval(em, {
          tenantId: input.tenantId,
          approvalId: input.approvalId,
          consumedBy: input.actor.userId,
          resourceType: 'invitation',
          resourceId: invitation.id,
        });
        if (!consumed) throw new IdentityError('APPROVAL_ALREADY_USED');
      }
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'membership.invite',
        resourceType: 'invitation',
        resourceId: invitation.id,
        outcome: 'SUCCESS',
        afterSafe: {
          email: invitation.email,
          role_id: invitation.role_id,
          role_version: invitation.role_version,
          scope_type: invitation.scope_type,
          approval_id: invitation.approval_id,
          expires_at: invitation.expires_at,
        },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return { invitation, token };
    },
  );
}

export async function readInvitations(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  propertyRef: string | null = null,
): Promise<Array<InvitationRow & { role_code: string | null }>> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'membership.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return listInvitations(em, tenantId);
    },
  );
}

export async function revokeInvitationById(
  orm: MikroORM,
  input: {
    actor: PolicyActor;
    tenantId: string;
    invitationId: string;
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
        permission: 'membership.invite',
      });
      if (!decision.allowed) throw policyError(decision);
      const invitation = await findInvitationById(
        em,
        input.tenantId,
        input.invitationId,
      );
      if (!invitation) throw new IdentityError('INVITATION_INVALID');
      const revoked = await revokeInvitation(
        em,
        input.tenantId,
        input.invitationId,
      );
      if (!revoked) throw new IdentityError('INVITATION_USED');
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'membership.invitation.revoke',
        resourceType: 'invitation',
        resourceId: invitation.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: invitation.status },
        afterSafe: { status: revoked.status },
        reason: input.reason,
        correlationId: input.correlationId,
      });
    },
  );
}

export interface AcceptInvitationInput {
  actor: PolicyActor;
  token: string;
  correlationId: string | null;
}

export async function acceptInvitation(
  orm: MikroORM,
  input: AcceptInvitationInput,
): Promise<{ membership_id: string; tenant_id: string }> {
  const tokenHash = sha256Hex(input.token);
  return runScopedTransaction(
    orm,
    { tenantId: null, userId: input.actor.userId, invitationHash: tokenHash },
    async (em) => {
      const discovered = await findInvitationByTokenHash(em, tokenHash);
      if (!discovered) throw new IdentityError('INVITATION_INVALID');
      await setRequestContext(em, {
        tenantId: discovered.tenant_id,
        userId: input.actor.userId,
        invitationHash: tokenHash,
      });
      await lockTenantAuthz(em, discovered.tenant_id);
      const invitation = await findInvitationByTokenHashForUpdate(
        em,
        tokenHash,
      );
      if (!invitation) throw new IdentityError('INVITATION_INVALID');
      if (invitation.status !== 'PENDING')
        throw new IdentityError('INVITATION_USED');
      if (invitation.used_at) throw new IdentityError('INVITATION_USED');
      if (Date.parse(invitation.expires_at) <= Date.now())
        throw new IdentityError('INVITATION_EXPIRED');
      const userRows = await rows<{ email: string | null }>(
        em,
        `select "email" from "app_user" where "id" = ?`,
        [input.actor.userId],
      );
      const email = userRows[0]?.email?.toLowerCase() ?? null;
      if (!email || email !== invitation.email.toLowerCase())
        throw new IdentityError('INVITATION_EMAIL_MISMATCH');
      let membership = await findMembership(
        em,
        invitation.tenant_id,
        input.actor.userId,
      );
      if (membership?.status === 'SUSPENDED')
        throw new IdentityError('MEMBERSHIP_INACTIVE');
      let revokedPriorGrants = 0;
      if (!membership) {
        membership = await insertMembership(em, {
          tenantId: invitation.tenant_id,
          userId: input.actor.userId,
          status: 'ACTIVE',
        });
      } else if (
        membership.status === 'REVOKED' ||
        membership.status === 'INVITED'
      ) {
        const wasRevoked = membership.status === 'REVOKED';
        const reactivated = await updateMembershipStatus(
          em,
          invitation.tenant_id,
          membership.id,
          'ACTIVE',
        );
        if (!reactivated) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
        membership = reactivated;
        if (wasRevoked)
          revokedPriorGrants = await revokeActiveGrantsForMembership(
            em,
            invitation.tenant_id,
            membership.id,
          );
      }
      if (invitation.role_id) {
        if (
          !invitation.invited_by_membership_id ||
          invitation.role_version === null
        )
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'authority_missing',
          });
        const role = await findRoleById(
          em,
          invitation.tenant_id,
          invitation.role_id,
        );
        if (!role || role.status !== 'ACTIVE')
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'role_not_found',
          });
        if (role.version !== invitation.role_version)
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'role_changed',
          });
        const inviter = await findMembershipById(
          em,
          invitation.tenant_id,
          invitation.invited_by_membership_id,
        );
        if (!inviter || inviter.status !== 'ACTIVE')
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'authority_revoked',
          });
        const scopeRefs = invitation.scope_refs;
        const action: ProtectedActionContext = {
          actionKey: grantActionKey('GRANT', invitation.scope_type),
          hashInput: grantHashInput({
            membershipId: null,
            roleId: role.id,
            effect: 'GRANT',
            scopeType: invitation.scope_type,
            propertyRefs: scopeRefs,
            expiresAt: null,
            email: invitation.email,
          }),
          resourceType: 'role',
          resourceId: role.id,
          resourceVersion: role.version,
        };
        const inviterActor: PolicyActor = {
          kind: 'USER',
          userId: inviter.user_id,
          sessionId: 'invitation-inviter',
          displayName: null,
          mfa: true,
        };
        const authority = await evaluatePolicy(em, {
          actor: inviterActor,
          tenantId: invitation.tenant_id,
          permission: 'role.grant',
          protectedAction: action,
          skipApproval: true,
        });
        if (!authority.allowed)
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'authority_revoked',
          });
        const delegated = await rolePermissionCodesOf(
          em,
          invitation.tenant_id,
          role.id,
        );
        try {
          if (invitation.scope_type === 'PROPERTIES') {
            for (const propertyRef of scopeRefs)
              await assertCanDelegatePermissions(
                em,
                inviter.id,
                delegated,
                propertyRef,
              );
          } else {
            await assertCanDelegatePermissions(em, inviter.id, delegated, null);
          }
        } catch {
          throw new IdentityError('INVITATION_INVALID', {
            reason: 'authority_revoked',
          });
        }
        if (invitation.approval_id) {
          const approval = await findApprovalById(
            em,
            invitation.tenant_id,
            invitation.approval_id,
          );
          if (!approval)
            throw new IdentityError('INVITATION_INVALID', {
              reason: 'approval_missing',
            });
          const validation = await validateApproval(
            em,
            approval,
            {
              actor: inviterActor,
              tenantId: invitation.tenant_id,
              permission: 'role.grant',
              protectedAction: action,
            },
            { ignoreConsumed: true },
          );
          if (validation !== 'OK')
            throw new IdentityError('INVITATION_INVALID', {
              reason: 'approval_invalid',
            });
        }
        const activeGrant = await one<{ id: string }>(
          em,
          `select "id" from "role_grant"
            where "tenant_id" = ? and "membership_id" = ? and "role_id" = ?
              and "revoked_at" is null
            limit 1`,
          [invitation.tenant_id, membership.id, invitation.role_id],
        );
        if (!activeGrant)
          await insertGrant(em, {
            tenantId: invitation.tenant_id,
            membershipId: membership.id,
            roleId: invitation.role_id,
            effect: 'GRANT',
            scopeType: invitation.scope_type,
            propertyRefs: invitation.scope_refs,
            grantedBy: invitation.created_by,
            reason: 'invitation.accept',
          });
      }
      const accepted = await markInvitationAccepted(
        em,
        invitation.id,
        input.actor.userId,
      );
      if (!accepted) throw new IdentityError('INVITATION_USED');
      await recordAudit(em, {
        tenantId: invitation.tenant_id,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'membership.invitation.accept',
        resourceType: 'invitation',
        resourceId: invitation.id,
        outcome: 'SUCCESS',
        afterSafe: {
          membership_id: membership.id,
          role_id: invitation.role_id,
          scope_type: invitation.scope_type,
          revoked_prior_grants: revokedPriorGrants,
        },
        correlationId: input.correlationId,
      });
      return { membership_id: membership.id, tenant_id: invitation.tenant_id };
    },
  );
}

export interface ChangeMembershipStatusInput {
  actor: PolicyActor;
  tenantId: string;
  membershipId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  reason: string | null;
  correlationId: string | null;
}

export async function changeMembershipStatus(
  orm: MikroORM,
  input: ChangeMembershipStatusInput,
): Promise<MembershipViewRow> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const permission =
        input.status === 'REVOKED' ? 'membership.revoke' : 'membership.manage';
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission,
      });
      if (!decision.allowed) throw policyError(decision);
      const beforeAdmins = await countActiveAdmins(em, input.tenantId);
      const target = await findMembershipById(
        em,
        input.tenantId,
        input.membershipId,
      );
      if (!target) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      if (target.status === input.status)
        throw new IdentityError('CONFLICT', { reason: 'already_in_state' });
      const updated = await updateMembershipStatus(
        em,
        input.tenantId,
        target.id,
        input.status,
      );
      if (!updated) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      if (input.status !== 'ACTIVE') {
        const afterAdmins = await countActiveAdmins(em, input.tenantId);
        if (beforeAdmins > 0 && afterAdmins === 0)
          throw new IdentityError('LAST_ADMIN_PROTECTED');
      }
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: `membership.${input.status.toLowerCase()}`,
        resourceType: 'membership',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: target.status },
        afterSafe: {
          status: updated.status,
          authz_version: updated.authz_version,
        },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      const views = await listMemberships(em, input.tenantId);
      const view = views.find((candidate) => candidate.id === updated.id);
      if (!view) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      return view;
    },
  );
}

export async function readMembershipGrants(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  membershipId: string,
) {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'membership.read',
      });
      if (!decision.allowed) throw policyError(decision);
      return listGrants(em, tenantId, membershipId);
    },
  );
}
