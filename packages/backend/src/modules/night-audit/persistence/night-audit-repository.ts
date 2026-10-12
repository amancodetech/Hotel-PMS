import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type { NightAuditStepKey } from '../domain/audit-steps.js';

export interface NightAuditRunRow {
  id: string;
  tenant_id: string;
  property_id: string;
  business_date: string;
  state: string;
  current_step: string | null;
  steps_total: number;
  steps_done: number;
  trigger_actor_kind: string;
  trigger_actor_id: string | null;
  trigger_actor_label: string | null;
  owner_membership_id: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  last_error: unknown;
  result: unknown;
  correlation_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface NightAuditStepRow {
  id: string;
  tenant_id: string;
  property_id: string;
  run_id: string;
  business_date: string;
  step_key: string;
  step_order: number;
  state: string;
  attempts: number;
  checkpoint: unknown;
  last_error_code: string | null;
  last_error: unknown;
  correlation_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export interface NightAuditExceptionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  run_id: string;
  business_date: string;
  step_key: string;
  code: string;
  severity: string;
  state: string;
  subject_type: string;
  subject_id: string | null;
  message: string;
  details: unknown;
  owner_membership_id: string | null;
  owner_label: string | null;
  resolution_reason: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NightAuditEventRow {
  id: string;
  tenant_id: string;
  property_id: string;
  run_id: string;
  business_date: string;
  step_key: string | null;
  level: string;
  event: string;
  message: string | null;
  data: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  correlation_id: string | null;
  created_at: Date;
}

export async function findRunByDate(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  businessDate: string,
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `select * from "night_audit_run"
      where "tenant_id" = ? and "property_id" = ? and "business_date" = ?`,
    [tenantId, propertyId, businessDate],
  );
}

export async function findRunById(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
  options: { forUpdate?: boolean } = {},
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `select * from "night_audit_run"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      ${options.forUpdate ? 'for update' : ''}`,
    [runId, tenantId, propertyId],
  );
}

