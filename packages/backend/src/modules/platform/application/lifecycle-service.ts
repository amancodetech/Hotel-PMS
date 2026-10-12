import { createHash, randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { setPlatformContext } from '../../../persistence/platform-context.js';
import { one } from '../../../persistence/sql.js';
import { systemRoles } from '../../identity/domain/permissions.js';
import { IdentityError } from '../../identity/domain/errors.js';
import {
  findRoleByCode,
  insertGrant,
  insertMembership,
  insertRole,
} from '../../identity/persistence/org-repository.js';
import {
  assertIdempotencyKey,
  assertLabel,
  assertPlanCode,
  assertReason,
  utcToday,
} from '../domain/validation.js';
import {
  callLifecycleSnapshot,
  callPlatformCreateTenant,
  callResumeTenantSales,
  callSetTenantStatus,
  callStopTenantSales,
  findEffectivePolicyVersion,
  findLatestPolicyVersion,
  findLifecycleEventByKey,
  findOnboardingRequest,
  findPlanByCode,
  findSubscriptionBySlug,
  findSubscriptionByTenant,
  findSubscriptionForUpdate,
  insertEntitlementEvent,
  insertLifecycleEvent,
  insertOnboardingRequest,
  insertPlatformEntitlement,
  insertSubscription,
  listLifecycleEvents,
  updateSubscriptionState,
  upsertUsageCounter,
} from '../persistence/platform-repository.js';
import type {
  PlatformLifecycleEventRow,
  PlatformSubscriptionRow,
} from '../persistence/types.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import {
  recordPlatformAudit,
  recordTenantAuditAsPlatform,
} from './audit-service.js';
import {
  loadSubscriptionView,
  type SubscriptionView,
} from './subscription-service.js';

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const postgresUniqueViolation = '23505';

export interface LifecycleEventView {
  event_type: string;
  state_before: string | null;
  state_after: string;
  reason: string | null;
  created_at: string;
}

export function lifecycleEventView(
  row: PlatformLifecycleEventRow,
): LifecycleEventView {
  return {
    event_type: row.event_type,
    state_before: row.state_before,
    state_after: row.state_after,
    reason: row.reason,
    created_at: row.created_at,
  };
}

function parseIfMatch(value: unknown): number {
  if (typeof value !== 'string')
    throw new IdentityError('INVALID_REQUEST', { field: 'If-Match' });
  const match = /^"?(\d+)"?$/.exec(value.trim());
  if (!match) throw new IdentityError('INVALID_REQUEST', { field: 'If-Match' });
  return Number(match[1]);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === postgresUniqueViolation
  );
}

function uniqueViolationConstraint(error: unknown): string | null {
  const read = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const constraint = (value as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : null;
  };
  return (
    read(error) ??
    read((error as { cause?: unknown } | null)?.cause ?? null) ??
    null
  );
}

const onboardingRequestKeyConstraint = 'platform_onboarding_request_key_unique';

function onboardingFingerprint(input: {
  name: string;
  slug: string;
  customerLabel: string;
  planCode: string;
  ownerEmail: string | null;
  reason: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.name,
        input.slug,
        input.customerLabel,
        input.planCode,
        input.ownerEmail,
        input.reason,
      ]),
    )
    .digest('hex');
}

async function readOnboardingRequest(
  orm: MikroORM,
  context: PlatformServiceContext,
  idempotencyKey: string,
) {
  return runScopedTransaction(
    orm,
    { tenantId: '', userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      return findOnboardingRequest(em, idempotencyKey);
    },
  );
}

function replayPayload(
  event: PlatformLifecycleEventRow,
  replayed: boolean,
): Record<string, unknown> {
  const response = (event.snapshot as { response?: Record<string, unknown> })
    .response;
  return { ...(response ?? {}), replayed };
}

async function replayIfPresent(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      const event = await findLifecycleEventByKey(em, tenantId, idempotencyKey);
      return event ? replayPayload(event, true) : null;
    },
  );
}

export interface OnboardInput {
  name: unknown;
  slug: unknown;
  customer_label: unknown;
  plan_code: unknown;
  owner_email?: unknown;
  reason?: unknown;
}

