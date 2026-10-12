import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type {
  PlanPolicyVersionRow,
  PlatformAuditEventRow,
  PlatformEntitlementEventRow,
  PlatformEntitlementRow,
  PlatformInvoiceLineRow,
  PlatformInvoiceRow,
  PlatformLifecycleEventRow,
  PlatformOnboardingRequestRow,
  PlatformPlanRow,
  PlatformStaffRow,
  PlatformSubscriptionRow,
  PlatformSupportGrantRow,
  PlatformUsageConsumeRow,
  PlatformUsageCounterRow,
  PlatformUsageEventRow,
} from './types.js';

export async function findPlatformStaffByUser(
  em: EntityManager,
  userId: string,
): Promise<PlatformStaffRow | null> {
  return one<PlatformStaffRow>(
    em,
    `select * from "platform_staff" where "user_id" = ?`,
    [userId],
  );
}

export async function upsertPlatformStaff(
  em: EntityManager,
  input: { userId: string; roleCode: string; status?: string },
): Promise<PlatformStaffRow> {
  const row = await one<PlatformStaffRow>(
    em,
    `insert into "platform_staff" ("user_id", "role_code", "status")
     values (?, ?, ?)
     on conflict ("user_id") do update
       set "role_code" = excluded."role_code",
           "status" = excluded."status",
           "updated_at" = now()
     returning *`,
    [input.userId, input.roleCode, input.status ?? 'ACTIVE'],
  );
  if (!row) throw new Error('platform_staff_upsert_failed');
  return row;
}

export async function insertPlan(
  em: EntityManager,
  input: { code: string; name: string; createdBy: string | null },
): Promise<PlatformPlanRow | null> {
  return one<PlatformPlanRow>(
    em,
    `insert into "platform_plan" ("code", "name", "created_by")
     values (?, ?, ?)
     on conflict ("code") do nothing
     returning *`,
    [input.code, input.name, input.createdBy],
  );
}

export async function findPlanByCode(
  em: EntityManager,
  code: string,
): Promise<PlatformPlanRow | null> {
  return one<PlatformPlanRow>(
    em,
    `select * from "platform_plan" where "code" = ?`,
    [code],
  );
}

export async function listPlans(em: EntityManager): Promise<PlatformPlanRow[]> {
  return rows<PlatformPlanRow>(
    em,
    `select p.*,
            (select count(*)::int from "platform_plan_policy_version" v
              where v."plan_id" = p."id") as "policy_versions"
       from "platform_plan" p
      order by p."code"`,
  );
}

export async function insertPolicyVersion(
  em: EntityManager,
  input: {
    planId: string;
    version: number;
    effectiveFrom: string;
    limits: Record<string, number>;
    entitlements: Record<string, boolean>;
    notes: string | null;
    createdBy: string | null;
  },
): Promise<PlanPolicyVersionRow> {
  const row = await one<PlanPolicyVersionRow>(
    em,
    `insert into "platform_plan_policy_version"
       ("plan_id", "version", "effective_from", "limits", "entitlements",
        "notes", "created_by")
     values (?, ?, ?::date, ?::jsonb, ?::jsonb, ?, ?)
     returning *`,
    [
      input.planId,
      input.version,
      input.effectiveFrom,
      toJson(input.limits),
      toJson(input.entitlements),
      input.notes,
      input.createdBy,
    ],
  );
  if (!row) throw new Error('platform_policy_version_insert_failed');
  return row;
}

export async function findPolicyVersionById(
  em: EntityManager,
  id: string,
): Promise<PlanPolicyVersionRow | null> {
  return one<PlanPolicyVersionRow>(
    em,
    `select * from "platform_plan_policy_version" where "id" = ?`,
    [id],
  );
}

export async function listPolicyVersions(
  em: EntityManager,
  planId: string,
): Promise<PlanPolicyVersionRow[]> {
  return rows<PlanPolicyVersionRow>(
    em,
    `select * from "platform_plan_policy_version"
      where "plan_id" = ? order by "version" desc`,
    [planId],
  );
}

export async function findLatestPolicyVersion(
  em: EntityManager,
  planId: string,
): Promise<PlanPolicyVersionRow | null> {
  return one<PlanPolicyVersionRow>(
    em,
    `select * from "platform_plan_policy_version"
      where "plan_id" = ? order by "version" desc limit 1`,
    [planId],
  );
}