export async function insertRun(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    businessDate: string;
    actorKind: 'USER' | 'SERVICE';
    actorId: string | null;
    actorLabel: string | null;
    ownerMembershipId?: string | null;
    correlationId: string | null;
  },
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `insert into "night_audit_run" (
       "tenant_id", "property_id", "business_date", "state",
       "trigger_actor_kind", "trigger_actor_id", "trigger_actor_label",
       "owner_membership_id", "correlation_id"
     ) values (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
     on conflict ("tenant_id", "property_id", "business_date") do nothing
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.businessDate,
      input.actorKind,
      input.actorId,
      input.actorLabel,
      input.ownerMembershipId ?? null,
      input.correlationId,
    ],
  );
}

export async function listRunsForProperty(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  limit = 20,
): Promise<NightAuditRunRow[]> {
  return rows<NightAuditRunRow>(
    em,
    `select * from "night_audit_run"
      where "tenant_id" = ? and "property_id" = ?
      order by "business_date" desc
      limit ?`,
    [tenantId, propertyId, limit],
  );
}

export async function listWorkCandidates(
  em: EntityManager,
  tenantId: string,
  limit = 10,
): Promise<NightAuditRunRow[]> {
  return rows<NightAuditRunRow>(
    em,
    `select * from "night_audit_run"
      where "tenant_id" = ?
        and "state" in ('PENDING', 'RUNNING')
        and ("lease_expires_at" is null or "lease_expires_at" <= now())
      order by "business_date", "created_at"
      limit ?`,
    [tenantId, limit],
  );
}

export async function workTenants(em: EntityManager): Promise<string[]> {
  const result = await rows<{ tenant_id: string }>(
    em,
    `select "tenant_id" from public.night_audit_work_tenants()`,
  );
  return result.map((row) => row.tenant_id);
}

export async function claimRun(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    leaseOwner: string;
    leaseMs: number;
  },
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `update "night_audit_run"
        set "state" = case when "state" = 'PENDING' then 'RUNNING' else "state" end,
            "lease_owner" = ?,
            "lease_expires_at" = now() + (? * interval '1 millisecond'),
            "attempt" = "attempt" + 1,
            "started_at" = coalesce("started_at", now()),
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" in ('PENDING', 'RUNNING')
        and ("lease_expires_at" is null or "lease_expires_at" <= now())
      returning *`,
    [
      input.leaseOwner,
      input.leaseMs,
      input.runId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function renewLease(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    leaseOwner: string;
    leaseMs: number;
  },
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `update "night_audit_run"
        set "lease_expires_at" = now() + (? * interval '1 millisecond'),
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "lease_owner" = ? and "state" = 'RUNNING'
      returning *`,
    [
      input.leaseMs,
      input.runId,
      input.tenantId,
      input.propertyId,
      input.leaseOwner,
    ],
  );
}

export async function updateRunProgress(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    currentStep: string | null;
    stepsTotal: number;
    stepsDone: number;
  },
): Promise<void> {
  await em.execute(
    `update "night_audit_run"
        set "current_step" = ?, "steps_total" = ?, "steps_done" = ?,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [
      input.currentStep,
      input.stepsTotal,
      input.stepsDone,
      input.runId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function finishRun(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    state: 'SUCCEEDED' | 'VALIDATION_FAILED' | 'FAILED';
    result?: unknown;
    errorCode?: string | null;
    error?: unknown;
  },
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `update "night_audit_run"
        set "state" = ?, "result" = ?::jsonb, "last_error_code" = ?,
            "last_error" = ?::jsonb, "finished_at" = now(), "updated_at" = now(),
            "lease_owner" = null, "lease_expires_at" = null
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.state,
      input.result === undefined ? null : toJson(input.result),
      input.errorCode ?? null,
      input.error === undefined ? null : toJson(input.error),
      input.runId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function requeueRun(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
  },
): Promise<NightAuditRunRow | null> {
  return one<NightAuditRunRow>(
    em,
    `update "night_audit_run"
        set "state" = 'PENDING', "last_error_code" = null, "last_error" = null,
            "lease_owner" = null, "lease_expires_at" = null, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" in ('FAILED', 'VALIDATION_FAILED')
      returning *`,
    [input.runId, input.tenantId, input.propertyId],
  );
}

export async function ensureSteps(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    businessDate: string;
    steps: readonly { key: NightAuditStepKey; order: number }[];
  },
): Promise<NightAuditStepRow[]> {
  for (const step of input.steps) {
    await em.execute(
      `insert into "night_audit_step" (
         "tenant_id", "property_id", "run_id", "business_date",
         "step_key", "step_order", "state"
       ) values (?, ?, ?, ?, ?, ?, 'PENDING')
       on conflict ("tenant_id", "property_id", "business_date", "step_key") do nothing`,
      [
        input.tenantId,
        input.propertyId,
        input.runId,
        input.businessDate,
        step.key,
        step.order,
      ],
    );
  }
  return listSteps(em, input.tenantId, input.propertyId, input.runId);
}

export async function listSteps(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
): Promise<NightAuditStepRow[]> {
  return rows<NightAuditStepRow>(
    em,
    `select * from "night_audit_step"
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
      order by "step_order"`,
    [tenantId, propertyId, runId],
  );
}

export async function updateStep(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    stepId: string;
    state: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
    checkpoint?: unknown;
    errorCode?: string | null;
    error?: unknown;
    correlationId?: string | null;
    incrementAttempts?: boolean;
  },
): Promise<NightAuditStepRow | null> {
  return one<NightAuditStepRow>(
    em,
    `update "night_audit_step"
        set "state" = ?,
            "attempts" = "attempts" + ?,
            "checkpoint" = coalesce(?::jsonb, "checkpoint"),
            "last_error_code" = ?,
            "last_error" = ?::jsonb,
            "correlation_id" = coalesce(?, "correlation_id"),
            "started_at" = case when ? = 'RUNNING'
              then coalesce("started_at", now()) else "started_at" end,
            "finished_at" = case when ? in ('DONE', 'FAILED', 'SKIPPED')
              then now() else null end,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.state,
      input.incrementAttempts ? 1 : 0,
      input.checkpoint === undefined ? null : toJson(input.checkpoint),
      input.errorCode ?? null,
      input.error === undefined ? null : toJson(input.error),
      input.correlationId ?? null,
      input.state,
      input.state,
      input.stepId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function resetFailedSteps(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
  },
): Promise<void> {
  await em.execute(
    `update "night_audit_step"
        set "state" = 'PENDING', "last_error_code" = null, "last_error" = null,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
        and "state" in ('FAILED', 'RUNNING')`,
    [input.tenantId, input.propertyId, input.runId],
  );
}

export async function listExceptions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
): Promise<NightAuditExceptionRow[]> {
  return rows<NightAuditExceptionRow>(
    em,
    `select * from "night_audit_exception"
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
      order by "severity", "created_at", "code"`,
    [tenantId, propertyId, runId],
  );
}

