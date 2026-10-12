import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { one } from '../../../persistence/sql.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { isSupportScope, type SupportScope } from '../domain/platform-roles.js';
import { assertIdempotencyKey, assertReason } from '../domain/validation.js';
import {
  findActiveSupportGrant,
  findLatestSupportGrant,
  findPlatformStaffByEmail,
  findSubscriptionByTenant,
  findSupportGrantById,
  findSupportGrantByKey,
  insertSupportGrant,
  listLifecycleEvents,
  listPlatformAudit,
  listSubscriptions,
  listSupportGrantViews,
  listUsageCounters,
  readTenantAuditViaSupportGrant,
  readTenantProfileViaSupportGrant,
  revokeSupportGrant,
} from '../persistence/platform-repository.js';
import type {
  PlatformAuditEventRow,
  PlatformSubscriptionRow,
  PlatformSupportGrantRow,
} from '../persistence/types.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import { recordPlatformAudit } from './audit-service.js';
import { loadSubscriptionView } from './subscription-service.js';

export interface SupportGrantView {
  id: string;
  tenant_id: string;
  platform_user_id: string;
  platform_user_email: string | null;
  scopes: SupportScope[];
  reason: string;
  granted_by_user_id: string;
  starts_at: string;
  expires_at: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
}

export function supportGrantView(
  row: PlatformSupportGrantRow & { platform_user_email?: string | null },
  now = Date.now(),
): SupportGrantView {
  const status =
    row.revoked_at !== null
      ? 'REVOKED'
      : Date.parse(row.expires_at) <= now
        ? 'EXPIRED'
        : 'ACTIVE';
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    platform_user_id: row.platform_user_id,
    platform_user_email: row.platform_user_email ?? null,
    scopes: (row.scopes ?? []).filter((scope): scope is SupportScope =>
      isSupportScope(scope),
    ),
    reason: row.reason,
    granted_by_user_id: row.granted_by_user_id,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    status,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    created_at: row.created_at,
  };
}

function assertScopes(value: unknown): SupportScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2)
    throw new IdentityError('INVALID_REQUEST', { field: 'scopes' });
  const scopes: SupportScope[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isSupportScope(entry))
      throw new IdentityError('INVALID_REQUEST', { field: 'scopes' });
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  return scopes;
}

async function resolveGrantee(
  em: EntityManager,
  input: { platform_user_email?: unknown },
): Promise<{ userId: string; roleCode: string }> {
  const email =
    typeof input.platform_user_email === 'string'
      ? input.platform_user_email.trim().toLowerCase()
      : null;
  if (!email)
    throw new IdentityError('INVALID_REQUEST', {
      field: 'platform_user_email',
    });
  const staff = await findPlatformStaffByEmail(em, email);
  if (!staff || staff.staff_status !== 'ACTIVE')
    throw new IdentityError('PLATFORM_STAFF_NOT_FOUND', { email });
  return { userId: staff.user_id, roleCode: staff.role_code };
}