export async function findEffectivePolicyVersion(
  em: EntityManager,
  planId: string,
  asOf: string,
): Promise<PlanPolicyVersionRow | null> {
  return one<PlanPolicyVersionRow>(
    em,
    `select * from "platform_plan_policy_version"
      where "plan_id" = ? and "effective_from" <= ?::date
      order by "effective_from" desc, "version" desc limit 1`,
    [planId, asOf],
  );
}

export async function insertSubscription(
  em: EntityManager,
  input: {
    tenantId: string;
    customerLabel: string;
    planId: string;
    policyVersionId: string;
    planCode: string;
    policyVersion: number;
    policySnapshot: Record<string, unknown>;
    state: string;
    startedAt: string | null;
    createdBy: string | null;
    tenantSlug: string;
  },
): Promise<PlatformSubscriptionRow> {
  const row = await one<PlatformSubscriptionRow>(
    em,
    `insert into "platform_subscription"
       ("tenant_id", "customer_label", "plan_id", "policy_version_id",
        "plan_code", "policy_version", "policy_snapshot", "state",
        "started_at", "created_by", "tenant_slug")
     values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::timestamptz, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.customerLabel,
      input.planId,
      input.policyVersionId,
      input.planCode,
      input.policyVersion,
      toJson(input.policySnapshot),
      input.state,
      input.startedAt,
      input.createdBy,
      input.tenantSlug,
    ],
  );
  if (!row) throw new Error('platform_subscription_insert_failed');
  return row;
}

export async function findSubscriptionByTenant(
  em: EntityManager,
  tenantId: string,
): Promise<PlatformSubscriptionRow | null> {
  return one<PlatformSubscriptionRow>(
    em,
    `select * from "platform_subscription" where "tenant_id" = ?`,
    [tenantId],
  );
}

export async function findSubscriptionForUpdate(
  em: EntityManager,
  tenantId: string,
): Promise<PlatformSubscriptionRow | null> {
  return one<PlatformSubscriptionRow>(
    em,
    `select * from "platform_subscription" where "tenant_id" = ? for update`,
    [tenantId],
  );
}

export async function findSubscriptionBySlug(
  em: EntityManager,
  slug: string,
): Promise<PlatformSubscriptionRow | null> {
  return one<PlatformSubscriptionRow>(
    em,
    `select * from "platform_subscription" where "tenant_slug" = ?`,
    [slug],
  );
}

export async function findLifecycleEventByKey(
  em: EntityManager,
  tenantId: string,
  idempotencyKey: string,
): Promise<PlatformLifecycleEventRow | null> {
  return one<PlatformLifecycleEventRow>(
    em,
    `select * from "platform_lifecycle_event"
      where "tenant_id" = ? and "idempotency_key" = ?`,
    [tenantId, idempotencyKey],
  );
}

export async function findOnboardingRequest(
  em: EntityManager,
  idempotencyKey: string,
): Promise<PlatformOnboardingRequestRow | null> {
  return one<PlatformOnboardingRequestRow>(
    em,
    `select * from "platform_onboarding_request" where "idempotency_key" = ?`,
    [idempotencyKey],
  );
}

export async function insertOnboardingRequest(
  em: EntityManager,
  input: {
    tenantId: string;
    idempotencyKey: string;
    fingerprint: string;
    response: Record<string, unknown>;
    actorUserId: string | null;
  },
): Promise<PlatformOnboardingRequestRow> {
  const row = await one<PlatformOnboardingRequestRow>(
    em,
    `insert into "platform_onboarding_request"
       ("tenant_id", "idempotency_key", "fingerprint", "response",
        "actor_user_id")
     values (?, ?, ?, ?::jsonb, ?)
     returning *`,
    [
      input.tenantId,
      input.idempotencyKey,
      input.fingerprint,
      toJson(input.response),
      input.actorUserId,
    ],
  );
  if (!row) throw new Error('platform_onboarding_request_insert_failed');
  return row;
}

export async function listLifecycleEvents(
  em: EntityManager,
  tenantId: string,
  limit = 50,
): Promise<PlatformLifecycleEventRow[]> {
  return rows<PlatformLifecycleEventRow>(
    em,
    `select * from "platform_lifecycle_event"
      where "tenant_id" = ? order by "created_at" desc, "id" desc limit ?`,
    [tenantId, limit],
  );
}

export async function insertLifecycleEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    subscriptionId: string;
    eventType: string;
    stateBefore: string | null;
    stateAfter: string;
    reason: string | null;
    idempotencyKey: string;
    snapshot: Record<string, unknown>;
    actorUserId: string | null;
    actorLabel: string | null;
    correlationId: string | null;
  },
): Promise<PlatformLifecycleEventRow> {
  const row = await one<PlatformLifecycleEventRow>(
    em,
    `insert into "platform_lifecycle_event"
       ("tenant_id", "subscription_id", "event_type", "state_before",
        "state_after", "reason", "idempotency_key", "snapshot",
        "actor_user_id", "actor_label", "correlation_id")
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::uuid)
     returning *`,
    [
      input.tenantId,
      input.subscriptionId,
      input.eventType,
      input.stateBefore,
      input.stateAfter,
      input.reason,
      input.idempotencyKey,
      toJson(input.snapshot),
      input.actorUserId,
      input.actorLabel,
      input.correlationId,
    ],
  );
  if (!row) throw new Error('platform_lifecycle_event_insert_failed');
  return row;
}

export async function findSubscriptionById(
  em: EntityManager,
  id: string,
): Promise<PlatformSubscriptionRow | null> {
  return one<PlatformSubscriptionRow>(
    em,
    `select * from "platform_subscription" where "id" = ?`,
    [id],
  );
}

export async function listSubscriptions(
  em: EntityManager,
  limit = 100,
): Promise<PlatformSubscriptionRow[]> {
  return rows<PlatformSubscriptionRow>(
    em,
    `select * from "platform_subscription" order by "created_at" desc limit ?`,
    [limit],
  );
}

export async function updateSubscriptionState(
  em: EntityManager,
  input: {
    id: string;
    expectedVersion: number;
    state: string;
    planCode?: string;
    policyVersionId?: string;
    policyVersion?: number;
    policySnapshot?: Record<string, unknown>;
    startedAt?: string | null;
    suspendedAt?: string | null;
    suspensionReason?: string | null;
    reactivatedAt?: string | null;
    closedAt?: string | null;
    closeReason?: string | null;
  },
): Promise<PlatformSubscriptionRow | null> {
  return one<PlatformSubscriptionRow>(
    em,
    `update "platform_subscription"
        set "state" = ?,
            "plan_code" = coalesce(?, "plan_code"),
            "policy_version_id" = coalesce(?, "policy_version_id"),
            "policy_version" = coalesce(?, "policy_version"),
            "policy_snapshot" = coalesce(?::jsonb, "policy_snapshot"),
            "started_at" = coalesce(?::timestamptz, "started_at"),
            "suspended_at" = coalesce(?::timestamptz, "suspended_at"),
            "suspension_reason" = ?,
            "reactivated_at" = coalesce(?::timestamptz, "reactivated_at"),
            "closed_at" = coalesce(?::timestamptz, "closed_at"),
            "close_reason" = ?,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "version" = ?
      returning *`,
    [
      input.state,
      input.planCode ?? null,
      input.policyVersionId ?? null,
      input.policyVersion ?? null,
      input.policySnapshot === undefined ? null : toJson(input.policySnapshot),
      input.startedAt ?? null,
      input.suspendedAt ?? null,
      input.suspensionReason === undefined ? null : input.suspensionReason,
      input.reactivatedAt ?? null,
      input.closedAt ?? null,
      input.closeReason === undefined ? null : input.closeReason,
      input.id,
      input.expectedVersion,
    ],
  );
}

export async function insertPlatformEntitlement(
  em: EntityManager,
  input: {
    tenantId: string;
    subscriptionId: string;
    capabilityCode: string;
    state: string;
    limits: Record<string, number>;
    source: string;
    expiresAt: string | null;
    createdBy: string | null;
  },
): Promise<PlatformEntitlementRow | null> {
  return one<PlatformEntitlementRow>(
    em,
    `insert into "platform_entitlement"
       ("tenant_id", "subscription_id", "capability_code", "state", "limits",
        "source", "expires_at", "created_by")
     values (?, ?, ?, ?, ?::jsonb, ?, ?::timestamptz, ?)
     on conflict ("tenant_id", "capability_code") do nothing
     returning *`,
    [
      input.tenantId,
      input.subscriptionId,
      input.capabilityCode,
      input.state,
      toJson(input.limits),
      input.source,
      input.expiresAt,
      input.createdBy,
    ],
  );
}

export async function findPlatformEntitlement(
  em: EntityManager,
  tenantId: string,
  capabilityCode: string,
): Promise<PlatformEntitlementRow | null> {
  return one<PlatformEntitlementRow>(
    em,
    `select * from "platform_entitlement"
      where "tenant_id" = ? and "capability_code" = ?`,
    [tenantId, capabilityCode],
  );
}

export async function listEntitlements(
  em: EntityManager,
  tenantId: string,
): Promise<PlatformEntitlementRow[]> {
  return rows<PlatformEntitlementRow>(
    em,
    `select * from "platform_entitlement"
      where "tenant_id" = ? order by "capability_code"`,
    [tenantId],
  );
}

export async function updateEntitlement(
  em: EntityManager,
  input: {
    id: string;
    expectedVersion: number;
    state: string;
    limits: Record<string, number>;
    source: string;
    expiresAt: string | null;
    createdBy: string | null;
  },
): Promise<PlatformEntitlementRow | null> {
  return one<PlatformEntitlementRow>(
    em,
    `update "platform_entitlement"
        set "state" = ?, "limits" = ?::jsonb, "source" = ?,
            "expires_at" = ?::timestamptz, "created_by" = ?,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "version" = ?
      returning *`,
    [
      input.state,
      toJson(input.limits),
      input.source,
      input.expiresAt,
      input.createdBy,
      input.id,
      input.expectedVersion,
    ],
  );
}

export async function insertEntitlementEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    entitlementId: string;
    capabilityCode: string;
    state: string;
    limits: Record<string, number>;
    source: string;
    effectiveFrom: string;
    reason: string | null;
    actorUserId: string | null;
    actorLabel: string | null;
    correlationId: string | null;
  },
): Promise<PlatformEntitlementEventRow> {
  const row = await one<PlatformEntitlementEventRow>(
    em,
    `insert into "platform_entitlement_event"
       ("tenant_id", "entitlement_id", "capability_code", "state", "limits",
        "source", "effective_from", "reason", "actor_user_id", "actor_label",
        "correlation_id")
     values (?, ?, ?, ?, ?::jsonb, ?, ?::date, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.entitlementId,
      input.capabilityCode,
      input.state,
      toJson(input.limits),
      input.source,
      input.effectiveFrom,
      input.reason,
      input.actorUserId,
      input.actorLabel,
      input.correlationId,
    ],
  );
  if (!row) throw new Error('platform_entitlement_event_insert_failed');
  return row;
}