export async function findException(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  exceptionId: string,
): Promise<NightAuditExceptionRow | null> {
  return one<NightAuditExceptionRow>(
    em,
    `select * from "night_audit_exception"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [exceptionId, tenantId, propertyId],
  );
}

export async function insertException(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    businessDate: string;
    stepKey: string;
    code: string;
    severity: string;
    subjectType: string;
    subjectId: string | null;
    message: string;
    details?: unknown;
    correlationId: string | null;
  },
): Promise<NightAuditExceptionRow | null> {
  return one<NightAuditExceptionRow>(
    em,
    `insert into "night_audit_exception" (
       "tenant_id", "property_id", "run_id", "business_date", "step_key",
       "code", "severity", "subject_type", "subject_id", "message", "details",
       "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
     on conflict ("tenant_id", "property_id", "run_id", "code", "subject_type", "subject_id")
       do nothing
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.runId,
      input.businessDate,
      input.stepKey,
      input.code,
      input.severity,
      input.subjectType,
      input.subjectId,
      input.message,
      toJson(input.details ?? {}),
      input.correlationId,
    ],
  );
}

export async function resolveException(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    exceptionId: string;
    state: 'ACKNOWLEDGED' | 'RESOLVED';
    ownerMembershipId?: string | null;
    ownerLabel?: string | null;
    reason: string;
    resolvedBy: string | null;
  },
): Promise<NightAuditExceptionRow | null> {
  return one<NightAuditExceptionRow>(
    em,
    `update "night_audit_exception"
        set "state" = ?, "owner_membership_id" = coalesce(?, "owner_membership_id"),
            "owner_label" = coalesce(?, "owner_label"),
            "resolution_reason" = ?, "resolved_by" = ?,
            "resolved_at" = now(), "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'OPEN'
      returning *`,
    [
      input.state,
      input.ownerMembershipId ?? null,
      input.ownerLabel ?? null,
      input.reason,
      input.resolvedBy,
      input.exceptionId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function autoResolveCleared(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    code: string;
    keepIds: readonly string[];
    reason: string;
  },
): Promise<number> {
  const result = (await em.execute(
    `update "night_audit_exception"
        set "state" = 'RESOLVED', "resolution_reason" = ?, "resolved_by" = null,
            "resolved_at" = now(), "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
        and "code" = ? and "state" = 'OPEN'
        and coalesce("subject_id", '00000000-0000-0000-0000-000000000000'::uuid)
            <> all(?::uuid[])
      returning "id"`,
    [
      input.reason,
      input.tenantId,
      input.propertyId,
      input.runId,
      input.code,
      input.keepIds.length === 0 ? '{}' : `{${input.keepIds.join(',')}}`,
    ],
  )) as unknown as unknown[];
  return result.length;
}

export async function countOpenBlockingExceptions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(*)::int as "count" from "night_audit_exception"
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
        and "state" = 'OPEN' and "severity" = 'BLOCKING'`,
    [tenantId, propertyId, runId],
  );
  return row?.count ?? 0;
}

export async function insertEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    businessDate: string;
    stepKey?: string | null;
    level?: 'INFO' | 'WARN' | 'ERROR';
    event: string;
    message?: string | null;
    data?: unknown;
    actorKind: 'USER' | 'SERVICE';
    actorId: string | null;
    actorLabel: string | null;
    correlationId: string | null;
  },
): Promise<void> {
  await em.execute(
    `insert into "night_audit_event" (
       "tenant_id", "property_id", "run_id", "business_date", "step_key",
       "level", "event", "message", "data", "actor_kind", "actor_id",
       "actor_label", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
    [
      input.tenantId,
      input.propertyId,
      input.runId,
      input.businessDate,
      input.stepKey ?? null,
      input.level ?? 'INFO',
      input.event,
      input.message ?? null,
      toJson(input.data ?? {}),
      input.actorKind,
      input.actorId,
      input.actorLabel,
      input.correlationId,
    ],
  );
}

export async function listEvents(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
  limit = 100,
): Promise<NightAuditEventRow[]> {
  return rows<NightAuditEventRow>(
    em,
    `select * from "night_audit_event"
      where "tenant_id" = ? and "property_id" = ? and "run_id" = ?
      order by "created_at", "id"
      limit ?`,
    [tenantId, propertyId, runId, limit],
  );
}

export interface InHouseSegmentRow {
  segment_id: string;
  item_id: string;
  reservation_id: string;
  quantity: number;
  price_snapshot_id: string | null;
}

export async function listInHouseSegments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  businessDate: string,
): Promise<InHouseSegmentRow[]> {
  return rows<InHouseSegmentRow>(
    em,
    `select s."id" as "segment_id", s."item_id", i."reservation_id",
            i."quantity", i."price_snapshot_id"
       from "stay_segment" s
       join "reservation_item" i
         on i."id" = s."item_id"
        and i."property_id" = s."property_id"
        and i."tenant_id" = s."tenant_id"
      where s."tenant_id" = ? and s."property_id" = ?
        and s."state" = 'IN_HOUSE'
        and s."start_date" <= ? and s."end_date" > ?
      order by s."start_date", s."id"`,
    [tenantId, propertyId, businessDate, businessDate],
  );
}