export async function onboardPlatformTenant(
  orm: MikroORM,
  context: PlatformServiceContext,
  input: OnboardInput,
  rawIdempotencyKey: unknown,
): Promise<Record<string, unknown>> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  const name = assertLabel(input.name, 'name');
  if (typeof input.slug !== 'string' || !slugPattern.test(input.slug))
    throw new IdentityError('INVALID_REQUEST', { field: 'slug' });
  const slug = input.slug;
  const customerLabel = assertLabel(input.customer_label, 'customer_label');
  const planCode = assertPlanCode(input.plan_code, 'plan_code');
  const ownerEmail =
    input.owner_email === undefined || input.owner_email === null
      ? null
      : assertLabel(input.owner_email, 'owner_email', 320).toLowerCase();
  const reason =
    input.reason === undefined || input.reason === null
      ? 'platform onboarding'
      : assertReason(input.reason);
  authorizePlatform(context.actor, 'subscription.manage');

  const fingerprint = onboardingFingerprint({
    name,
    slug,
    customerLabel,
    planCode,
    ownerEmail,
    reason,
  });
  const recorded = await readOnboardingRequest(orm, context, idempotencyKey);
  if (recorded) {
    if (recorded.fingerprint !== fingerprint)
      throw new IdentityError('IDEMPOTENCY_CONFLICT', {
        field: 'idempotency_key',
      });
    return {
      ...(recorded.response as Record<string, unknown>),
      replayed: true,
    };
  }

  const existing = await runScopedTransaction(
    orm,
    { tenantId: '', userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      return findSubscriptionBySlug(em, slug);
    },
  );
  if (existing) {
    const replay = await replayIfPresent(
      orm,
      context,
      existing.tenant_id,
      idempotencyKey,
    );
    if (replay) return replay;
    throw new IdentityError('CONFLICT', { reason: 'tenant_slug_exists' });
  }

  const tenantId = randomUUID();
  try {
    return await runScopedTransaction(
      orm,
      { tenantId, userId: context.actor.userId },
      async (em) => {
        await setPlatformContext(em, { platformUserId: context.actor.userId });
        const plan = await findPlanByCode(em, planCode);
        if (!plan) throw new IdentityError('NOT_FOUND', { field: 'plan_code' });
        if (plan.status !== 'ACTIVE')
          throw new IdentityError('CONFLICT', { reason: 'plan_not_active' });
        const policy =
          (await findEffectivePolicyVersion(em, plan.id, utcToday())) ??
          (await findLatestPolicyVersion(em, plan.id));
        if (!policy)
          throw new IdentityError('CONFLICT', {
            reason: 'plan_policy_missing',
          });

        await callPlatformCreateTenant(em, {
          id: tenantId,
          name,
          slug,
          actorUserId: context.actor.userId,
        });
        for (const role of systemRoles)
          await insertRole(em, {
            tenantId,
            code: role.code,
            name: role.nameKey,
            description: role.descriptionKey,
            isSystem: true,
            permissions: [...role.permissions],
          });

        let ownerUserId: string | null = null;
        if (ownerEmail) {
          const owner = await one<{ id: string }>(
            em,
            `select "id" from "app_user"
              where lower("email") = lower(?) and "status" = 'ACTIVE' limit 1`,
            [ownerEmail],
          );
          if (!owner)
            throw new IdentityError('INVALID_REQUEST', {
              field: 'owner_email',
              reason: 'owner_not_found',
            });
          const membership = await insertMembership(em, {
            tenantId,
            userId: owner.id,
            status: 'ACTIVE',
          });
          const ownerRole = await findRoleByCode(em, tenantId, 'TENANT_OWNER');
          if (!ownerRole) throw new IdentityError('ROLE_NOT_FOUND');
          await insertGrant(em, {
            tenantId,
            membershipId: membership.id,
            roleId: ownerRole.id,
            effect: 'GRANT',
            scopeType: 'TENANT',
            propertyRefs: [],
            grantedBy: context.actor.userId,
            reason: 'platform onboarding',
          });
          ownerUserId = owner.id;
        }

        const subscription = await insertSubscription(em, {
          tenantId,
          customerLabel,
          planId: plan.id,
          policyVersionId: policy.id,
          planCode: plan.code,
          policyVersion: policy.version,
          policySnapshot: {
            limits: policy.limits ?? {},
            entitlements: policy.entitlements ?? {},
          },
          state: 'ACTIVE',
          startedAt: new Date().toISOString(),
          createdBy: context.actor.userId,
          tenantSlug: slug,
        });

        for (const [capabilityCode, enabled] of Object.entries(
          policy.entitlements ?? {},
        )) {
          const entitlement = await insertPlatformEntitlement(em, {
            tenantId,
            subscriptionId: subscription.id,
            capabilityCode,
            state: enabled ? 'ENABLED' : 'DISABLED',
            limits: {},
            source: 'PLAN',
            expiresAt: null,
            createdBy: context.actor.userId,
          });
          if (!entitlement) throw new IdentityError('CONFLICT');
          await insertEntitlementEvent(em, {
            tenantId,
            entitlementId: entitlement.id,
            capabilityCode,
            state: entitlement.state,
            limits: {},
            source: 'PLAN',
            effectiveFrom: utcToday(),
            reason,
            actorUserId: context.actor.userId,
            actorLabel: context.actor.displayName,
            correlationId: context.correlationId,
          });
        }
        for (const [metric, limitValue] of Object.entries(policy.limits ?? {}))
          await upsertUsageCounter(em, { tenantId, metric, limitValue });

        const snapshot = await callLifecycleSnapshot(
          em,
          tenantId,
          context.actor.userId,
        );
        const view = await loadSubscriptionView(em, subscription);
        const payload = {
          ...view,
          owner_user_id: ownerUserId,
          safety: {
            snapshot,
            writer: 'PMS',
            sales_stops_applied: 0,
            channel_state: 'UNCHANGED',
          },
          replayed: false,
        };
        const event = await insertLifecycleEvent(em, {
          tenantId,
          subscriptionId: subscription.id,
          eventType: 'ONBOARDED',
          stateBefore: null,
          stateAfter: 'ACTIVE',
          reason,
          idempotencyKey,
          snapshot: { ...payload, response: payload },
          actorUserId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        });
        await insertOnboardingRequest(em, {
          tenantId,
          idempotencyKey,
          fingerprint,
          response: payload,
          actorUserId: context.actor.userId,
        });
        await recordPlatformAudit(em, context, {
          tenantId,
          action: 'platform.tenant_onboarded',
          resourceType: 'PlatformSubscription',
          resourceId: subscription.id,
          outcome: 'SUCCESS',
          afterSafe: {
            tenant_slug: slug,
            plan_code: plan.code,
            policy_version: policy.version,
          },
          reason,
        });
        await recordTenantAuditAsPlatform(em, context, {
          tenantId,
          action: 'platform.tenant_onboarded',
          resourceType: 'PlatformSubscription',
          resourceId: subscription.id,
          outcome: 'SUCCESS',
          afterSafe: { plan_code: plan.code, policy_version: policy.version },
          reason,
        });
        return { ...payload, event: lifecycleEventView(event) };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (uniqueViolationConstraint(error) === onboardingRequestKeyConstraint) {
        const winner = await readOnboardingRequest(
          orm,
          context,
          idempotencyKey,
        );
        if (winner) {
          if (winner.fingerprint !== fingerprint)
            throw new IdentityError('IDEMPOTENCY_CONFLICT', {
              field: 'idempotency_key',
            });
          return {
            ...(winner.response as Record<string, unknown>),
            replayed: true,
          };
        }
      }
      const winner = await runScopedTransaction(
        orm,
        { tenantId: '', userId: context.actor.userId },
        async (em) => {
          await setPlatformContext(em, {
            platformUserId: context.actor.userId,
          });
          return findSubscriptionBySlug(em, slug);
        },
      );
      if (winner) {
        const replay = await replayIfPresent(
          orm,
          context,
          winner.tenant_id,
          idempotencyKey,
        );
        if (replay) return replay;
      }
      throw new IdentityError('CONFLICT', { reason: 'tenant_slug_exists' });
    }
    throw error;
  }
}