export async function listEntitlementEvents(
  em: EntityManager,
  tenantId: string,
  limit = 50,
): Promise<PlatformEntitlementEventRow[]> {
  return rows<PlatformEntitlementEventRow>(
    em,
    `select * from "platform_entitlement_event"
      where "tenant_id" = ? order by "created_at" desc, "id" desc limit ?`,
    [tenantId, limit],
  );
}

export async function upsertUsageCounter(
  em: EntityManager,
  input: {
    tenantId: string;
    metric: string;
    limitValue: number;
  },
): Promise<PlatformUsageCounterRow> {
  const row = await one<PlatformUsageCounterRow>(
    em,
    `insert into "platform_usage_counter" ("tenant_id", "metric", "limit_value")
     values (?, ?, ?)
     on conflict ("tenant_id", "metric", "period_key") do update
       set "limit_value" = excluded."limit_value", "updated_at" = now()
     returning *`,
    [input.tenantId, input.metric, input.limitValue],
  );
  if (!row) throw new Error('platform_usage_counter_upsert_failed');
  return row;
}

export async function listUsageCounters(
  em: EntityManager,
  tenantId: string,
): Promise<PlatformUsageCounterRow[]> {
  return rows<PlatformUsageCounterRow>(
    em,
    `select * from "platform_usage_counter"
      where "tenant_id" = ? order by "metric"`,
    [tenantId],
  );
}