export interface UnresolvedArrivalRow {
  item_id: string;
  reservation_id: string;
  arrival: string;
}

export async function listUnresolvedArrivals(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  businessDate: string,
): Promise<UnresolvedArrivalRow[]> {
  return rows<UnresolvedArrivalRow>(
    em,
    `select "id" as "item_id", "reservation_id", "arrival"::text as "arrival"
       from "reservation_item"
      where "tenant_id" = ? and "property_id" = ?
        and "state" = 'CONFIRMED' and "arrival" <= ?
      order by "arrival", "id"`,
    [tenantId, propertyId, businessDate],
  );
}

export interface UnresolvedDepartureRow {
  item_id: string;
  reservation_id: string;
  end_date: string;
}

export async function listUnresolvedDepartures(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  businessDate: string,
): Promise<UnresolvedDepartureRow[]> {
  return rows<UnresolvedDepartureRow>(
    em,
    `select s."item_id", i."reservation_id", s."end_date"::text as "end_date"
       from "stay_segment" s
       join "reservation_item" i
         on i."id" = s."item_id"
        and i."property_id" = s."property_id"
        and i."tenant_id" = s."tenant_id"
      where s."tenant_id" = ? and s."property_id" = ?
        and s."state" = 'IN_HOUSE' and s."end_date" <= ?
      order by s."end_date", s."id"`,
    [tenantId, propertyId, businessDate],
  );
}

export interface OpenFolioRow {
  id: string;
  reservation_id: string | null;
  kind: string;
  currency: string;
  state: string;
}

export async function listOpenFolios(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<OpenFolioRow[]> {
  return rows<OpenFolioRow>(
    em,
    `select "id", "reservation_id", "kind", "currency", "state"
       from "folio"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'OPEN'
      order by "created_at", "id"`,
    [tenantId, propertyId],
  );
}

export interface UnknownPaymentRow {
  id: string;
  folio_id: string;
  currency: string;
  amount: string;
}

export async function listUnknownPayments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<UnknownPaymentRow[]> {
  return rows<UnknownPaymentRow>(
    em,
    `select "id", "folio_id", "currency", "amount"
       from "folio_payment"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'UNKNOWN'
      order by "created_at", "id"`,
    [tenantId, propertyId],
  );
}

export interface PriceSnapshotRow {
  id: string;
  currency: string;
  cells: unknown;
}

export async function findPriceSnapshot(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  quoteId: string,
): Promise<PriceSnapshotRow | null> {
  return one<PriceSnapshotRow>(
    em,
    `select "id", "currency", "cells" from "price_quote"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [quoteId, tenantId, propertyId],
  );
}

export function runView(row: NightAuditRunRow) {
  return {
    id: row.id,
    business_date: row.business_date,
    state: row.state,
    current_step: row.current_step,
    steps_total: row.steps_total,
    steps_done: row.steps_done,
    attempt: row.attempt,
    last_error_code: row.last_error_code,
    lease_owner: row.lease_owner,
    started_at: row.started_at,
    finished_at: row.finished_at,
    correlation_id: row.correlation_id,
  };
}

export function stepView(row: NightAuditStepRow) {
  return {
    step_key: row.step_key,
    step_order: row.step_order,
    state: row.state,
    attempts: row.attempts,
    checkpoint: row.checkpoint ?? null,
    last_error_code: row.last_error_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

export function exceptionView(row: NightAuditExceptionRow) {
  return {
    id: row.id,
    step_key: row.step_key,
    code: row.code,
    severity: row.severity,
    state: row.state,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    message: row.message,
    details: row.details ?? {},
    owner_membership_id: row.owner_membership_id,
    owner_label: row.owner_label,
    resolution_reason: row.resolution_reason,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
  };
}

export function eventView(row: NightAuditEventRow) {
  return {
    id: row.id,
    step_key: row.step_key,
    level: row.level,
    event: row.event,
    message: row.message,
    data: row.data ?? {},
    actor_kind: row.actor_kind,
    actor_label: row.actor_label,
    created_at: row.created_at,
  };
}
