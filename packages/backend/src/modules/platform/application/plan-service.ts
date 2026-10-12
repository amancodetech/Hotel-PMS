import type { MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { IdentityError } from '../../identity/domain/errors.js';
import {
  assertInteger,
  assertPlatformIsoDate,
  assertLabel,
  assertMetric,
  assertPlanCode,
  utcToday,
} from '../domain/validation.js';
import {
  findLatestPolicyVersion,
  findPlanByCode,
  insertPlan,
  insertPolicyVersion,
  listPlans,
  listPolicyVersions,
} from '../persistence/platform-repository.js';
import type {
  PlanPolicyVersionRow,
  PlatformPlanRow,
} from '../persistence/types.js';
import { authorizePlatform, type PlatformServiceContext } from './context.js';
import { recordPlatformAudit } from './audit-service.js';

export interface PlanView {
  code: string;
  name: string;
  status: string;
  policy_versions: number;
  created_at: string;
}

export interface PolicyVersionView {
  plan_code: string;
  version: number;
  effective_from: string;
  limits: Record<string, number>;
  entitlements: Record<string, boolean>;
  notes: string | null;
  created_at: string;
}

function planView(
  row: PlatformPlanRow & { policy_versions?: number },
): PlanView {
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    policy_versions: Number(row.policy_versions ?? 0),
    created_at: row.created_at,
  };
}

export function policyVersionView(
  planCode: string,
  row: PlanPolicyVersionRow,
): PolicyVersionView {
  return {
    plan_code: planCode,
    version: row.version,
    effective_from: String(row.effective_from).slice(0, 10),
    limits: row.limits ?? {},
    entitlements: row.entitlements ?? {},
    notes: row.notes,
    created_at: row.created_at,
  };
}

export function sanitizeLimits(
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    assertMetric(key, `limits.${key}`);
    limits[key] = assertInteger(entry, `limits.${key}`, 0, 1_000_000);
  }
  return limits;
}

export function sanitizeEntitlements(
  value: Record<string, unknown> | undefined,
): Record<string, boolean> {
  const entitlements: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    assertMetric(key, `entitlements.${key}`);
    if (typeof entry !== 'boolean')
      throw new IdentityError('INVALID_REQUEST', {
        field: `entitlements.${key}`,
      });
    entitlements[key] = entry;
  }
  return entitlements;
}

export async function createPlatformPlan(
  orm: MikroORM,
  context: PlatformServiceContext,
  input: { code: unknown; name: unknown },
): Promise<PlanView> {
  const code = assertPlanCode(input.code);
  const name = assertLabel(input.name, 'name');
  authorizePlatform(context.actor, 'subscription.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const existing = await findPlanByCode(em, code);
      if (existing)
        throw new IdentityError('CONFLICT', { reason: 'plan_code_exists' });
      const row = await insertPlan(em, {
        code,
        name,
        createdBy: context.actor.userId,
      });
      if (!row)
        throw new IdentityError('CONFLICT', { reason: 'plan_code_exists' });
      await recordPlatformAudit(em, context, {
        action: 'platform.plan_created',
        resourceType: 'PlatformPlan',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: { code, name, status: row.status },
      });
      return planView(row);
    },
  );
}

export async function listPlatformPlans(
  orm: MikroORM,
  context: PlatformServiceContext,
): Promise<PlanView[]> {
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const plans = await listPlans(em);
      return plans.map((row) => planView(row));
    },
  );
}

export async function listPlanPolicyVersions(
  orm: MikroORM,
  context: PlatformServiceContext,
  planCode: unknown,
): Promise<PolicyVersionView[]> {
  const code = assertPlanCode(planCode, 'plan_code');
  authorizePlatform(context.actor, 'platform.read');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const plan = await findPlanByCode(em, code);
      if (!plan) throw new IdentityError('NOT_FOUND', { field: 'plan_code' });
      const versions = await listPolicyVersions(em, plan.id);
      return versions.map((row) => policyVersionView(plan.code, row));
    },
  );
}

export async function createPlanPolicyVersion(
  orm: MikroORM,
  context: PlatformServiceContext,
  planCode: unknown,
  input: {
    effective_from: unknown;
    limits?: Record<string, unknown>;
    entitlements?: Record<string, unknown>;
    notes?: unknown;
  },
): Promise<PolicyVersionView> {
  const code = assertPlanCode(planCode, 'plan_code');
  const effectiveFrom = assertPlatformIsoDate(
    input.effective_from,
    'effective_from',
  );
  const limits = sanitizeLimits(input.limits);
  const entitlements = sanitizeEntitlements(input.entitlements);
  const notes =
    input.notes === undefined || input.notes === null
      ? null
      : assertLabel(input.notes, 'notes', 500);
  authorizePlatform(context.actor, 'subscription.manage');
  return runPlatformTransaction(
    orm,
    { platformUserId: context.actor.userId },
    async (em) => {
      const plan = await findPlanByCode(em, code);
      if (!plan) throw new IdentityError('NOT_FOUND', { field: 'plan_code' });
      if (plan.status !== 'ACTIVE')
        throw new IdentityError('CONFLICT', { reason: 'plan_not_active' });
      const latest = await findLatestPolicyVersion(em, plan.id);
      const today = utcToday();
      if (effectiveFrom < today)
        throw new IdentityError('POLICY_BACKDATED', {
          effective_from: effectiveFrom,
        });
      if (latest && effectiveFrom <= String(latest.effective_from).slice(0, 10))
        throw new IdentityError('POLICY_BACKDATED', {
          effective_from: effectiveFrom,
          latest_effective_from: String(latest.effective_from).slice(0, 10),
        });
      const version = (latest?.version ?? 0) + 1;
      const row = await insertPolicyVersion(em, {
        planId: plan.id,
        version,
        effectiveFrom,
        limits,
        entitlements,
        notes,
        createdBy: context.actor.userId,
      });
      await recordPlatformAudit(em, context, {
        action: 'platform.plan_policy_version_created',
        resourceType: 'PlatformPlanPolicyVersion',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: { plan_code: code, version, effective_from: effectiveFrom },
      });
      return policyVersionView(plan.code, row);
    },
  );
}