export async function findUsageCounter(
  em: EntityManager,
  tenantId: string,
  metric: string,
): Promise<PlatformUsageCounterRow | null> {
  return one<PlatformUsageCounterRow>(
    em,
    `select * from "platform_usage_counter"
      where "tenant_id" = ? and "metric" = ?`,
    [tenantId, metric],
  );
}

export async function insertUsageEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    metric: string;
    quantity: number;
    idempotencyKey: string;
    correlationId: string | null;
    recordedBy: string | null;
  },
): Promise<PlatformUsageEventRow | null> {
  return one<PlatformUsageEventRow>(
    em,
    `insert into "platform_usage_event"
       ("tenant_id", "metric", "quantity", "idempotency_key",
        "correlation_id", "recorded_by")
     values (?, ?, ?, ?, ?, ?)
     on conflict ("tenant_id", "metric", "idempotency_key") do nothing
     returning *`,
    [
      input.tenantId,
      input.metric,
      input.quantity,
      input.idempotencyKey,
      input.correlationId,
      input.recordedBy,
    ],
  );
}

export async function findUsageEvent(
  em: EntityManager,
  tenantId: string,
  metric: string,
  idempotencyKey: string,
): Promise<PlatformUsageEventRow | null> {
  return one<PlatformUsageEventRow>(
    em,
    `select * from "platform_usage_event"
      where "tenant_id" = ? and "metric" = ? and "idempotency_key" = ?`,
    [tenantId, metric, idempotencyKey],
  );
}