export async function createPlatformSupportGrant(
  orm: MikroORM,
  context: PlatformServiceContext,
  input: {
    tenant_id: unknown;
    platform_user_email: unknown;
    scopes: unknown;
    reason: unknown;
    expires_at: unknown;
  },
  rawIdempotencyKey: unknown,
): Promise<SupportGrantView & { replayed: boolean }> {
  const idempotencyKey = assertIdempotencyKey(rawIdempotencyKey);
  if (typeof input.tenant_id !== 'string')
    throw new IdentityError('INVALID_REQUEST', { field: 'tenant_id' });
  const tenantId = input.tenant_id;
  const scopes = assertScopes(input.scopes);
  const reason = assertReason(input.reason);
  const expiresAt =
    typeof input.expires_at === 'string' &&
    !Number.isNaN(Date.parse(input.expires_at))
      ? new Date(input.expires_at).toISOString()
      : (() => {
          throw new IdentityError('INVALID_REQUEST', { field: 'expires_at' });
        })();
  if (Date.parse(expiresAt) <= Date.now())
    throw new IdentityError('INVALID_REQUEST', {
      field: 'expires_at',
      reason: 'expiry_in_past',
    });
  authorizePlatform(context.actor, 'platform.support.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscription = await findSubscriptionByTenant(em, tenantId);
      if (!subscription) throw new IdentityError('NOT_FOUND');
      const replay = await findSupportGrantByKey(em, tenantId, idempotencyKey);
      if (replay) return { ...supportGrantView(replay), replayed: true };
      const grantee = await resolveGrantee(em, {
        platform_user_email: input.platform_user_email,
      });
      if (grantee.userId === context.actor.userId)
        throw new IdentityError('SUPPORT_SELF_GRANT_DENIED');
      const grant = await insertSupportGrant(em, {
        tenantId,
        platformUserId: grantee.userId,
        scopes,
        reason,
        grantedByUserId: context.actor.userId,
        expiresAt,
        idempotencyKey,
        correlationId: context.correlationId,
      });
      if (!grant) throw new IdentityError('CONFLICT');
      await recordPlatformAudit(em, context, {
        tenantId,
        action: 'platform.support_granted',
        resourceType: 'PlatformSupportGrant',
        resourceId: grant.id,
        outcome: 'SUCCESS',
        afterSafe: { scopes, expires_at: expiresAt },
        reason,
      });
      return { ...supportGrantView(grant), replayed: false };
    },
  );
}

export async function revokePlatformSupportGrant(
  orm: MikroORM,
  context: PlatformServiceContext,
  grantId: string,
  input: { reason: unknown },
): Promise<SupportGrantView> {
  const reason = assertReason(input.reason);
  authorizePlatform(context.actor, 'platform.support.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const existing = await findSupportGrantById(em, grantId);
      if (!existing) throw new IdentityError('NOT_FOUND');
      const revoked = await revokeSupportGrant(em, {
        grantId,
        revokedBy: context.actor.userId,
        reason,
      });
      if (!revoked)
        throw new IdentityError('GRANT_ALREADY_REVOKED', { grantId });
      await recordPlatformAudit(em, context, {
        tenantId: revoked.tenant_id,
        action: 'platform.support_revoked',
        resourceType: 'PlatformSupportGrant',
        resourceId: revoked.id,
        outcome: 'SUCCESS',
        beforeSafe: { revoked_at: null },
        afterSafe: { revoked_at: revoked.revoked_at },
        reason,
      });
      return supportGrantView(revoked);
    },
  );
}

export async function listPlatformSupportGrants(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string | null,
): Promise<SupportGrantView[]> {
  authorizePlatform(context.actor, 'platform.read');
  const rows = await runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    (em) => listSupportGrantViews(em, { tenantId, limit: 100 }),
  );
  return rows.map((row) => supportGrantView(row));
}

async function requireGrantScope(
  em: EntityManager,
  context: PlatformServiceContext,
  tenantId: string,
  scope: SupportScope,
): Promise<string> {
  const active = await findActiveSupportGrant(
    em,
    tenantId,
    context.actor.userId,
  );
  if (active) {
    if (!(active.scopes ?? []).includes(scope))
      throw new IdentityError('SUPPORT_GRANT_SCOPE_DENIED', { scope });
    return active.id;
  }
  const latest = await findLatestSupportGrant(
    em,
    tenantId,
    context.actor.userId,
  );
  if (latest) {
    if (latest.revoked_at !== null)
      throw new IdentityError('SUPPORT_GRANT_REQUIRED', {
        reason: 'revoked',
        grant_id: latest.id,
      });
    throw new IdentityError('SUPPORT_GRANT_EXPIRED', { grant_id: latest.id });
  }
  throw new IdentityError('SUPPORT_GRANT_REQUIRED', { reason: 'missing' });
}

async function recordSupportAccess(
  em: EntityManager,
  context: PlatformServiceContext,
  tenantId: string,
  scope: SupportScope,
  grantId: string,
): Promise<void> {
  await recordPlatformAudit(em, context, {
    tenantId,
    action: 'platform.support_access',
    resourceType: 'PlatformSupportGrant',
    resourceId: grantId,
    outcome: 'SUCCESS',
    afterSafe: { scope },
  });
}

