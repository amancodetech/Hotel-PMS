import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type { ApprovalRow, AuditEventRow, InvitationRow } from './types.js';

export interface InsertInvitationInput {
  tenantId: string;
  email: string;
  roleId: string | null;
  roleVersion: number | null;
  scopeType: 'TENANT' | 'PROPERTIES';
  scopeRefs: string[];
  tokenHash: string;
  expiresAt: string;
  createdBy: string;
  invitedByMembershipId: string | null;
  approvalId: string | null;
}

export async function insertInvitation(
  em: EntityManager,
  input: InsertInvitationInput,
): Promise<InvitationRow> {
  const row = await one<InvitationRow>(
    em,
    `insert into "invitation"
       ("id", "tenant_id", "email", "role_id", "role_version", "scope_type",
        "scope_refs", "token_hash", "expires_at", "created_by",
        "invited_by_membership_id", "approval_id")
     values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.email,
      input.roleId,
      input.roleVersion,
      input.scopeType,
      toJson(input.scopeRefs),
      input.tokenHash,
      input.expiresAt,
      input.createdBy,
      input.invitedByMembershipId,
      input.approvalId,
    ],
  );
  if (!row) throw new Error('Invitation insert returned no row');
  return row;
}

export async function findInvitationByTokenHash(
  em: EntityManager,
  tokenHash: string,
): Promise<InvitationRow | null> {
  return one<InvitationRow>(
    em,
    `select * from "invitation" where "token_hash" = ?`,
    [tokenHash],
  );
}

export async function findInvitationByTokenHashForUpdate(
  em: EntityManager,
  tokenHash: string,
): Promise<InvitationRow | null> {
  return one<InvitationRow>(
    em,
    `select * from "invitation" where "token_hash" = ? for update`,
    [tokenHash],
  );
}

export async function findInvitationById(
  em: EntityManager,
  tenantId: string,
  invitationId: string,
): Promise<InvitationRow | null> {
  return one<InvitationRow>(
    em,
    `select * from "invitation" where "tenant_id" = ? and "id" = ?`,
    [tenantId, invitationId],
  );
}

export async function listInvitations(
  em: EntityManager,
  tenantId: string,
): Promise<Array<InvitationRow & { role_code: string | null }>> {
  return rows<InvitationRow & { role_code: string | null }>(
    em,
    `select i.*, r."code" as "role_code"
       from "invitation" i
       left join "role" r on r."id" = i."role_id"
      where i."tenant_id" = ?
      order by i."created_at" desc`,
    [tenantId],
  );
}

export async function markInvitationAccepted(
  em: EntityManager,
  invitationId: string,
  userId: string,
): Promise<InvitationRow | null> {
  return one<InvitationRow>(
    em,
    `update "invitation"
        set "status" = 'ACCEPTED', "used_at" = now(), "accepted_by" = ?,
            "updated_at" = now()
      where "id" = ? and "status" = 'PENDING' and "used_at" is null
      returning *`,
    [userId, invitationId],
  );
}

export async function revokeInvitation(
  em: EntityManager,
  tenantId: string,
  invitationId: string,
): Promise<InvitationRow | null> {
  return one<InvitationRow>(
    em,
    `update "invitation"
        set "status" = 'REVOKED', "updated_at" = now()
      where "tenant_id" = ? and "id" = ? and "status" = 'PENDING'
      returning *`,
    [tenantId, invitationId],
  );
}

export interface InsertApprovalInput {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestHash: string;
  resourceVersion: number | null;
  currency: string | null;
  amount: string | null;
  requestedBy: string;
  reason: string | null;
  ttlMinutes: number;
}

export async function insertApproval(
  em: EntityManager,
  input: InsertApprovalInput,
): Promise<ApprovalRow> {
  const row = await one<ApprovalRow>(
    em,
    `insert into "approval_request"
       ("id", "tenant_id", "action", "resource_type", "resource_id",
        "request_hash", "resource_version", "currency", "amount",
        "requested_by", "reason", "expires_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             now() + (? * interval '1 minute'))
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.requestHash,
      input.resourceVersion,
      input.currency,
      input.amount,
      input.requestedBy,
      input.reason,
      input.ttlMinutes,
    ],
  );
  if (!row) throw new Error('Approval insert returned no row');
  return row;
}

