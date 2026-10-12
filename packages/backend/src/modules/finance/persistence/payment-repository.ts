import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { normalizeMoney } from '../domain/money.js';

export interface FolioPaymentRow {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  method: string;
  currency: string;
  amount: string;
  gross_amount: string | null;
  commission_amount: string | null;
  business_date: string;
  external_reference: string;
  evidence_ref: string | null;
  source_ref: string;
  state: string;
  journal_id: string | null;
  reconciled_at: Date | null;
  reconciliation_reference: string | null;
  created_at: Date;
}

export async function insertPayment(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    method: string;
    currency: string;
    amount: string;
    grossAmount: string | null;
    commissionAmount: string | null;
    businessDate: string;
    externalReference: string;
    evidenceRef: string | null;
    sourceRef: string;
    state: string;
    journalId: string | null;
    correlationId: string | null;
  },
): Promise<FolioPaymentRow> {
  const inserted = await one<FolioPaymentRow>(
    em,
    `insert into "folio_payment" (
       "tenant_id", "property_id", "folio_id", "method", "currency", "amount",
       "gross_amount", "commission_amount", "business_date", "external_reference",
       "evidence_ref", "source_ref", "state", "journal_id", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.method,
      input.currency,
      input.amount,
      input.grossAmount,
      input.commissionAmount,
      input.businessDate,
      input.externalReference,
      input.evidenceRef,
      input.sourceRef,
      input.state,
      input.journalId,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('payment insert returned no row');
  return inserted;
}

export async function findPayment(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  paymentId: string,
): Promise<FolioPaymentRow | null> {
  return one<FolioPaymentRow>(
    em,
    `select * from "folio_payment"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [paymentId, tenantId, propertyId],
  );
}

export async function findPaymentBySource(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  sourceRef: string,
): Promise<FolioPaymentRow | null> {
  return one<FolioPaymentRow>(
    em,
    `select * from "folio_payment"
      where "tenant_id" = ? and "property_id" = ? and "source_ref" = ?`,
    [tenantId, propertyId, sourceRef],
  );
}

export async function listPaymentsForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioPaymentRow[]> {
  return rows<FolioPaymentRow>(
    em,
    `select * from "folio_payment"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function listPaymentRows(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    state?: string | null;
    folioId?: string | null;
  },
): Promise<FolioPaymentRow[]> {
  return rows<FolioPaymentRow>(
    em,
    `select * from "folio_payment"
      where "tenant_id" = ? and "property_id" = ?
        and (?::text is null or "state" = ?::text)
        and (?::uuid is null or "folio_id" = ?::uuid)
      order by "created_at", "id"`,
    [
      input.tenantId,
      input.propertyId,
      input.state ?? null,
      input.state ?? null,
      input.folioId ?? null,
      input.folioId ?? null,
    ],
  );
}

export async function resolvePayment(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    paymentId: string;
    state: string;
    journalId: string | null;
    reconciliationReference: string | null;
  },
): Promise<FolioPaymentRow | null> {
  return one<FolioPaymentRow>(
    em,
    `update "folio_payment"
        set "state" = ?, "journal_id" = ?, "reconciled_at" = now(),
            "reconciliation_reference" = ?, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'UNKNOWN'
      returning *`,
    [
      input.state,
      input.journalId,
      input.reconciliationReference,
      input.paymentId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export function paymentView(row: FolioPaymentRow) {
  return {
    id: row.id,
    folio_id: row.folio_id,
    method: row.method,
    currency: row.currency,
    amount: normalizeMoney(row.amount),
    gross_amount:
      row.gross_amount === null ? null : normalizeMoney(row.gross_amount),
    commission_amount:
      row.commission_amount === null
        ? null
        : normalizeMoney(row.commission_amount),
    business_date: row.business_date,
    external_reference: row.external_reference,
    evidence_ref: row.evidence_ref,
    source_ref: row.source_ref,
    state: row.state,
    journal_id: row.journal_id,
    reconciled_at: row.reconciled_at,
  };
}