export async function consumeUsage(
  em: EntityManager,
  input: { tenantId: string; metric: string; delta: number },
): Promise<PlatformUsageConsumeRow> {
  const row = await one<PlatformUsageConsumeRow>(
    em,
    `select * from public.platform_consume_usage(?::uuid, ?, ?::bigint)`,
    [input.tenantId, input.metric, input.delta],
  );
  if (!row) throw new Error('platform_consume_usage_failed');
  return row;
}

export async function insertPlatformInvoiceRow(
  em: EntityManager,
  input: {
    tenantId: string;
    number: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    totalAmount: string;
    issuedBy: string | null;
    notes: string | null;
    idempotencyKey: string;
    correlationId: string | null;
  },
): Promise<PlatformInvoiceRow | null> {
  return one<PlatformInvoiceRow>(
    em,
    `insert into "platform_invoice"
       ("tenant_id", "number", "period_start", "period_end", "currency",
        "total_amount", "issued_by", "notes", "idempotency_key",
        "correlation_id")
     values (?, ?, ?::date, ?::date, ?, ?::numeric, ?, ?, ?, ?)
     on conflict ("tenant_id", "idempotency_key") do nothing
     returning *`,
    [
      input.tenantId,
      input.number,
      input.periodStart,
      input.periodEnd,
      input.currency,
      input.totalAmount,
      input.issuedBy,
      input.notes,
      input.idempotencyKey,
      input.correlationId,
    ],
  );
}

export async function findPlatformInvoiceByKey(
  em: EntityManager,
  tenantId: string,
  idempotencyKey: string,
): Promise<PlatformInvoiceRow | null> {
  return one<PlatformInvoiceRow>(
    em,
    `select * from "platform_invoice"
      where "tenant_id" = ? and "idempotency_key" = ?`,
    [tenantId, idempotencyKey],
  );
}

export async function nextInvoiceNumber(em: EntityManager): Promise<string> {
  const row = await one<{ value: string }>(
    em,
    `select 'PINV-' || lpad(nextval('platform_invoice_number_seq')::text, 8, '0') as "value"`,
  );
  if (!row) throw new Error('platform_invoice_number_failed');
  return row.value;
}

export async function insertPlatformInvoiceLine(
  em: EntityManager,
  input: {
    tenantId: string;
    invoiceId: string;
    description: string;
    quantity: string;
    unitAmount: string;
    amount: string;
  },
): Promise<PlatformInvoiceLineRow> {
  const row = await one<PlatformInvoiceLineRow>(
    em,
    `insert into "platform_invoice_line"
       ("tenant_id", "invoice_id", "description", "quantity", "unit_amount", "amount")
     values (?, ?, ?, ?::numeric, ?::numeric, ?::numeric)
     returning *`,
    [
      input.tenantId,
      input.invoiceId,
      input.description,
      input.quantity,
      input.unitAmount,
      input.amount,
    ],
  );
  if (!row) throw new Error('platform_invoice_line_insert_failed');
  return row;
}

export async function findPlatformInvoiceById(
  em: EntityManager,
  invoiceId: string,
): Promise<PlatformInvoiceRow | null> {
  return one<PlatformInvoiceRow>(
    em,
    `select * from "platform_invoice" where "id" = ?`,
    [invoiceId],
  );
}

