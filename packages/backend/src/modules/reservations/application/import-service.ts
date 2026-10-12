import { createHash, randomUUID } from 'node:crypto';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import { one } from '../../../persistence/sql.js';
import { isRestrictedSharingScope } from '../domain/sharing-policy.js';
import * as repo from '../persistence/reservation-repository.js';

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const allowedContentTypes = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
]);
const header = [
  'external_key',
  'arrival',
  'departure',
  'adults',
  'quantity',
  'product_code',
];
const unsafeFormula = /^[=+\-@]/;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9) return true;
  }
  return false;
}

export interface ImportInput {
  mode: 'DRY_RUN' | 'APPLY';
  source: 'UPLOAD' | 'FEED';
  file_name: string;
  content_type: string;
  content: string;
  external_id?: string | null;
}

interface ParsedRow {
  line_no: number;
  external_key: string | null;
  arrival: string;
  departure: string;
  adults: number;
  quantity: number;
  product_code: string | null;
  error_code: string | null;
}

function safeCell(value: string): boolean {
  return !unsafeFormula.test(value) && !hasControlChars(value);
}

function parseCsv(content: string): {
  rows: ParsedRow[];
  error: string | null;
} {
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { rows: [], error: 'EMPTY_FILE' };
  const headerCells = lines[0]!
    .split(',')
    .map((cell) => cell.trim().toLowerCase());
  if (
    headerCells.length !== header.length ||
    headerCells.some((cell, index) => cell !== header[index])
  )
    return { rows: [], error: 'INVALID_HEADER' };
  if (lines.length - 1 > MAX_ROWS) return { rows: [], error: 'TOO_MANY_ROWS' };
  const rows: ParsedRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index]!.split(',').map((cell) => cell.trim());
    const lineNo = index + 1;
    if (cells.length !== header.length) {
      rows.push({
        line_no: lineNo,
        external_key: null,
        arrival: '',
        departure: '',
        adults: 0,
        quantity: 0,
        product_code: null,
        error_code: 'COLUMN_COUNT',
      });
      continue;
    }
    const [
      externalKey,
      arrival,
      departure,
      adultsRaw,
      quantityRaw,
      productCode,
    ] = cells as [string, string, string, string, string, string];
    let errorCode: string | null = null;
    if (!safeCell(externalKey) || !safeCell(productCode ?? ''))
      errorCode = 'UNSAFE_CELL';
    else if (!/^[A-Za-z0-9._:-]{1,80}$/.test(externalKey))
      errorCode = 'INVALID_EXTERNAL_KEY';
    else {
      try {
        assertIsoDate(arrival, 'arrival');
        assertIsoDate(departure, 'departure');
        if (departure <= arrival) errorCode = 'INVALID_PERIOD';
      } catch {
        errorCode = 'INVALID_DATE';
      }
    }
    const adults = Number(adultsRaw);
    const quantity = Number(quantityRaw);
    if (!errorCode && (!Number.isInteger(adults) || adults < 1 || adults > 20))
      errorCode = 'INVALID_ADULTS';
    if (
      !errorCode &&
      (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
    )
      errorCode = 'INVALID_QUANTITY';
    rows.push({
      line_no: lineNo,
      external_key: externalKey,
      arrival,
      departure,
      adults,
      quantity,
      product_code: productCode === '' ? null : productCode,
      error_code: errorCode,
    });
  }
  return { rows, error: null };
}

async function findProductByCode(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  code: string,
): Promise<{ id: string; sharing_scope: string | null } | null> {
  return one<{ id: string; sharing_scope: string | null }>(
    em,
    `select "id", "sharing_scope" from "product"
      where "tenant_id" = ? and "property_id" = ? and "code" = ?`,
    [tenantId, propertyId, code],
  );
}

