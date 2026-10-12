import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { IdentityError } from '../../identity/domain/errors.js';
import {
  assertPlatformIsoDate,
  assertMetric,
  assertReason,
  toNumber,
  utcToday,
} from '../domain/validation.js';
import {
  findPlatformEntitlement,
  findSubscriptionByTenant,
  insertPlatformEntitlement,
  insertEntitlementEvent,
  listEntitlementEvents,
  listEntitlements,
  listUsageCounters,
  upsertUsageCounter,
  updateEntitlement,
} from '../persistence/platform-repository.js';
import type {
  PlatformEntitlementEventRow,
  PlatformEntitlementRow,
  PlatformSubscriptionRow,
  PlatformUsageCounterRow,
} from '../persistence/types.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import {
  recordPlatformAudit,
  recordTenantAuditAsPlatform,
} from './audit-service.js';
import { sanitizeLimits } from './plan-service.js';

export interface EntitlementView {
  capability_code: string;
  state: string;
  active: boolean;
  limits: Record<string, number>;
  source: string;
  version: number;
  expires_at: string | null;
}

export interface UsageCounterView {
  metric: string;
  period_key: string;
  used: number;
  limit_value: number;
}

export interface SubscriptionView {
  id: string;
  tenant_id: string;
  customer_label: string;
  plan_code: string;
  policy_version: number;
  state: string;
  version: number;
  started_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  reactivated_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  entitlements: EntitlementView[];
  usage: UsageCounterView[];
}

export function entitlementView(
  row: PlatformEntitlementRow,
  now = Date.now(),
): EntitlementView {
  const expired = row.expires_at !== null && Date.parse(row.expires_at) <= now;
  return {
    capability_code: row.capability_code,
    state: row.state,
    active: row.state === 'ENABLED' && !expired,
    limits: row.limits ?? {},
    source: row.source,
    version: row.version,
    expires_at: row.expires_at,
  };
}

export function usageCounterView(
  row: PlatformUsageCounterRow,
): UsageCounterView {
  return {
    metric: row.metric,
    period_key: row.period_key,
    used: toNumber(row.used),
    limit_value: toNumber(row.limit_value),
  };
}

export async function loadSubscriptionView(
  em: EntityManager,
  subscription: PlatformSubscriptionRow,
): Promise<SubscriptionView> {
  const [entitlements, usage] = await Promise.all([
    listEntitlements(em, subscription.tenant_id),
    listUsageCounters(em, subscription.tenant_id),
  ]);
  return {
    id: subscription.id,
    tenant_id: subscription.tenant_id,
    customer_label: subscription.customer_label,
    plan_code: subscription.plan_code,
    policy_version: subscription.policy_version,
    state: subscription.state,
    version: subscription.version,
    started_at: subscription.started_at,
    suspended_at: subscription.suspended_at,
    suspension_reason: subscription.suspension_reason,
    reactivated_at: subscription.reactivated_at,
    closed_at: subscription.closed_at,
    close_reason: subscription.close_reason,
    entitlements: entitlements.map((row) => entitlementView(row)),
    usage: usage.map((row) => usageCounterView(row)),
  };
}

export async function readPlatformSubscription(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<SubscriptionView & { lifecycle: PlatformEntitlementEventRow[] }> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      const view = await loadSubscriptionView(em, subscription);
      const lifecycle = await listEntitlementEvents(em, tenantId, 50);
      return { ...view, lifecycle };
    },
  );
}

export async function getTenantSubscription(
  orm: MikroORM,
  context: ServiceContext,
  tenantId: string,
): Promise<SubscriptionView> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'subscription.read', null);
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      return loadSubscriptionView(em, subscription);
    },
  );
}

export async function setPlatformEntitlement(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: {
    capability_code: unknown;
    state: unknown;
    limits?: Record<string, unknown>;
    expires_at?: unknown;
    effective_from?: unknown;
    reason?: unknown;
  },
): Promise<EntitlementView> {
  const capabilityCode = assertMetric(input.capability_code, 'capability_code');
  if (input.state !== 'ENABLED' && input.state !== 'DISABLED')
    throw new IdentityError('INVALID_REQUEST', { field: 'state' });
  const state = input.state;
  const limits = sanitizeLimits(input.limits);
  const effectiveFrom =
    input.effective_from === undefined
      ? utcToday()
      : assertPlatformIsoDate(input.effective_from, 'effective_from');
  if (effectiveFrom < utcToday())
    throw new IdentityError('POLICY_BACKDATED', {
      effective_from: effectiveFrom,
    });
  const expiresAt =
    input.expires_at === undefined || input.expires_at === null
      ? null
      : typeof input.expires_at === 'string' &&
          !Number.isNaN(Date.parse(input.expires_at))
        ? new Date(input.expires_at).toISOString()
        : (() => {
            throw new IdentityError('INVALID_REQUEST', {
              field: 'expires_at',
            });
          })();
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now())
    throw new IdentityError('INVALID_REQUEST', { field: 'expires_at' });
  const reason =
    input.reason === undefined || input.reason === null
      ? null
      : assertReason(input.reason);
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
      const existing = await findPlatformEntitlement(
        em,
        tenantId,
        capabilityCode,
      );
      let row: PlatformEntitlementRow;
      if (existing) {
        const updated = await updateEntitlement(em, {
          id: existing.id,
          expectedVersion: existing.version,
          state,
          limits: Object.keys(limits).length > 0 ? limits : existing.limits,
          source: 'OVERRIDE',
          expiresAt,
          createdBy: context.actor.userId,
        });
        if (!updated)
          throw new IdentityError('STALE_VERSION', {
            expected: existing.version,
          });
        row = updated;
        await insertEntitlementEvent(em, {
          tenantId,
          entitlementId: row.id,
          capabilityCode,
          state: row.state,
          limits: row.limits ?? {},
          source: row.source,
          effectiveFrom,
          reason,
          actorUserId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        });
      } else {
        const inserted = await insertPlatformEntitlement(em, {
          tenantId,
          subscriptionId: subscription.id,
          capabilityCode,
          state,
          limits,
          source: 'OVERRIDE',
          expiresAt,
          createdBy: context.actor.userId,
        });
        if (!inserted)
          throw new IdentityError('CONFLICT', {
            reason: 'entitlement_concurrent_write',
          });
        row = inserted;
        await insertEntitlementEvent(em, {
          tenantId,
          entitlementId: row.id,
          capabilityCode,
          state: row.state,
          limits: row.limits ?? {},
          source: row.source,
          effectiveFrom,
          reason,
          actorUserId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        });
      }
      for (const [metric, limitValue] of Object.entries(limits))
        await upsertUsageCounter(em, { tenantId, metric, limitValue });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: 'platform.entitlement_set',
        resourceType: 'PlatformEntitlement',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          capability_code: capabilityCode,
          state,
          limits,
          expires_at: expiresAt,
          effective_from: effectiveFrom,
        },
        reason,
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: 'platform.entitlement_set',
        resourceType: 'PlatformEntitlement',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: { capability_code: capabilityCode, state, limits },
        reason,
      });
      return entitlementView(row);
    },
  );
}

export async function listPlatformEntitlementEvents(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<PlatformEntitlementEventRow[]> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    (em) => listEntitlementEvents(em, tenantId, 100),
  );
}