const transitionAudits = {
  SUSPENDED: 'platform.tenant_suspended',
  ACTIVE: 'platform.tenant_reactivated',
  CLOSED: 'platform.tenant_closed',
} as const;

async function buildTransitionPayload(
  em: Parameters<typeof loadSubscriptionView>[0],
  subscription: PlatformSubscriptionRow,
  context: PlatformServiceContext,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const view = await loadSubscriptionView(em, subscription);
  const snapshot = await callLifecycleSnapshot(
    em,
    subscription.tenant_id,
    context.actor.userId,
  );
  return {
    ...view,
    safety: {
      snapshot,
      writer: 'PMS',
      channel_state: 'UNCHANGED',
      ...extra,
    },
    replayed: false,
  };
}

export async function suspendPlatformTenant(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: { reason: unknown; resume_sales?: unknown },
  rawIdempotencyKey: unknown,
  rawIfMatch: unknown,
): Promise<Record<string, unknown>> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  const expectedVersion = parseIfMatch(rawIfMatch);
  const reason = assertReason(input.reason);
  authorizePlatform(context.actor, 'subscription.manage');
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      const replay = await findLifecycleEventByKey(
        em,
        tenantId,
        idempotencyKey,
      );
      if (replay) return replayPayload(replay, true);
      const subscription = await findSubscriptionForUpdate(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      if (subscription.state !== 'ACTIVE')
        throw new IdentityError('TENANT_STATE_CONFLICT', {
          state: subscription.state,
        });
      if (subscription.version !== expectedVersion)
        throw new IdentityError('STALE_VERSION', {
          expected: expectedVersion,
          current: subscription.version,
        });
      const salesStops = await callStopTenantSales(
        em,
        tenantId,
        context.actor.userId,
        reason,
      );
      const before = await callSetTenantStatus(
        em,
        tenantId,
        'SUSPENDED',
        context.actor.userId,
      );
      const updated = await updateSubscriptionState(em, {
        id: subscription.id,
        expectedVersion,
        state: 'SUSPENDED',
        suspendedAt: new Date().toISOString(),
        suspensionReason: reason,
      });
      if (!updated) throw new IdentityError('STALE_VERSION');
      const payload = await buildTransitionPayload(em, updated, context, {
        sales_stops_applied: salesStops,
        state_before: before,
      });
      const event = await insertLifecycleEvent(em, {
        tenantId,
        subscriptionId: updated.id,
        eventType: 'SUSPENDED',
        stateBefore: before,
        stateAfter: 'SUSPENDED',
        reason,
        idempotencyKey,
        snapshot: { ...payload, response: payload },
        actorUserId: context.actor.userId,
        actorLabel: context.actor.displayName,
        correlationId: context.correlationId,
      });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: transitionAudits.SUSPENDED,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: before, version: expectedVersion },
        afterSafe: { state: 'SUSPENDED', sales_stops_applied: salesStops },
        reason,
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: transitionAudits.SUSPENDED,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        afterSafe: { state: 'SUSPENDED', sales_stops_applied: salesStops },
        reason,
      });
      return { ...payload, event: lifecycleEventView(event) };
    },
  );
}

