import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { formatDecimal, parseDecimal } from '../../inventory/domain/pricing.js';

export interface InvoiceCounterRow {
  id: string;
  series: string;
  kind: string;
  approved: boolean;
  next_number: string;
}

export interface InvoiceRow {
  id: string;
  folio_id: string;
  series: string;
  number: string;
  kind: string;
  currency: string;
  net_amount: string;
  tax_amount: string;
  total_amount: string;
  tax_policy: Record<string, unknown>;
  account_code: string;
  state: string;
  source_ref: string;
  business_date: string;
  journal_id: string | null;
  issued_at: Date;
}

export interface CreditNoteRow {
  id: string;
  invoice_id: string;
  series: string;
  number: string;
  currency: string;
  amount: string;
  reason: string;
  source_ref: string;
  journal_id: string;
  issued_at: Date;
}

export interface CashierSessionRow {
  id: string;
  currency: string;
  state: string;
  opening_float: string;
  expected_amount: string | null;
  counted_amount: string | null;
  variance: string | null;
  opened_at: Date;
  counted_at: Date | null;
  closed_at: Date | null;
  version: number;
}

export async function ensureInvoiceCounter(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    series: string;
    kind: string;
  },
): Promise<InvoiceCounterRow> {
  await em.execute(
    `insert into "invoice_counter" ("tenant_id", "property_id", "series", "kind")
     values (?, ?, ?, ?)
     on conflict ("tenant_id", "property_id", "series") do nothing`,
    [input.tenantId, input.propertyId, input.series, input.kind] as never[],
  );
  const counter = await one<InvoiceCounterRow>(
    em,
    `select * from "invoice_counter"
      where "tenant_id" = ? and "property_id" = ? and "series" = ?
      for update`,
    [input.tenantId, input.propertyId, input.series],
  );
  if (!counter) throw new Error('invoice counter missing');
  return counter;
}

export async function consumeInvoiceNumber(
  em: EntityManager,
  counterId: string,
): Promise<string> {
  const updated = await one<{ next_number: string }>(
    em,
    `update "invoice_counter"
        set "next_number" = "next_number" + 1, "updated_at" = now()
      where "id" = ?
      returning "next_number" - 1 as "next_number"`,
    [counterId],
  );
  if (!updated) throw new Error('invoice counter update failed');
  return updated.next_number;
}

export async function insertInvoice(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    series: string;
    number: string;
    kind: string;
    currency: string;
    netAmount: string;
    taxAmount: string;
    totalAmount: string;
    taxPolicy: Record<string, unknown>;
    accountCode: string;
    sourceRef: string;
    businessDate: string;
    correlationId: string | null;
  },
): Promise<InvoiceRow> {
  const inserted = await one<InvoiceRow>(
    em,
    `insert into "folio_invoice" (
       "tenant_id", "property_id", "folio_id", "series", "number", "kind",
       "currency", "net_amount", "tax_amount", "total_amount", "tax_policy",
       "account_code", "source_ref", "business_date", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.series,
      input.number,
      input.kind,
      input.currency,
      input.netAmount,
      input.taxAmount,
      input.totalAmount,
      JSON.stringify(input.taxPolicy ?? {}),
      input.accountCode,
      input.sourceRef,
      input.businessDate,
      input.correlationId,
    ] as never[],
  );
  if (!inserted) throw new Error('invoice insert returned no row');
  return inserted;
}

export async function findInvoice(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  return one<InvoiceRow>(
    em,
    `select * from "folio_invoice"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [invoiceId, tenantId, propertyId],
  );
}

export async function listInvoiceRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string | null,
): Promise<InvoiceRow[]> {
  return rows<InvoiceRow>(
    em,
    `select * from "folio_invoice"
      where "tenant_id" = ? and "property_id" = ?
        and (?::uuid is null or "folio_id" = ?::uuid)
      order by "issued_at", "id"`,
    [tenantId, propertyId, folioId, folioId],
  );
}

export async function sumIssuedCreditNotes(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  invoiceId: string,
): Promise<bigint> {
  const result = await one<{ total: string }>(
    em,
    `select coalesce(sum("amount"), 0)::text as "total"
       from "folio_credit_note"
      where "tenant_id" = ? and "property_id" = ? and "invoice_id" = ?`,
    [tenantId, propertyId, invoiceId],
  );
  return parseDecimal(result?.total ?? '0', 'amount');
}

export async function insertCreditNote(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    invoiceId: string;
    series: string;
    number: string;
    currency: string;
    amount: string;
    reason: string;
    sourceRef: string;
    journalId: string;
  },
): Promise<CreditNoteRow> {
  const inserted = await one<CreditNoteRow>(
    em,
    `insert into "folio_credit_note" (
       "tenant_id", "property_id", "invoice_id", "series", "number",
       "currency", "amount", "reason", "source_ref", "journal_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.invoiceId,
      input.series,
      input.number,
      input.currency,
      input.amount,
      input.reason,
      input.sourceRef,
      input.journalId,
    ] as never[],
  );
  if (!inserted) throw new Error('credit note insert returned no row');
  return inserted;
}

export async function listCreditNotesForInvoice(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  invoiceId: string,
): Promise<CreditNoteRow[]> {
  return rows<CreditNoteRow>(
    em,
    `select * from "folio_credit_note"
      where "tenant_id" = ? and "property_id" = ? and "invoice_id" = ?
      order by "issued_at", "id"`,
    [tenantId, propertyId, invoiceId],
  );
}

export async function insertCashierSession(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    currency: string;
    openingFloat: string;
    openedBy: string | null;
  },
): Promise<CashierSessionRow> {
  const inserted = await one<CashierSessionRow>(
    em,
    `insert into "cashier_session" (
       "tenant_id", "property_id", "currency", "opening_float", "opened_by"
     ) values (?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.currency,
      input.openingFloat,
      input.openedBy,
    ] as never[],
  );
  if (!inserted) throw new Error('cashier session insert returned no row');
  return inserted;
}