export async function listPlatformInvoiceRows(
  em: EntityManager,
  tenantId: string,
  limit = 50,
): Promise<PlatformInvoiceRow[]> {
  return rows<PlatformInvoiceRow>(
    em,
    `select * from "platform_invoice"
      where "tenant_id" = ? order by "issued_at" desc, "number" desc limit ?`,
    [tenantId, limit],
  );
}

export async function listPlatformInvoiceLines(
  em: EntityManager,
  invoiceId: string,
): Promise<PlatformInvoiceLineRow[]> {
  return rows<PlatformInvoiceLineRow>(
    em,
    `select * from "platform_invoice_line"
      where "invoice_id" = ? order by "created_at", "id"`,
    [invoiceId],
  );
}

export async function voidPlatformInvoiceRow(
  em: EntityManager,
  input: { id: string; reason: string; voidedBy: string },
): Promise<PlatformInvoiceRow | null> {
  return one<PlatformInvoiceRow>(
    em,
    `update "platform_invoice"
        set "state" = 'VOID', "voided_at" = now(), "voided_by" = ?,
            "void_reason" = ?, "updated_at" = now()
      where "id" = ? and "state" = 'ISSUED'
      returning *`,
    [input.voidedBy, input.reason, input.id],
  );
}

export async function settlePlatformInvoiceRow(
  em: EntityManager,
  input: {
    id: string;
    reference: string;
    settledBy: string;
    correlationId: string | null;
  },
): Promise<PlatformInvoiceRow | null> {
  return one<PlatformInvoiceRow>(
    em,
    `update "platform_invoice"
        set "state" = 'SETTLED', "settled_at" = now(), "settled_by" = ?,
            "settlement_reference" = ?, "correlation_id" = ?,
            "updated_at" = now()
      where "id" = ? and "state" = 'ISSUED'
      returning *`,
    [input.settledBy, input.reference, input.correlationId, input.id],
  );
}

export async function callPlatformCreateTenant(
  em: EntityManager,
  input: { id: string; name: string; slug: string; actorUserId: string },
): Promise<string> {
  const row = await one<{ id: string }>(
    em,
    `select public.platform_create_tenant(?::uuid, ?, ?, ?::uuid) as "id"`,
    [input.id, input.name, input.slug, input.actorUserId],
  );
  if (!row) throw new Error('platform_create_tenant_failed');
  return row.id;
}

export async function callLifecycleSnapshot(
  em: EntityManager,
  tenantId: string,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  const row = await one<{ snapshot: Record<string, unknown> }>(
    em,
    `select public.platform_lifecycle_snapshot(?::uuid, ?::uuid) as "snapshot"`,
    [tenantId, actorUserId],
  );
  if (!row) throw new Error('platform_lifecycle_snapshot_failed');
  return row.snapshot;
}

export async function callSetTenantStatus(
  em: EntityManager,
  tenantId: string,
  status: string,
  actorUserId: string,
): Promise<string> {
  const row = await one<{ before: string }>(
    em,
    `select public.platform_set_tenant_status(?::uuid, ?, ?::uuid) as "before"`,
    [tenantId, status, actorUserId],
  );
  if (!row) throw new Error('platform_set_tenant_status_failed');
  return row.before;
}

export async function callStopTenantSales(
  em: EntityManager,
  tenantId: string,
  actorUserId: string,
  reason: string,
): Promise<number> {
  const row = await one<{ stops: number }>(
    em,
    `select public.platform_stop_tenant_sales(?::uuid, ?::uuid, ?) as "stops"`,
    [tenantId, actorUserId, reason],
  );
  if (!row) throw new Error('platform_stop_tenant_sales_failed');
  return Number(row.stops);
}

export async function callResumeTenantSales(
  em: EntityManager,
  tenantId: string,
  actorUserId: string,
): Promise<number> {
  const row = await one<{ opened: number }>(
    em,
    `select public.platform_resume_tenant_sales(?::uuid, ?::uuid) as "opened"`,
    [tenantId, actorUserId],
  );
  if (!row) throw new Error('platform_resume_tenant_sales_failed');
  return Number(row.opened);
}

