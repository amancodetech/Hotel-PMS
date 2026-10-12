import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { LogEvent, SafeLogFields } from '../../../logging.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import * as repo from '../persistence/reporting-repository.js';
import {
  buildPortfolioPayload,
  buildReportPayload,
} from './reporting-service.js';
import {
  contentSha256,
  REPORT_EXPORT_MAX_ROWS,
} from './report-export-service.js';
import type { ReportExportRow } from './report-export-service.js';

/**
 * CSV export safety: every cell that could start a spreadsheet formula is
 * neutralized with a leading apostrophe (OWASP CSV injection guidance) before
 * it is written, so opening the file cannot execute text as a formula.
 */
export function sanitizeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const dangerous = /^[=+\-@\t\r]/u.test(text);
  const escaped = dangerous ? `'${text}` : text;
  if (/[",\n\r]/u.test(escaped)) return `"${escaped.replaceAll('"', '""')}"`;
  return escaped;
}

function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(sanitizeCsvCell).join(',')}\r\n`;
}

export interface ExportPayload {
  report_id?: unknown;
  kind?: unknown;
  generated_at?: unknown;
  period?: { date_from?: unknown; date_to?: unknown } | null;
  currency?: unknown;
  cutoff?: {
    business_date?: unknown;
    state?: unknown;
    property_timezone?: unknown;
  } | null;
  metrics?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
}

export function toCsv(payload: ExportPayload): {
  content: string;
  rowCount: number;
} {
  const lines: string[] = [];
  lines.push(
    csvLine([
      'record_type',
      'key',
      'label',
      'value',
      'unit',
      'basis',
      'extra',
      'date',
    ]),
  );
  const meta: Array<[string, unknown, unknown]> = [
    ['report_id', payload.report_id, ''],
    ['kind', payload.kind, ''],
    ['generated_at', payload.generated_at, ''],
    [
      'period',
      `${payload.period?.date_from ?? ''}/${payload.period?.date_to ?? ''}`,
      '',
    ],
    ['currency', payload.currency, ''],
    [
      'cutoff_business_date',
      payload.cutoff?.business_date,
      payload.cutoff?.state,
    ],
    ['property_timezone', payload.cutoff?.property_timezone, ''],
  ];
  for (const [key, value, extra] of meta)
    lines.push(csvLine(['meta', key, '', value, '', '', extra, '']));
  let rowCount = 0;
  for (const metric of payload.metrics ?? []) {
    lines.push(
      csvLine([
        'metric',
        metric['key'] ?? '',
        metric['label'] ?? '',
        metric['value'] ?? '',
        metric['unit'] ?? '',
        metric['basis'] ?? '',
        metric['zero_denominator'] === true ? 'DENOMINATOR_ZERO' : '',
        '',
      ]),
    );
    rowCount += 1;
  }
  for (const row of payload.rows ?? []) {
    lines.push(
      csvLine([
        'row',
        '',
        row['label'] ?? '',
        row['value'] ?? '',
        row['unit'] ?? '',
        '',
        row['state'] ?? '',
        row['date'] ?? '',
      ]),
    );
    rowCount += 1;
  }
  if (rowCount > REPORT_EXPORT_MAX_ROWS)
    throw new Error('REPORT_EXPORT_ROW_LIMIT');
  return { content: lines.join(''), rowCount };
}

async function claimExport(
  em: EntityManager,
  owner: string,
  leaseMs: number,
): Promise<ReportExportRow | null> {
  const result = (await em.execute(
    `with candidate as (
       select "id" from "report_export"
        where "state" = 'PENDING'
           or ("state" = 'RUNNING' and "lease_expires_at" < now())
        order by "created_at"
        limit 1
        for update skip locked
     )
     update "report_export" e
        set "state" = 'RUNNING',
            "lease_owner" = ?,
            "lease_expires_at" = now() + (?::bigint || ' milliseconds')::interval,
            "attempt" = e."attempt" + 1
       from candidate c
      where e."id" = c."id"
      returning e.*`,
    [owner, String(leaseMs)],
  )) as ReportExportRow[];
  return result[0] ?? null;
}

function requestInput(row: ReportExportRow) {
  const request = row.request as {
    kind: string;
    period: { date_from: string; date_to: string };
    currency?: 'IDR' | 'USD' | null;
    resource_type?: string | null;
    reference_date?: string | null;
    resolved_property_ids?: string[];
  };
  return {
    kind: request.kind as never,
    period: request.period,
    currency: request.currency ?? null,
    resource_type: request.resource_type ?? null,
    reference_date: request.reference_date ?? null,
    resolved_property_ids: request.resolved_property_ids ?? [],
  };
}

async function generateExport(
  em: EntityManager,
  row: ReportExportRow,
): Promise<{ content: string; rowCount: number }> {
  const input = requestInput(row);
  let payload: Record<string, unknown>;
  if (row.property_id) {
    payload = await buildReportPayload(
      em,
      row.tenant_id,
      row.property_id,
      input,
    );
  } else {
    const properties: repo.PropertyReportScope[] = [];
    for (const propertyId of input.resolved_property_ids) {
      const property = await repo.findReportPropertyScope(
        em,
        row.tenant_id,
        propertyId,
      );
      if (property) properties.push(property);
    }
    payload = await buildPortfolioPayload(em, row.tenant_id, input, properties);
  }
  return toCsv(payload);
}

async function workTenants(orm: MikroORM): Promise<string[]> {
  const result = (await orm.em
    .fork()
    .execute(
      `select "tenant_id" from public.report_export_work_tenants()`,
      [],
    )) as Array<{ tenant_id: string }>;
  return result.map((row) => row.tenant_id);
}

export async function processReportExportWork(options: {
  orm: MikroORM;
  owner: string;
  leaseMs: number;
  maxTenants?: number;
  logger?: (event: LogEvent, fields: SafeLogFields) => void;
}): Promise<number> {
  const tenants = await workTenants(options.orm);
  let processed = 0;
  for (const tenantId of tenants.slice(0, options.maxTenants ?? 5)) {
    const worked = await runScopedTransaction(
      options.orm,
      { tenantId },
      async (em) => {
        await em.execute(
          `update "report_export"
              set "state" = 'EXPIRED', "content" = null
            where "state" = 'READY' and "expires_at" <= now()`,
          [],
        );
        const row = await claimExport(em, options.owner, options.leaseMs);
        if (!row) return 0;
        try {
          const { content, rowCount } = await generateExport(em, row);
          await em.execute(
            `update "report_export"
                set "state" = 'READY',
                    "content" = ?,
                    "content_sha256" = ?,
                    "row_count" = ?,
                    "byte_size" = ?,
                    "ready_at" = now(),
                    "lease_owner" = null,
                    "lease_expires_at" = null,
                    "last_error_code" = null
              where "id" = ? and "tenant_id" = ?`,
            [
              content,
              contentSha256(content),
              rowCount,
              Buffer.byteLength(content, 'utf8'),
              row.id,
              row.tenant_id,
            ],
          );
          options.logger?.('report_export_ready', {
            service: 'worker',
            export_kind: row.kind,
            row_count: rowCount,
          });
          return 1;
        } catch (error) {
          options.logger?.('report_export_failed', {
            service: 'worker',
            export_kind: row.kind,
            message:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
          await em.execute(
            `update "report_export"
                set "state" = 'FAILED',
                    "last_error_code" = ?,
                    "lease_owner" = null,
                    "lease_expires_at" = null
              where "id" = ? and "tenant_id" = ?`,
            [
              error instanceof Error
                ? error.message.slice(0, 80)
                : 'REPORT_EXPORT_FAILED',
              row.id,
              row.tenant_id,
            ],
          );
          return 1;
        }
      },
    );
    processed += worked;
    if (worked === 0) continue;
  }
  return processed;
}

export function startReportExportScheduler(options: {
  orm: MikroORM;
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  logger?: (event: LogEvent, fields: SafeLogFields) => void;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await processReportExportWork({
        orm: options.orm,
        owner: options.owner,
        leaseMs: options.leaseMs,
        logger: options.logger,
      });
    } catch (error) {
      options.logger?.('report_export_tick_failed', {
        service: 'worker',
        message:
          error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(
    () => void tick(),
    Math.max(250, options.pollIntervalMs),
  );
  timer.unref?.();
  void tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
