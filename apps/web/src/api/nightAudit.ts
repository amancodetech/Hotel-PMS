import { api } from './client.js';

export type BusinessDayState =
  'OPEN' | 'AUDIT_PREPARING' | 'AUDIT_VALIDATION' | 'CLOSING' | 'CLOSED';

export type NightAuditRunState =
  'PENDING' | 'RUNNING' | 'VALIDATION_FAILED' | 'FAILED' | 'SUCCEEDED';

export type NightAuditStepState =
  'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export type NightAuditExceptionSeverity = 'BLOCKING' | 'WARNING';
export type NightAuditExceptionState = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface NightAuditBusinessDay {
  id: string;
  business_date: string;
  state: BusinessDayState;
  version: number;
  opened_at: string;
  closed_at: string | null;
}

export interface NightAuditRun {
  id: string;
  business_date: string;
  state: NightAuditRunState;
  current_step: string | null;
  steps_total: number;
  steps_done: number;
  attempt: number;
  last_error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  correlation_id?: string | null;
}

export interface NightAuditStep {
  step_key: string;
  step_order: number;
  state: NightAuditStepState;
  attempts: number;
  checkpoint: Record<string, unknown> | null;
  last_error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface NightAuditException {
  id: string;
  step_key: string;
  code: string;
  severity: NightAuditExceptionSeverity;
  state: NightAuditExceptionState;
  subject_type: string;
  subject_id: string | null;
  message: string;
  details: Record<string, unknown>;
  owner_membership_id: string | null;
  owner_label: string | null;
  resolution_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface NightAuditEvent {
  id: string;
  step_key: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  event: string;
  message: string | null;
  data: Record<string, unknown>;
  actor_kind: 'USER' | 'SERVICE';
  actor_label: string | null;
  created_at: string;
}

export interface NightAuditOverview {
  date: string;
  active_business_date: string | null;
  timezone: string;
  business_day: NightAuditBusinessDay | null;
  run: NightAuditRun | null;
  steps: NightAuditStep[];
  exceptions: NightAuditException[];
  events: NightAuditEvent[];
  open_blocking: number;
}

export interface NightAuditRunList {
  runs: NightAuditRun[];
}

export interface StartNightAuditResult {
  run: NightAuditRun;
  created: boolean;
  replayed: boolean;
}

export interface NightAuditExceptionResult {
  exception: NightAuditException;
  replayed: boolean;
}

function tenantRoot(tenantId: string, propertyId: string) {
  return `/api/v1/tenants/${tenantId}/properties/${propertyId}`;
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function write<T>(path: string, body?: unknown) {
  return api<T>(path, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey() },
  });
}

export const nightAuditApi = {
  getOverview: (tenantId: string, propertyId: string, date?: string) =>
    api<NightAuditOverview>(
      `${tenantRoot(tenantId, propertyId)}/night-audits${
        date ? `?date=${encodeURIComponent(date)}` : ''
      }`,
    ),
  listRuns: (tenantId: string, propertyId: string) =>
    api<NightAuditRunList>(
      `${tenantRoot(tenantId, propertyId)}/night-audits/runs`,
    ),
  start: (tenantId: string, propertyId: string, businessDate: string) =>
    write<StartNightAuditResult>(
      `${tenantRoot(tenantId, propertyId)}/night-audits/runs`,
      { business_date: businessDate },
    ),
  retry: (tenantId: string, propertyId: string, runId: string) =>
    write<Record<string, unknown>>(
      `${tenantRoot(tenantId, propertyId)}/night-audits/runs/${runId}/retry`,
      {},
    ),
  resolveException: (
    tenantId: string,
    propertyId: string,
    exceptionId: string,
    body: {
      owner_label?: string;
      owner_membership_id?: string;
      reason: string;
    },
  ) =>
    write<NightAuditExceptionResult>(
      `${tenantRoot(tenantId, propertyId)}/night-audits/exceptions/${exceptionId}/resolution`,
      body,
    ),
};