export async function reactivatePlatformTenant(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: {
    reason: unknown;
    acknowledge_policy_version?: unknown;
    resume_sales?: unknown;
  },
  rawIdempotencyKey: unknown,
  rawIfMatch: unknown,
): Promise<Record<string, unknown>> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  const expectedVersion = parseIfMatch(rawIfMatch);
  const reason = assertReason(input.reason);
  authorizePlatform(context.actor, 'subscription.manage');
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      const replay = await findLifecycleEventByKey(
        em,
        tenantId,
        idempotencyKey,
      );
      if (replay) return replayPayload(replay, true);
      const subscription = await findSubscriptionForUpdate(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      if (subscription.state !== 'SUSPENDED')
        throw new IdentityError('TENANT_STATE_CONFLICT', {
          state: subscription.state,
        });
      if (subscription.version !== expectedVersion)
        throw new IdentityError('STALE_VERSION', {
          expected: expectedVersion,
          current: subscription.version,
        });
      const plan = await findPlanByCode(em, subscription.plan_code);
      if (!plan) throw new IdentityError('NOT_FOUND', { field: 'plan_code' });
      const current = await findEffectivePolicyVersion(em, plan.id, utcToday());
      let repinned:
        | { id: string; version: number; snapshot: Record<string, unknown> }
        | undefined;
      if (current && current.version !== subscription.policy_version) {
        if (input.acknowledge_policy_version !== true)
          throw new IdentityError('POLICY_VERSION_STALE', {
            pinned: subscription.policy_version,
            current: current.version,
          });
        repinned = {
          id: current.id,
          version: current.version,
          snapshot: {
            limits: current.limits ?? {},
            entitlements: current.entitlements ?? {},
          },
        };
      }
      let resumed = 0;
      if (input.resume_sales === true)
        resumed = await callResumeTenantSales(
          em,
          tenantId,
          context.actor.userId,
        );
      const before = await callSetTenantStatus(
        em,
        tenantId,
        'ACTIVE',
        context.actor.userId,
      );
      const updated = await updateSubscriptionState(em, {
        id: subscription.id,
        expectedVersion,
        state: 'ACTIVE',
        reactivatedAt: new Date().toISOString(),
        ...(repinned
          ? {
              policyVersionId: repinned.id,
              policyVersion: repinned.version,
              policySnapshot: repinned.snapshot,
            }
          : {}),
      });
      if (!updated) throw new IdentityError('STALE_VERSION');
      const payload = await buildTransitionPayload(em, updated, context, {
        sales_restrictions_reopened: resumed,
        state_before: before,
      });
      const view = payload as unknown as SubscriptionView;
      const expiredEntitlements = view.entitlements
        .filter((entry) => entry.expires_at !== null && !entry.active)
        .map((entry) => entry.capability_code);
      payload.expired_entitlements = expiredEntitlements;
      if (repinned) payload.repinned_policy_version = repinned.version;
      const event = await insertLifecycleEvent(em, {
        tenantId,
        subscriptionId: updated.id,
        eventType: 'REACTIVATED',
        stateBefore: before,
        stateAfter: 'ACTIVE',
        reason,
        idempotencyKey,
        snapshot: { ...payload, response: payload },
        actorUserId: context.actor.userId,
        actorLabel: context.actor.displayName,
        correlationId: context.correlationId,
      });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: transitionAudits.ACTIVE,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: before, version: expectedVersion },
        afterSafe: {
          state: 'ACTIVE',
          repinned_policy_version: repinned?.version ?? null,
          sales_restrictions_reopened: resumed,
        },
        reason,
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: transitionAudits.ACTIVE,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        afterSafe: { state: 'ACTIVE' },
        reason,
      });
      return { ...payload, event: lifecycleEventView(event) };
    },
  );
}

