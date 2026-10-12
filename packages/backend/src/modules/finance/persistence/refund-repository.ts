import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { normalizeMoney } from '../domain/money.js';

export interface FolioRefundRow {
  id: string;
  tenant_id: string;
  property_id: string;
  payment_id: string;
  folio_id: string;
  currency: string;
  amount: string;
  reason: string;
  state: string;
  approval_id: string | null;
  journal_id: string | null;
  evidence_ref: string | null;
  external_reference: string | null;
  reconciliation_reference: string | null;
  created_at: Date;
}

export interface FxSnapshotRow {
  id: string;
  pair: string;
  rate: string;
  effective_at: Date;
  source: string;
  approval_id: string;
  recorded_by: string | null;
  created_at: Date;
}

export async function insertRefund(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    paymentId: string;
    folioId: string;
    currency: string;
    amount: string;
    reason: string;
    correlationId: string | null;
  },
): Promise<FolioRefundRow> {
  const inserted = await one<FolioRefundRow>(
    em,
    `insert into "folio_refund" (
       "tenant_id", "property_id", "payment_id", "folio_id", "currency",
       "amount", "reason", "state", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.paymentId,
      input.folioId,
      input.currency,
      input.amount,
      input.reason,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('refund insert returned no row');
  return inserted;
}

export async function attachRefundApproval(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  refundId: string,
  approvalId: string,
): Promise<void> {
  await em.execute(
    `update "folio_refund" set "approval_id" = ?, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [approvalId, refundId, tenantId, propertyId] as never[],
  );
}

export async function findRefund(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  refundId: string,
): Promise<FolioRefundRow | null> {
  return one<FolioRefundRow>(
    em,
    `select * from "folio_refund"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [refundId, tenantId, propertyId],
  );
}

export async function listRefundsForPayment(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  paymentId: string,
): Promise<FolioRefundRow[]> {
  return rows<FolioRefundRow>(
    em,
    `select * from "folio_refund"
      where "tenant_id" = ? and "property_id" = ? and "payment_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, paymentId],
  );
}

export async function listRefundsForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioRefundRow[]> {
  return rows<FolioRefundRow>(
    em,
    `select * from "folio_refund"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function advanceRefund(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    refundId: string;
    fromStates: string[];
    state: string;
    journalId: string | null;
    evidenceRef: string | null;
    externalReference: string | null;
    reconciliationReference: string | null;
  },
): Promise<FolioRefundRow | null> {
  const placeholders = input.fromStates.map(() => '?').join(', ');
  return one<FolioRefundRow>(
    em,
    `update "folio_refund"
        set "state" = ?, "journal_id" = ?, "evidence_ref" = ?,
            "external_reference" = ?, "reconciliation_reference" = ?,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" in (${placeholders})
      returning *`,
    [
      input.state,
      input.journalId,
      input.evidenceRef,
      input.externalReference,
      input.reconciliationReference,
      input.refundId,
      input.tenantId,
      input.propertyId,
      ...input.fromStates,
    ] as never[],
  );
}

export async function insertFxSnapshot(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    pair: string;
    rate: string;
    effectiveAt: string;
    source: string;
    approvalId: string;
    recordedBy: string | null;
    correlationId: string | null;
  },
): Promise<FxSnapshotRow> {
  const inserted = await one<FxSnapshotRow>(
    em,
    `insert into "fx_snapshot" (
       "tenant_id", "property_id", "pair", "rate", "effective_at", "source",
       "approval_id", "recorded_by", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.pair,
      input.rate,
      input.effectiveAt,
      input.source,
      input.approvalId,
      input.recordedBy,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('fx snapshot insert returned no row');
  return inserted;
}

export async function listFxSnapshotRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<FxSnapshotRow[]> {
  return rows<FxSnapshotRow>(
    em,
    `select * from "fx_snapshot"
      where "tenant_id" = ? and "property_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId],
  );
}

export function refundView(row: FolioRefundRow) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    folio_id: row.folio_id,
    currency: row.currency,
    amount: normalizeMoney(row.amount),
    reason: row.reason,
    state: row.state,
    approval_id: row.approval_id,
    journal_id: row.journal_id,
    evidence_ref: row.evidence_ref,
    external_reference: row.external_reference,
    reconciliation_reference: row.reconciliation_reference,
  };
}

export function fxView(row: FxSnapshotRow) {
  return {
    id: row.id,
    pair: row.pair,
    rate: row.rate,
    effective_at: row.effective_at,
    source: row.source,
    approval_id: row.approval_id,
  };
}
