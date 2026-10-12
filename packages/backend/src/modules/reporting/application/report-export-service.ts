import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { findMembership } from '../../identity/persistence/org-repository.js';
import { evaluatePolicy } from '../../identity/application/policy-service.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { isReportKind, reportKindDefinitions } from '../domain/metrics.js';
import type { ReportKind } from '../domain/metrics.js';
import * as repo from '../persistence/reporting-repository.js';
import type { ReportPeriodInput } from './reporting-service.js';
import {
  requireCurrency,
  toIsoInstant,
  validatePeriod,
} from './reporting-service.js';

export const REPORT_EXPORT_TTL_MINUTES = 15;
export const REPORT_EXPORT_MAX_ROWS = 2000;

export interface CreateReportExportInput {
  kind: ReportKind;
  period: ReportPeriodInput;
  currency?: 'IDR' | 'USD' | null;
  resource_type?: string | null;
  reference_date?: string | null;
  format?: 'CSV';
  idempotencyKey?: string | null;
}

export interface ReportExportRow {
  id: string;
  tenant_id: string;
  property_id: string | null;
  kind: string;
  format: string;
  state: string;
  request: Record<string, unknown>;
  content: string | null;
  content_sha256: string | null;
  row_count: number | null;
  byte_size: number | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempt: number;
  last_error_code: string | null;
  created_by_membership_id: string | null;
  created_by_label: string | null;
  created_by_session_id: string | null;
  correlation_id: string | null;
  created_at: Date;
  ready_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
}

function isFinancial(kind: ReportKind): boolean {
  return reportKindDefinitions[kind].domain === 'FINANCIAL';
}

export function exportView(row: ReportExportRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    state: row.state,
    property_id: row.property_id,
    period: (row.request as { period?: unknown }).period ?? null,
    currency: (row.request as { currency?: unknown }).currency ?? null,
    created_at: toIsoInstant(row.created_at),
    ready_at: toIsoInstant(row.ready_at),
    expires_at: toIsoInstant(row.expires_at),
    revoked_at: toIsoInstant(row.revoked_at),
    content_sha256: row.content_sha256,
    byte_size: row.byte_size,
    correlation_id: row.correlation_id,
  };
}