export async function findApprovalById(
  em: EntityManager,
  tenantId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  return one<ApprovalRow>(
    em,
    `select * from "approval_request" where "tenant_id" = ? and "id" = ?`,
    [tenantId, approvalId],
  );
}

export async function findApprovalForUpdate(
  em: EntityManager,
  tenantId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  return one<ApprovalRow>(
    em,
    `select * from "approval_request"
      where "tenant_id" = ? and "id" = ?
      for update`,
    [tenantId, approvalId],
  );
}

export async function consumeApproval(
  em: EntityManager,
  input: {
    tenantId: string;
    approvalId: string;
    consumedBy: string;
    resourceType: string;
    resourceId: string;
  },
): Promise<ApprovalRow | null> {
  return one<ApprovalRow>(
    em,
    `update "approval_request"
        set "consumed_at" = now(),
            "consumed_by" = ?,
            "consumed_resource_type" = ?,
            "consumed_resource_id" = ?,
            "updated_at" = now()
      where "tenant_id" = ? and "id" = ?
        and "status" = 'APPROVED'
        and "consumed_at" is null
      returning *`,
    [
      input.consumedBy,
      input.resourceType,
      input.resourceId,
      input.tenantId,
      input.approvalId,
    ],
  );
}

export async function listApprovals(
  em: EntityManager,
  tenantId: string,
  status: string | null = null,
): Promise<ApprovalRow[]> {
  return rows<ApprovalRow>(
    em,
    `select * from "approval_request"
      where "tenant_id" = ? and (?::text is null or "status" = ?::text)
      order by "created_at" desc
      limit 200`,
    [tenantId, status, status],
  );
}

export async function decideApproval(
  em: EntityManager,
  tenantId: string,
  approvalId: string,
  decision: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  decidedBy: string,
  decisionReason: string | null,
): Promise<ApprovalRow | null> {
  return one<ApprovalRow>(
    em,
    `update "approval_request"
        set "status" = ?, "decided_by" = ?, "decision_reason" = ?,
            "decided_at" = now(), "updated_at" = now()
      where "tenant_id" = ? and "id" = ? and "status" = 'PENDING'
      returning *`,
    [decision, decidedBy, decisionReason, tenantId, approvalId],
  );
}

export interface InsertAuditInput {
  tenantId: string;
  propertyId?: string | null;
  actorType: 'USER' | 'SERVICE';
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  beforeSafe?: Record<string, unknown> | null;
  afterSafe?: Record<string, unknown> | null;
  reason?: string | null;
  correlationId: string | null;
}

export async function insertAudit(
  em: EntityManager,
  input: InsertAuditInput,
): Promise<AuditEventRow> {
  const row = await one<AuditEventRow>(
    em,
    `insert into "audit_event"
       ("id", "tenant_id", "property_id", "actor_type", "actor_id",
        "actor_label", "action", "resource_type", "resource_id", "outcome",
        "before_safe", "after_safe", "reason", "correlation_id")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId ?? null,
      input.actorType,
      input.actorId,
      input.actorLabel,
      input.action,
      input.resourceType,
      input.resourceId,
      input.outcome,
      toJson(input.beforeSafe ?? {}),
      toJson(input.afterSafe ?? {}),
      input.reason ?? null,
      input.correlationId,
    ],
  );
  if (!row) throw new Error('Audit insert returned no row');
  return row;
}

export async function listAuditEvents(
  em: EntityManager,
  tenantId: string,
  options: {
    limit: number;
    beforeCreatedAt: string | null;
    beforeId: string | null;
  },
): Promise<AuditEventRow[]> {
  return rows<AuditEventRow>(
    em,
    `select * from "audit_event"
      where "tenant_id" = ?
        and (
          ?::timestamptz is null
          or ("created_at", "id") < (?::timestamptz, ?::uuid)
        )
      order by "created_at" desc, "id" desc
      limit ?`,
    [
      tenantId,
      options.beforeCreatedAt,
      options.beforeCreatedAt,
      options.beforeId,
      options.limit,
    ],
  );
}
