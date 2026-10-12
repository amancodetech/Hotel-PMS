import type { EntityManager } from '@mikro-orm/postgresql';
import { safeAuditFields } from '../../identity/application/audit-service.js';
import {
  insertPlatformAudit,
  recordTenantAuditViaPlatform,
} from '../persistence/platform-repository.js';
import type { PlatformServiceContext } from './context.js';

export interface PlatformAuditInput {
  tenantId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  beforeSafe?: Record<string, unknown> | null;
  afterSafe?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Platform audit rides the same transaction as the platform state change and
 * never stores secrets or guest data. Tenant-affecting platform actions are
 * additionally written into the tenant audit trail through a security-definer
 * helper that re-validates the platform actor, so tenant auditors can see
 * subscription, entitlement and support changes without gaining platform data.
 */
export async function recordPlatformAudit(
  em: EntityManager,
  context: PlatformServiceContext,
  input: PlatformAuditInput,
): Promise<void> {
  await insertPlatformAudit(em, {
    tenantId: input.tenantId ?? null,
    actorUserId: context.actor.userId,
    actorRole: context.actor.roleCode,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    beforeSafe: safeAuditFields(input.beforeSafe),
    afterSafe: safeAuditFields(input.afterSafe),
    reason: input.reason?.slice(0, 500) ?? null,
    correlationId: context.correlationId,
  });
}

export async function recordTenantAuditAsPlatform(
  em: EntityManager,
  context: PlatformServiceContext,
  input: PlatformAuditInput & { tenantId: string },
): Promise<void> {
  await recordTenantAuditViaPlatform(em, {
    tenantId: input.tenantId,
    actorUserId: context.actor.userId,
    actorLabel: context.actor.displayName,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    beforeSafe: safeAuditFields(input.beforeSafe),
    afterSafe: safeAuditFields(input.afterSafe),
    reason: input.reason?.slice(0, 500) ?? null,
    correlationId: context.correlationId,
  });
}