export async function findCashierSession(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  sessionId: string,
): Promise<CashierSessionRow | null> {
  return one<CashierSessionRow>(
    em,
    `select * from "cashier_session"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [sessionId, tenantId, propertyId],
  );
}

export async function listCashierSessionRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<CashierSessionRow[]> {
  return rows<CashierSessionRow>(
    em,
    `select * from "cashier_session"
      where "tenant_id" = ? and "property_id" = ?
      order by "opened_at", "id"`,
    [tenantId, propertyId],
  );
}

export async function cashierExpectedAmount(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  sessionOpenedAt: Date,
): Promise<bigint> {
  const cashPayments = await one<{ total: string }>(
    em,
    `select coalesce(sum("amount"), 0)::text as "total"
       from "folio_payment"
      where "tenant_id" = ? and "property_id" = ? and "currency" = ?
        and "method" = 'CASH' and "state" = 'SUCCEEDED'
        and "created_at" >= ?`,
    [tenantId, propertyId, currency, sessionOpenedAt] as never[],
  );
  const cashDeposits = await one<{ total: string }>(
    em,
    `select coalesce(sum("amount"), 0)::text as "total"
       from "folio_deposit"
      where "tenant_id" = ? and "property_id" = ? and "currency" = ?
        and "method" = 'CASH' and "created_at" >= ?`,
    [tenantId, propertyId, currency, sessionOpenedAt] as never[],
  );
  const cashRefunds = await one<{ total: string }>(
    em,
    `select coalesce(sum(r."amount"), 0)::text as "total"
       from "folio_refund" r join "folio_payment" p on p."id" = r."payment_id"
      where r."tenant_id" = ? and r."property_id" = ? and r."currency" = ?
        and r."state" = 'SUCCEEDED' and p."method" = 'CASH'
        and r."updated_at" >= ?`,
    [tenantId, propertyId, currency, sessionOpenedAt] as never[],
  );
  return (
    parseDecimal(cashPayments?.total ?? '0', 'amount') +
    parseDecimal(cashDeposits?.total ?? '0', 'amount') -
    parseDecimal(cashRefunds?.total ?? '0', 'amount')
  );
}

export async function reconcileCashierSession(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    sessionId: string;
    expected: string;
    counted: string;
    variance: string;
    countedBy: string | null;
  },
): Promise<CashierSessionRow | null> {
  return one<CashierSessionRow>(
    em,
    `update "cashier_session"
        set "state" = 'RECONCILED', "expected_amount" = ?, "counted_amount" = ?,
            "variance" = ?, "counted_by" = ?, "counted_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" in ('OPEN', 'COUNTING')
      returning *`,
    [
      input.expected,
      input.counted,
      input.variance,
      input.countedBy,
      input.sessionId,
      input.tenantId,
      input.propertyId,
    ] as never[],
  );
}

export async function closeCashierSessionRow(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    sessionId: string;
    closedBy: string | null;
  },
): Promise<CashierSessionRow | null> {
  return one<CashierSessionRow>(
    em,
    `update "cashier_session"
        set "state" = 'CLOSED', "closed_by" = ?, "closed_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'RECONCILED'
      returning *`,
    [
      input.closedBy,
      input.sessionId,
      input.tenantId,
      input.propertyId,
    ] as never[],
  );
}

function normalize(value: string, allowNegative = false): string {
  return formatDecimal(parseDecimal(value, 'amount', { allowNegative }));
}

export function invoiceView(row: InvoiceRow) {
  return {
    id: row.id,
    folio_id: row.folio_id,
    series: row.series,
    number: row.number,
    kind: row.kind,
    currency: row.currency,
    net_amount: normalize(row.net_amount),
    tax_amount: normalize(row.tax_amount),
    total_amount: normalize(row.total_amount),
    tax_policy: row.tax_policy,
    account_code: row.account_code,
    state: row.state,
    source_ref: row.source_ref,
    business_date: row.business_date,
    journal_id: row.journal_id,
    issued_at: row.issued_at,
  };
}

export function creditNoteView(row: CreditNoteRow) {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    series: row.series,
    number: row.number,
    currency: row.currency,
    amount: normalize(row.amount),
    reason: row.reason,
    source_ref: row.source_ref,
    journal_id: row.journal_id,
    issued_at: row.issued_at,
  };
}

export function cashierView(row: CashierSessionRow) {
  return {
    id: row.id,
    currency: row.currency,
    state: row.state,
    opening_float: normalize(row.opening_float),
    expected_amount:
      row.expected_amount === null ? null : normalize(row.expected_amount),
    counted_amount:
      row.counted_amount === null ? null : normalize(row.counted_amount),
    variance: row.variance === null ? null : normalize(row.variance, true),
    opened_at: row.opened_at,
    counted_at: row.counted_at,
    closed_at: row.closed_at,
    version: row.version,
  };
}
