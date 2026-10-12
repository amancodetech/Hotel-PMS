import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { IdentityError } from '../../identity/domain/errors.js';
import {
  assertIdempotencyKey,
  assertInteger,
  assertMetric,
  toNumber,
} from '../domain/validation.js';
import {
  consumeUsage,
  findSubscriptionByTenant,
  findUsageCounter,
  findUsageEvent,
  insertUsageEvent,
  listUsageCounters,
} from '../persistence/platform-repository.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import {
  recordPlatformAudit,
  recordTenantAuditAsPlatform,
} from './audit-service.js';
import {
  usageCounterView,
  type UsageCounterView,
} from './subscription-service.js';

export interface RecordUsageResult {
  metric: string;
  quantity: number;
  used: number;
  limit_value: number;
  replayed: boolean;
}

/**
 * Idempotent usage metering. The usage event row is the metering ledger and is
 * unique per (tenant, metric, idempotency_key); the counter increment happens
 * in the same transaction through the security-definer limit guard, so two
 * concurrent requests can never push a declared limit above its ceiling.
 */
export async function recordPlatformUsage(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: { metric: unknown; quantity: unknown; idempotency_key: unknown },
): Promise<RecordUsageResult> {
  const metric = assertMetric(input.metric);
  const quantity = assertInteger(input.quantity, 'quantity', 1, 100_000);
  const idempotencyKey = assertIdempotencyKey(input.idempotency_key);
  authorizePlatform(context.actor, 'subscription.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      if (subscription.state === 'CLOSED')
        throw new IdentityError('TENANT_STATE_CONFLICT', {
          state: subscription.state,
        });
      const inserted = await insertUsageEvent(em, {
        tenantId,
        metric,
        quantity,
        idempotencyKey,
        correlationId: context.correlationId,
        recordedBy: context.actor.userId,
      });
      if (!inserted) {
        const existing = await findUsageEvent(
          em,
          tenantId,
          metric,
          idempotencyKey,
        );
        if (!existing) throw new IdentityError('CONFLICT');
        const counter = await findUsageCounter(em, tenantId, metric);
        return {
          metric,
          quantity: Number(existing.quantity),
          used: counter ? toNumber(counter.used) : 0,
          limit_value: counter ? toNumber(counter.limit_value) : 0,
          replayed: true,
        };
      }
      const consumed = await consumeUsage(em, {
        tenantId,
        metric,
        delta: quantity,
      });
      if (consumed.outcome === 'LIMIT_EXCEEDED')
        throw new IdentityError('LIMIT_EXCEEDED', {
          kind: 'EXCEEDED',
          metric,
          used: toNumber(consumed.used),
          limit_value: toNumber(consumed.limit_value),
        });
      if (consumed.outcome === 'NOT_CONFIGURED')
        throw new IdentityError('LIMIT_EXCEEDED', {
          kind: 'NOT_CONFIGURED',
          metric,
        });
      if (consumed.outcome !== 'OK')
        throw new IdentityError('INVALID_REQUEST', { field: 'quantity' });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: 'platform.usage_recorded',
        resourceType: 'PlatformUsageCounter',
        resourceId: inserted.id,
        outcome: 'SUCCESS',
        afterSafe: {
          metric,
          quantity,
          used: toNumber(consumed.used),
          limit_value: toNumber(consumed.limit_value),
        },
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: 'platform.usage_recorded',
        resourceType: 'PlatformUsageCounter',
        resourceId: inserted.id,
        outcome: 'SUCCESS',
        afterSafe: { metric, quantity, used: toNumber(consumed.used) },
      });
      return {
        metric,
        quantity,
        used: toNumber(consumed.used),
        limit_value: toNumber(consumed.limit_value),
        replayed: false,
      };
    },
  );
}

export async function listPlatformUsage(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<UsageCounterView[]> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      const counters = await listUsageCounters(em, tenantId);
      return counters.map((row) => usageCounterView(row));
    },
  );
}

/**
 * Atomic declared-limit guard for tenant-side operations. Runs inside the
 * caller transaction so the metered effect and the resource write commit or
 * roll back together; `NOT_CONFIGURED` means the tenant has no declared limit
 * for the metric (metering starts when a subscription policy defines one).
 */
export async function enforceUsageLimit(
  em: EntityManager,
  tenantId: string,
  metric: string,
  delta: number,
): Promise<void> {
  if (!Number.isInteger(delta) || delta <= 0)
    throw new IdentityError('INVALID_REQUEST', { field: 'delta' });
  const consumed = await consumeUsage(em, { tenantId, metric, delta });
  if (consumed.outcome === 'LIMIT_EXCEEDED')
    throw new IdentityError('LIMIT_EXCEEDED', {
      kind: 'EXCEEDED',
      metric,
      used: toNumber(consumed.used),
      limit_value: toNumber(consumed.limit_value),
    });
  if (consumed.outcome === 'NOT_CONFIGURED') return;
  if (consumed.outcome !== 'OK')
    throw new IdentityError('INVALID_REQUEST', { field: 'quantity' });
}
