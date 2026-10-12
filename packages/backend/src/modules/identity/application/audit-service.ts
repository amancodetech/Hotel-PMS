import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  insertAudit,
  listAuditEvents,
} from '../persistence/governance-repository.js';
import type { AuditEventRow } from '../persistence/types.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { evaluatePolicy, policyError } from './policy-service.js';
import type { PolicyActor } from './policy-service.js';

const sensitiveKey = /pass|secret|token|cookie|authorization|pan|cvv|card/i;

export function safeAuditFields(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey.test(key)) continue;
    if (typeof entry === 'string' && entry.length > 300)
      safe[key] = `${entry.slice(0, 300)}...`;
    else safe[key] = entry;
  }
  return safe;
}

export interface AuditInput {
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

export async function recordAudit(
  em: EntityManager,
  input: AuditInput,
): Promise<void> {
  await insertAudit(em, {
    ...input,
    beforeSafe: safeAuditFields(input.beforeSafe),
    afterSafe: safeAuditFields(input.afterSafe),
    reason: input.reason ? input.reason.slice(0, 500) : null,
  });
}

export async function readAuditForTenant(
  orm: MikroORM,
  actor: PolicyActor,
  tenantId: string,
  options: { limit?: number; cursor?: string | null },
  propertyRef: string | null = null,
): Promise<AuditEventRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: actor.userId },
    async (em) => {
      const decision = await evaluatePolicy(em, {
        actor,
        tenantId,
        permission: 'audit.read',
        propertyRef,
      });
      if (!decision.allowed) throw policyError(decision);
      return readAuditEvents(em, tenantId, options);
    },
  );
}

export async function readAuditEvents(
  em: EntityManager,
  tenantId: string,
  options: { limit?: number; cursor?: string | null },
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let beforeCreatedAt: string | null = null;
  let beforeId: string | null = null;
  if (options.cursor) {
    const separator = options.cursor.lastIndexOf('|');
    if (separator > 0) {
      beforeCreatedAt = options.cursor.slice(0, separator);
      beforeId = options.cursor.slice(separator + 1);
    }
  }
  return listAuditEvents(em, tenantId, {
    limit,
    beforeCreatedAt,
    beforeId,
  });
}