export async function insertReportExport(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string | null;
    kind: string;
    request: Record<string, unknown>;
    membershipId: string | null;
    label: string | null;
    sessionId: string | null;
    correlationId: string | null;
  },
): Promise<ReportExportRow> {
  const result = (await em.execute(
    `insert into "report_export" (
       "id", "tenant_id", "property_id", "kind", "format", "state", "request",
       "created_by_membership_id", "created_by_label", "created_by_session_id",
       "correlation_id", "expires_at"
     ) values (?, ?, ?, ?, 'CSV', 'PENDING', ?::jsonb, ?, ?, ?, ?,
       now() + (? || ' minutes')::interval)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.kind,
      JSON.stringify(input.request),
      input.membershipId,
      input.label,
      input.sessionId,
      input.correlationId,
      String(REPORT_EXPORT_TTL_MINUTES),
    ],
  )) as ReportExportRow[];
  const row = result[0];
  if (!row) throw new Error('report export insert returned no row');
  return row;
}

export async function findReportExportById(
  em: EntityManager,
  tenantId: string,
  exportId: string,
): Promise<ReportExportRow | null> {
  const result = (await em.execute(
    `select * from "report_export" where "tenant_id" = ? and "id" = ?`,
    [tenantId, exportId],
  )) as ReportExportRow[];
  return result[0] ?? null;
}

export async function listReportExportRows(
  em: EntityManager,
  tenantId: string,
  membershipId: string,
  propertyId: string | null,
): Promise<ReportExportRow[]> {
  return (await em.execute(
    `select * from "report_export"
      where "tenant_id" = ? and "created_by_membership_id" = ?
        and ("property_id" = ? or (?::uuid is null and "property_id" is null))
      order by "created_at" desc limit 50`,
    [tenantId, membershipId, propertyId, propertyId],
  )) as ReportExportRow[];
}

async function resolvePortfolioScope(
  em: EntityManager,
  context: ServiceContext,
  tenantId: string,
  propertyIds: string[] | null,
  permission: 'report.financial.view',
): Promise<repo.PropertyReportScope[]> {
  const properties = await repo.listTenantProperties(em, tenantId);
  let selected: repo.PropertyReportScope[];
  if (propertyIds && propertyIds.length > 0) {
    selected = [];
    for (const propertyId of propertyIds) {
      const found = await repo.findPropertyInTenant(em, tenantId, propertyId);
      if (!found)
        throw new PropertyError('NOT_FOUND', {
          reason: 'property_out_of_scope',
        });
      const decision = await evaluatePolicy(em, {
        actor: context.actor,
        tenantId,
        permission,
        propertyRef: propertyId,
      });
      if (!decision.allowed)
        throw new PropertyError('NOT_FOUND', {
          reason: 'property_out_of_scope',
        });
      const property = properties.find((row) => row.id === propertyId);
      if (property) selected.push(property);
    }
    return selected;
  }
  selected = [];
  for (const property of properties) {
    const decision = await evaluatePolicy(em, {
      actor: context.actor,
      tenantId,
      permission,
      propertyRef: property.id,
    });
    if (decision.allowed) selected.push(property);
  }
  return selected;
}

export async function createReportExport(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string | null,
  input: CreateReportExportInput,
): Promise<Record<string, unknown>> {
  if (!isReportKind(input.kind))
    throw new PropertyError('INVALID_REQUEST', {
      field: 'kind',
      reason: 'unknown_report_kind',
    });
  const kind = input.kind;
  // Same period/currency contract as ReadReport: a request that the generator
  // would reject must fail here with 400, never enter the worker queue.
  validatePeriod(input.period);
  requireCurrency(kind, input.currency ?? null);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ExportReport',
    property_id: propertyId,
    kind,
    period: input.period,
    currency: input.currency ?? null,
    resource_type: input.resource_type ?? null,
    reference_date: input.reference_date ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.export', propertyId);
      if (isFinancial(kind))
        await authorize(em, context, 'report.financial.view', propertyId);
      if (
        input.currency &&
        input.currency !== 'IDR' &&
        input.currency !== 'USD'
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'currency' });
      const replayed = await checkIdempotency(
        em,
        context,
        'ExportReport',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      let request: Record<string, unknown> = {
        kind,
        period: input.period,
        currency: input.currency ?? null,
        resource_type: input.resource_type ?? null,
        reference_date: input.reference_date ?? null,
      };
      if (propertyId) {
        const property = await repo.findReportPropertyScope(
          em,
          context.tenantId,
          propertyId,
        );
        if (!property) throw new PropertyError('NOT_FOUND');
      } else {
        if (kind !== 'PORTFOLIO')
          throw new PropertyError('INVALID_REQUEST', {
            field: 'kind',
            reason: 'tenant_report_kind_not_allowed',
          });
        const selected = await resolvePortfolioScope(
          em,
          context,
          context.tenantId,
          null,
          'report.financial.view',
        );
        request = {
          ...request,
          resolved_property_ids: selected.map((property) => property.id),
        };
      }
      const membership = await findMembership(
        em,
        context.tenantId,
        context.actor.userId,
      );
      const row = await insertReportExport(em, {
        tenantId: context.tenantId,
        propertyId,
        kind,
        request,
        membershipId: membership?.id ?? null,
        label: context.actor.displayName,
        sessionId: context.actor.sessionId ?? null,
        correlationId: context.correlationId,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        actorType: context.actor.kind,
        actorId: context.actor.userId,
        actorLabel: context.actor.displayName,
        action: 'report.export_created',
        resourceType: 'ReportExport',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: {},
        afterSafe: {
          kind,
          format: row.format,
          expires_at: String(row.expires_at),
        },
        correlationId: context.correlationId,
      });
      const response = { export: exportView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ExportReport',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function listReportExports(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string | null,
): Promise<Array<Record<string, unknown>>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.export', propertyId);
      const membership = await findMembership(
        em,
        context.tenantId,
        context.actor.userId,
      );
      if (!membership)
        throw new PropertyError('NOT_FOUND', { reason: 'membership' });
      const rows = await listReportExportRows(
        em,
        context.tenantId,
        membership.id,
        propertyId,
      );
      return rows.map((row) => exportView(row));
    },
  );
}

export interface ReportExportDownload {
  file_name: string;
  content: string;
  content_sha256: string;
  byte_size: number;
  row_count: number;
}

function assertOwner(row: ReportExportRow, membershipId: string | null): void {
  if (!membershipId || row.created_by_membership_id !== membershipId)
    throw new PropertyError('NOT_FOUND');
}

async function expireIfNeeded(
  em: EntityManager,
  row: ReportExportRow,
): Promise<ReportExportRow> {
  if (row.state !== 'READY') return row;
  // The comparison stays in SQL so timestamp formats never depend on JS date
  // parsing; the lazy sweep commits before any error is raised.
  const updated = (await em.execute(
    `update "report_export"
        set "state" = 'EXPIRED', "content" = null
      where "id" = ? and "tenant_id" = ? and "state" = 'READY'
        and "expires_at" <= now()
      returning *`,
    [row.id, row.tenant_id],
  )) as ReportExportRow[];
  return updated[0] ?? row;
}

export async function downloadReportExport(
  orm: MikroORM,
  context: ServiceContext,
  exportId: string,
): Promise<ReportExportDownload & { correlation_id: string | null }> {
  // Lazy expiry commits its state change inside the transaction, and any
  // failure is raised only after the commit so an expired export is not
  // resurrected by the rollback of the download request.
  const result = await runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      const row = await findReportExportById(em, context.tenantId, exportId);
      if (!row) throw new PropertyError('NOT_FOUND');
      // Live permission check: a revoked grant or membership fails closed even
      // when the export row still exists. Session id is deliberately not part
      // of the check, so a new session for the same membership still works.
      await authorize(em, context, 'report.export', row.property_id);
      const membership = await findMembership(
        em,
        context.tenantId,
        context.actor.userId,
      );
      assertOwner(row, membership?.id ?? null);
      const current = await expireIfNeeded(em, row);
      if (current.state !== 'READY' || !current.content)
        return { failed: current.state } as const;
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId: row.property_id,
        actorType: context.actor.kind,
        actorId: context.actor.userId,
        actorLabel: context.actor.displayName,
        action: 'report.export_downloaded',
        resourceType: 'ReportExport',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: {},
        afterSafe: { sha256: current.content_sha256 },
        correlationId: context.correlationId,
      });
      return {
        failed: null as string | null,
        file_name: `report-${row.kind.toLowerCase()}-${row.id.slice(0, 8)}.csv`,
        content: current.content,
        content_sha256: current.content_sha256 as string,
        byte_size:
          current.byte_size ?? Buffer.byteLength(current.content, 'utf8'),
        row_count: current.row_count ?? 0,
        correlation_id: row.correlation_id,
      };
    },
  );
  if (result.failed === 'REVOKED')
    throw new PropertyError('REPORT_EXPORT_REVOKED');
  if (result.failed === 'EXPIRED')
    throw new PropertyError('REPORT_EXPORT_EXPIRED');
  if (result.failed)
    throw new PropertyError('REPORT_EXPORT_NOT_READY', {
      state: result.failed,
    });
  return {
    file_name: result.file_name as string,
    content: result.content as string,
    content_sha256: result.content_sha256 as string,
    byte_size: result.byte_size as number,
    row_count: result.row_count as number,
    correlation_id: result.correlation_id as string | null,
  };
}

export async function revokeReportExport(
  orm: MikroORM,
  context: ServiceContext,
  exportId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      const row = await findReportExportById(em, context.tenantId, exportId);
      if (!row) throw new PropertyError('NOT_FOUND');
      await authorize(em, context, 'report.export', row.property_id);
      const membership = await findMembership(
        em,
        context.tenantId,
        context.actor.userId,
      );
      assertOwner(row, membership?.id ?? null);
      if (row.state === 'REVOKED') return exportView(row);
      const updated = (await em.execute(
        `update "report_export"
            set "state" = 'REVOKED', "content" = null, "revoked_at" = now()
          where "id" = ? and "tenant_id" = ?
          returning *`,
        [row.id, row.tenant_id],
      )) as ReportExportRow[];
      const result = updated[0] ?? row;
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId: row.property_id,
        actorType: context.actor.kind,
        actorId: context.actor.userId,
        actorLabel: context.actor.displayName,
        action: 'report.export_revoked',
        resourceType: 'ReportExport',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: row.state },
        afterSafe: { state: result.state },
        correlationId: context.correlationId,
      });
      return exportView(result);
    },
  );
}

export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