async function findImportByIdentity(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  externalKey: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        and "external_booking_key" = ?`,
    [tenantId, propertyId, externalKey],
  );
}

async function findExistingRun(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  fileHash: string,
  mode: ImportInput['mode'],
  source: ImportInput['source'],
): Promise<{ id: string; report_safe: Record<string, unknown> } | null> {
  return one<{ id: string; report_safe: Record<string, unknown> }>(
    em,
    `select "id", "report_safe" from "reservation_import_run"
      where "tenant_id" = ? and "property_id" = ? and "file_hash" = ?
        and "mode" = ? and "source" = ?`,
    [tenantId, propertyId, fileHash, mode, source],
  );
}

export async function importReservations(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ImportInput,
): Promise<Record<string, unknown>> {
  if (!allowedContentTypes.has(input.content_type))
    throw new PropertyError('INVALID_REQUEST', { field: 'content_type' });
  if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES)
    throw new PropertyError('LIMIT_EXCEEDED', { field: 'content' });
  const parsed = parseCsv(input.content);
  if (parsed.error)
    throw new PropertyError(
      parsed.error === 'TOO_MANY_ROWS' ? 'LIMIT_EXCEEDED' : 'INVALID_REQUEST',
      { field: 'content', reason: parsed.error },
    );
  const fileHash = createHash('sha256').update(input.content).digest('hex');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'reservation.create', propertyId);
      if (input.mode === 'APPLY')
        await lockProperty(em, context.tenantId, propertyId);
      const existingRun = await findExistingRun(
        em,
        context.tenantId,
        propertyId,
        fileHash,
        input.mode,
        input.source,
      );
      if (existingRun) return { ...existingRun.report_safe, replayed: true };
      const seen = new Set<string>();
      const results: Array<{
        line_no: number;
        external_key: string | null;
        status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
        error_code: string | null;
        reservation_id: string | null;
      }> = [];
      for (const row of parsed.rows) {
        let status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE' = 'ACCEPTED';
        let errorCode = row.error_code;
        let productId: string | null = null;
        let reservationId: string | null = null;
        if (!errorCode && row.external_key) {
          if (seen.has(row.external_key)) {
            status = 'REJECTED';
            errorCode = 'DUPLICATE_IN_FILE';
          } else {
            seen.add(row.external_key);
            const existing = await findImportByIdentity(
              em,
              context.tenantId,
              propertyId,
              row.external_key,
            );
            if (existing) {
              status = 'DUPLICATE';
              reservationId = existing.id;
            } else if (row.product_code) {
              const product = await findProductByCode(
                em,
                context.tenantId,
                propertyId,
                row.product_code,
              );
              if (!product) {
                status = 'REJECTED';
                errorCode = 'CROSS_SCOPE_REFERENCE';
              } else if (isRestrictedSharingScope(product.sharing_scope)) {
                // A CSV row carries no guests, so a FEMALE/MALE product can
                // never satisfy its declared sharing promise on import.
                status = 'REJECTED';
                errorCode = 'GUEST_GENDER_REQUIRED';
              } else productId = product.id;
            }
          }
        } else if (errorCode) {
          status = 'REJECTED';
        }
        if (
          status === 'ACCEPTED' &&
          input.mode === 'APPLY' &&
          row.external_key
        ) {
          const reservation = await repo.insertReservation(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            source: 'IMPORT',
            channelConnectionId: null,
            externalBookingKey: row.external_key,
            state: 'INQUIRY',
          });
          const item = await repo.insertReservationItem(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            reservationId: reservation.id,
            productId,
            arrival: row.arrival,
            departure: row.departure,
            adults: row.adults,
            childAges: [],
            quantity: row.quantity,
            state: 'INQUIRY',
          });
          await repo.insertStaySegment(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            itemId: item.id,
            startDate: row.arrival,
            endDate: row.departure,
          });
          reservationId = reservation.id;
        }
        results.push({
          line_no: row.line_no,
          external_key: row.external_key,
          status,
          error_code: errorCode,
          reservation_id: reservationId,
        });
      }
      const accepted = results.filter(
        (row) => row.status === 'ACCEPTED',
      ).length;
      const rejected = results.filter(
        (row) => row.status === 'REJECTED',
      ).length;
      const duplicate = results.filter(
        (row) => row.status === 'DUPLICATE',
      ).length;
      const report = {
        mode: input.mode,
        source: input.source,
        file_name: input.file_name,
        rows_total: parsed.rows.length,
        rows_accepted: accepted,
        rows_rejected: rejected,
        rows_duplicate: duplicate,
        rows: results.map((row) => ({
          line_no: row.line_no,
          external_key: row.external_key,
          status: row.status,
          error_code: row.error_code,
        })),
      };
      const runId = randomUUID();
      await em.execute(
        `insert into "reservation_import_run"
           ("id", "tenant_id", "property_id", "source", "mode", "file_name",
            "content_type", "file_hash", "external_id", "rows_total",
            "rows_accepted", "rows_rejected", "rows_duplicate", "report_safe",
            "created_by")
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
        [
          runId,
          context.tenantId,
          propertyId,
          input.source,
          input.mode,
          input.file_name,
          input.content_type,
          fileHash,
          input.external_id ?? null,
          parsed.rows.length,
          accepted,
          rejected,
          duplicate,
          JSON.stringify({ ...report, run_id: runId }),
          context.actor.userId,
        ] as never[],
      );
      for (const row of results)
        await em.execute(
          `insert into "reservation_import_row"
             ("id", "tenant_id", "property_id", "run_id", "line_no",
              "external_key", "status", "error_code", "reservation_id")
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            context.tenantId,
            propertyId,
            runId,
            row.line_no,
            row.external_key,
            row.status,
            row.error_code,
            row.reservation_id,
          ] as never[],
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.import_run',
        resourceType: 'ReservationImportRun',
        resourceId: runId,
        outcome: 'SUCCESS',
        afterSafe: {
          mode: input.mode,
          source: input.source,
          rows_total: parsed.rows.length,
          rows_accepted: accepted,
          rows_rejected: rejected,
          rows_duplicate: duplicate,
        },
        correlationId: context.correlationId,
      });
      return { ...report, run_id: runId, replayed: false };
    },
  );
}
