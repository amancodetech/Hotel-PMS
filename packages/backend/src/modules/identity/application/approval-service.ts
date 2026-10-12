import type { MikroORM } from '@mikro-orm/postgresql';
import { IdentityError } from '../domain/errors.js';
import type { PermissionCode } from '../domain/permissions.js';
import {
  decideApproval,
  findApprovalById,
  insertApproval,
  listApprovals,
} from '../persistence/governance-repository.js';
import type { ApprovalRow } from '../persistence/types.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { lockTenantAuthz } from '../persistence/org-repository.js';
import { recordAudit } from './audit-service.js';
import { requestHash } from './crypto.js';
import { evaluatePolicy, policyError } from './policy-service.js';
import type { PolicyActor } from './policy-service.js';

export interface CreateApprovalInput {
  actor: PolicyActor;
  tenantId: string;
  permission: PermissionCode;
  actionKey: string;
  resourceType: string;
  resourceId: string | null;
  hashInput: unknown;
  resourceVersion?: number | null;
  currency?: string | null;
  amount?: string | null;
  reason: string | null;
  correlationId: string | null;
}

export async function createApprovalRequest(
  orm: MikroORM,
  input: CreateApprovalInput,
): Promise<ApprovalRow> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: input.permission,
      });
      if (!decision.allowed) throw policyError(decision);
      const approval = await insertApproval(em, {
        tenantId: input.tenantId,
        action: input.actionKey,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        requestHash: requestHash(input.hashInput),
        resourceVersion: input.resourceVersion ?? null,
        currency: input.currency ?? null,
        amount: input.amount ?? null,
        requestedBy: input.actor.userId,
        reason: input.reason,
        ttlMinutes: 24 * 60,
      });
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'approval.request',
        resourceType: 'approval_request',
        resourceId: approval.id,
        outcome: 'SUCCESS',
        afterSafe: { action: approval.action, status: approval.status },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return approval;
    },
  );
}

export interface DecideApprovalInput {
  actor: PolicyActor;
  tenantId: string;
  approvalId: string;
  permission: PermissionCode;
  decision: 'APPROVED' | 'REJECTED';
  reason: string | null;
  correlationId: string | null;
}

export async function decideApprovalRequest(
  orm: MikroORM,
  input: DecideApprovalInput,
): Promise<ApprovalRow> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const approverDecision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: 'approval.approve',
      });
      if (!approverDecision.allowed) throw policyError(approverDecision);
      const approval = await findApprovalById(
        em,
        input.tenantId,
        input.approvalId,
      );
      if (!approval) throw new IdentityError('APPROVAL_NOT_FOUND');
      if (approval.requested_by === input.actor.userId)
        throw new IdentityError('SELF_APPROVAL_DENIED');
      if (approval.status !== 'PENDING')
        throw new IdentityError('APPROVAL_ALREADY_DECIDED');
      if (Date.parse(approval.expires_at) <= Date.now())
        throw new IdentityError('APPROVAL_EXPIRED');
      const actionDecision = await evaluatePolicy(em, {
        actor: input.actor,
        tenantId: input.tenantId,
        permission: input.permission,
      });
      if (!actionDecision.allowed) throw policyError(actionDecision);
      const updated = await decideApproval(
        em,
        input.tenantId,
        input.approvalId,
        input.decision,
        input.actor.userId,
        input.reason,
      );
      if (!updated) throw new IdentityError('APPROVAL_ALREADY_DECIDED');
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: `approval.${input.decision.toLowerCase()}`,
        resourceType: 'approval_request',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: approval.status },
        afterSafe: { status: updated.status },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return updated;
    },
  );
}

export async function cancelApprovalRequest(
  orm: MikroORM,
  input: {
    actor: PolicyActor;
    tenantId: string;
    approvalId: string;
    reason: string | null;
    correlationId: string | null;
  },
): Promise<ApprovalRow> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: input.actor.userId },
    async (em) => {
      await lockTenantAuthz(em, input.tenantId);
      const approval = await findApprovalById(
        em,
        input.tenantId,
        input.approvalId,
      );
      if (!approval) throw new IdentityError('APPROVAL_NOT_FOUND');
      if (approval.requested_by !== input.actor.userId)
        throw new IdentityError('PERMISSION_DENIED');
      if (approval.status !== 'PENDING')
        throw new IdentityError('APPROVAL_ALREADY_DECIDED');
      const updated = await decideApproval(
        em,
        input.tenantId,
        input.approvalId,
        'CANCELLED',
        input.actor.userId,
        input.reason,
      );
      if (!updated) throw new IdentityError('APPROVAL_ALREADY_DECIDED');
      await recordAudit(em, {
        tenantId: input.tenantId,
        actorType: 'USER',
        actorId: input.actor.userId,
        actorLabel: input.actor.displayName,
        action: 'approval.cancel',
        resourceType: 'approval_request',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: approval.status },
        afterSafe: { status: updated.status },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return updated;
    },
  );
}

export async function readApprovals(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  status: string | null,
  _correlationId: string | null,
  propertyRef: string | null = null,
): Promise<ApprovalRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'approval.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return listApprovals(em, tenantId, status);
    },
  );
}