export async function readPlatformSupportTenantProfile(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
): Promise<Record<string, unknown> & { grant_id: string }> {
  authorizePlatform(context.actor, 'platform.support.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const grantId = await requireGrantScope(
        em,
        context,
        tenantId,
        'tenant.read',
      );
      const profile = await readTenantProfileViaSupportGrant(
        em,
        tenantId,
        context.actor.userId,
      );
      if (!profile) throw new IdentityError('NOT_FOUND');
      await recordSupportAccess(em, context, tenantId, 'tenant.read', grantId);
      return { scope: 'tenant.read', grant_id: grantId, tenant: profile };
    },
  );
}

export async function readPlatformSupportTenantAudit(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string,
  limit: number,
): Promise<Record<string, unknown> & { grant_id: string }> {
  authorizePlatform(context.actor, 'platform.support.read');
  const bounded =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const grantId = await requireGrantScope(
        em,
        context,
        tenantId,
        'audit.read',
      );
      const events = await readTenantAuditViaSupportGrant(
        em,
        tenantId,
        context.actor.userId,
        bounded,
      );
      await recordSupportAccess(em, context, tenantId, 'audit.read', grantId);
      return { scope: 'audit.read', grant_id: grantId, events };
    },
  );
}

export interface PlatformTenantDirectoryRow {
  tenant_id: string;
  tenant_slug: string;
  customer_label: string;
  plan_code: string;
  policy_version: number;
  state: string;
  version: number;
  entitlements: number;
  usage: Array<{ metric: string; used: number; limit_value: number }>;
  lifecycle_events: number;
}

export async function listPlatformTenants(
  orm: MikroORM,
  context: PlatformServiceContext,
): Promise<PlatformTenantDirectoryRow[]> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const subscriptions = await listSubscriptions(em, 100);
      const directory: PlatformTenantDirectoryRow[] = [];
      for (const subscription of subscriptions)
        directory.push(await directoryRow(em, subscription));
      return directory;
    },
  );
}

async function directoryRow(
  em: EntityManager,
  subscription: PlatformSubscriptionRow,
): Promise<PlatformTenantDirectoryRow> {
  const [counters, events] = await Promise.all([
    listUsageCounters(em, subscription.tenant_id),
    listLifecycleEvents(em, subscription.tenant_id, 100),
  ]);
  const view = await loadSubscriptionView(em, subscription);
  return {
    tenant_id: subscription.tenant_id,
    tenant_slug: subscription.tenant_slug,
    customer_label: subscription.customer_label,
    plan_code: subscription.plan_code,
    policy_version: subscription.policy_version,
    state: subscription.state,
    version: subscription.version,
    entitlements: view.entitlements.length,
    usage: counters.map((row) => ({
      metric: row.metric,
      used: Number(row.used),
      limit_value: Number(row.limit_value),
    })),
    lifecycle_events: events.length,
  };
}

export interface PlatformAuditView {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

function auditView(row: PlatformAuditEventRow): PlatformAuditView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    outcome: row.outcome,
    reason: row.reason,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
  };
}

export async function listPlatformAuditEvents(
  orm: MikroORM,
  context: PlatformServiceContext,
  tenantId: string | null,
  limit: number,
): Promise<PlatformAuditView[]> {
  authorizePlatform(context.actor, 'platform.read');
  const bounded =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
  const rows = await runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    (em) => listPlatformAudit(em, bounded, tenantId),
  );
  return rows.map((row) => auditView(row));
}

export async function requirePlatformStaffByEmail(
  em: EntityManager,
  email: string,
): Promise<{ userId: string; roleCode: string }> {
  const staff = await findPlatformStaffByEmail(em, email);
  if (!staff || staff.staff_status !== 'ACTIVE')
    throw new IdentityError('PLATFORM_STAFF_NOT_FOUND', { email });
  return { userId: staff.user_id, roleCode: staff.role_code };
}

export async function platformTenantExists(
  em: EntityManager,
  tenantId: string,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    em,
    `select "id" from "platform_subscription" where "tenant_id" = ?`,
    [tenantId],
  );
  return row !== null;
}