export async function insertPlatformAudit(
  em: EntityManager,
  input: {
    tenantId: string | null;
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    outcome: string;
    beforeSafe: Record<string, unknown> | null;
    afterSafe: Record<string, unknown> | null;
    reason: string | null;
    correlationId: string | null;
  },
): Promise<PlatformAuditEventRow> {
  const row = await one<PlatformAuditEventRow>(
    em,
    `insert into "platform_audit_event"
       ("tenant_id", "actor_user_id", "actor_role", "action", "resource_type",
        "resource_id", "outcome", "before_safe", "after_safe", "reason",
        "correlation_id")
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.actorUserId,
      input.actorRole,
      input.action,
      input.resourceType,
      input.resourceId,
      input.outcome,
      input.beforeSafe === null ? null : toJson(input.beforeSafe),
      input.afterSafe === null ? null : toJson(input.afterSafe),
      input.reason,
      input.correlationId,
    ],
  );
  if (!row) throw new Error('platform_audit_insert_failed');
  return row;
}

export async function recordTenantAuditViaPlatform(
  em: EntityManager,
  input: {
    tenantId: string;
    actorUserId: string;
    actorLabel: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    outcome: string;
    beforeSafe: Record<string, unknown> | null;
    afterSafe: Record<string, unknown> | null;
    reason: string | null;
    correlationId: string | null;
  },
): Promise<void> {
  await em.execute(
    `select public.platform_record_tenant_audit(
       ?::uuid, ?::uuid, ?, ?, ?, ?::uuid, ?, ?::jsonb, ?::jsonb, ?, ?::uuid
     )`,
    [
      input.tenantId,
      input.actorUserId,
      input.actorLabel,
      input.action,
      input.resourceType,
      input.resourceId,
      input.outcome,
      input.beforeSafe === null ? null : toJson(input.beforeSafe),
      input.afterSafe === null ? null : toJson(input.afterSafe),
      input.reason,
      input.correlationId,
    ],
  );
}

export async function listPlatformAudit(
  em: EntityManager,
  limit = 100,
  tenantId: string | null = null,
): Promise<PlatformAuditEventRow[]> {
  if (tenantId)
    return rows<PlatformAuditEventRow>(
      em,
      `select * from "platform_audit_event"
        where "tenant_id" = ?
        order by "created_at" desc, "id" desc limit ?`,
      [tenantId, limit],
    );
  return rows<PlatformAuditEventRow>(
    em,
    `select * from "platform_audit_event"
      order by "created_at" desc, "id" desc limit ?`,
    [limit],
  );
}

export async function insertSupportGrant(
  em: EntityManager,
  input: {
    tenantId: string;
    platformUserId: string;
    scopes: string[];
    reason: string;
    grantedByUserId: string;
    expiresAt: string;
    idempotencyKey: string;
    correlationId: string | null;
  },
): Promise<PlatformSupportGrantRow | null> {
  return one<PlatformSupportGrantRow>(
    em,
    `insert into "platform_support_grant"
       ("tenant_id", "platform_user_id", "scopes", "reason",
        "granted_by_user_id", "expires_at", "idempotency_key",
        "correlation_id")
     values (?, ?, ?::jsonb, ?, ?, ?::timestamptz, ?, ?)
     on conflict ("tenant_id", "idempotency_key") do nothing
     returning *`,
    [
      input.tenantId,
      input.platformUserId,
      toJson(input.scopes),
      input.reason,
      input.grantedByUserId,
      input.expiresAt,
      input.idempotencyKey,
      input.correlationId,
    ],
  );
}

export async function findSupportGrantByKey(
  em: EntityManager,
  tenantId: string,
  idempotencyKey: string,
): Promise<PlatformSupportGrantRow | null> {
  return one<PlatformSupportGrantRow>(
    em,
    `select * from "platform_support_grant"
      where "tenant_id" = ? and "idempotency_key" = ?`,
    [tenantId, idempotencyKey],
  );
}

export async function findSupportGrantById(
  em: EntityManager,
  grantId: string,
): Promise<PlatformSupportGrantRow | null> {
  return one<PlatformSupportGrantRow>(
    em,
    `select * from "platform_support_grant" where "id" = ?`,
    [grantId],
  );
}

export async function listSupportGrants(
  em: EntityManager,
  options: { tenantId?: string | null; limit?: number } = {},
): Promise<PlatformSupportGrantRow[]> {
  if (options.tenantId)
    return rows<PlatformSupportGrantRow>(
      em,
      `select * from "platform_support_grant"
        where "tenant_id" = ?
        order by "created_at" desc, "id" desc limit ?`,
      [options.tenantId, options.limit ?? 100],
    );
  return rows<PlatformSupportGrantRow>(
    em,
    `select * from "platform_support_grant"
      order by "created_at" desc, "id" desc limit ?`,
    [options.limit ?? 100],
  );
}

export async function revokeSupportGrant(
  em: EntityManager,
  input: { grantId: string; revokedBy: string; reason: string },
): Promise<PlatformSupportGrantRow | null> {
  return one<PlatformSupportGrantRow>(
    em,
    `update "platform_support_grant"
        set "revoked_at" = now(), "revoked_by_user_id" = ?,
            "revoke_reason" = ?, "updated_at" = now()
      where "id" = ? and "revoked_at" is null
      returning *`,
    [input.revokedBy, input.reason, input.grantId],
  );
}

export interface ActiveSupportGrantRow {
  id: string;
  scopes: string[];
  expires_at: string;
}

export interface SupportGrantListRow extends PlatformSupportGrantRow {
  platform_user_email: string | null;
}

export async function listSupportGrantViews(
  em: EntityManager,
  options: { tenantId?: string | null; limit?: number } = {},
): Promise<SupportGrantListRow[]> {
  if (options.tenantId)
    return rows<SupportGrantListRow>(
      em,
      `select g.*, u."email" as "platform_user_email"
         from "platform_support_grant" g
         left join "app_user" u on u."id" = g."platform_user_id"
        where g."tenant_id" = ?
        order by g."created_at" desc, g."id" desc limit ?`,
      [options.tenantId, options.limit ?? 100],
    );
  return rows<SupportGrantListRow>(
    em,
    `select g.*, u."email" as "platform_user_email"
       from "platform_support_grant" g
       left join "app_user" u on u."id" = g."platform_user_id"
      order by g."created_at" desc, g."id" desc limit ?`,
    [options.limit ?? 100],
  );
}

export async function findLatestSupportGrant(
  em: EntityManager,
  tenantId: string,
  platformUserId: string,
): Promise<PlatformSupportGrantRow | null> {
  return one<PlatformSupportGrantRow>(
    em,
    `select * from "platform_support_grant"
      where "tenant_id" = ? and "platform_user_id" = ?
      order by "created_at" desc, "id" desc limit 1`,
    [tenantId, platformUserId],
  );
}

export async function findPlatformStaffByEmail(
  em: EntityManager,
  email: string,
): Promise<{
  user_id: string;
  role_code: string;
  staff_status: string;
} | null> {
  return one<{ user_id: string; role_code: string; staff_status: string }>(
    em,
    `select u."id" as "user_id", s."role_code", s."status" as "staff_status"
       from "app_user" u
       join "platform_staff" s on s."user_id" = u."id"
      where lower(u."email") = lower(?) and u."status" = 'ACTIVE'
      limit 1`,
    [email],
  );
}

export async function findActiveSupportGrant(
  em: EntityManager,
  tenantId: string,
  platformUserId: string,
): Promise<ActiveSupportGrantRow | null> {
  return one<ActiveSupportGrantRow>(
    em,
    `select "id", "scopes", "expires_at"
       from "platform_support_grant"
      where "tenant_id" = ? and "platform_user_id" = ?
        and "revoked_at" is null
        and "starts_at" <= now() and "expires_at" > now()
      order by "expires_at" desc limit 1`,
    [tenantId, platformUserId],
  );
}

export interface SupportTenantProfileRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
}

export async function readTenantProfileViaSupportGrant(
  em: EntityManager,
  tenantId: string,
  platformUserId: string,
): Promise<SupportTenantProfileRow | null> {
  return one<SupportTenantProfileRow>(
    em,
    `select * from public.platform_support_tenant_profile(?::uuid, ?::uuid)`,
    [tenantId, platformUserId],
  );
}

export interface SupportAuditRow {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  actor_label: string | null;
  reason: string | null;
  created_at: string;
}

export async function readTenantAuditViaSupportGrant(
  em: EntityManager,
  tenantId: string,
  platformUserId: string,
  limit: number,
): Promise<SupportAuditRow[]> {
  return rows<SupportAuditRow>(
    em,
    `select * from public.platform_support_tenant_audit(?::uuid, ?::uuid, ?::int)`,
    [tenantId, platformUserId, limit],
  );
}