export async function closePlatformTenant(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  input: { reason: unknown },
  rawIdempotencyKey: unknown,
  rawIfMatch: unknown,
): Promise<Record<string, unknown>> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  const expectedVersion = parseIfMatch(rawIfMatch);
  const reason = assertReason(input.reason);
  authorizePlatform(context.actor, 'subscription.manage');
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      const replay = await findLifecycleEventByKey(
        em,
        tenantId,
        idempotencyKey,
      );
      if (replay) return replayPayload(replay, true);
      const subscription = await findSubscriptionForUpdate(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      if (subscription.state !== 'ACTIVE' && subscription.state !== 'SUSPENDED')
        throw new IdentityError('TENANT_STATE_CONFLICT', {
          state: subscription.state,
        });
      if (subscription.version !== expectedVersion)
        throw new IdentityError('STALE_VERSION', {
          expected: expectedVersion,
          current: subscription.version,
        });
      const before = await callSetTenantStatus(
        em,
        tenantId,
        'CLOSED',
        context.actor.userId,
      );
      const updated = await updateSubscriptionState(em, {
        id: subscription.id,
        expectedVersion,
        state: 'CLOSED',
        closedAt: new Date().toISOString(),
        closeReason: reason,
      });
      if (!updated) throw new IdentityError('STALE_VERSION');
      const payload = await buildTransitionPayload(em, updated, context, {
        state_before: before,
        deletions: 0,
      });
      const event = await insertLifecycleEvent(em, {
        tenantId,
        subscriptionId: updated.id,
        eventType: 'CLOSED',
        stateBefore: before,
        stateAfter: 'CLOSED',
        reason,
        idempotencyKey,
        snapshot: { ...payload, response: payload },
        actorUserId: context.actor.userId,
        actorLabel: context.actor.displayName,
        correlationId: context.correlationId,
      });
      await recordPlatformAudit(em, context, {
        tenantId,
        action: transitionAudits.CLOSED,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: before, version: expectedVersion },
        afterSafe: { state: 'CLOSED', deletions: 0 },
        reason,
      });
      await recordTenantAuditAsPlatform(em, context, {
        tenantId,
        action: transitionAudits.CLOSED,
        resourceType: 'PlatformSubscription',
        resourceId: updated.id,
        outcome: 'SUCCESS',
        afterSafe: { state: 'CLOSED', deletions: 0 },
        reason,
      });
      return { ...payload, event: lifecycleEventView(event) };
    },
  );
}

export async function listPlatformTenantLifecycle(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<LifecycleEventView[]> {
  authorizePlatform(context.actor, 'platform.read');
  const rows = await runScopedTransaction(
    orm,
    { tenantId: '', userId: context.actor.userId },
    async (em) => {
      await setPlatformContext(em, { platformUserId: context.actor.userId });
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      return listLifecycleEvents(em, tenantId, 100);
    },
  );
  return rows.map((row) => lifecycleEventView(row));
}
