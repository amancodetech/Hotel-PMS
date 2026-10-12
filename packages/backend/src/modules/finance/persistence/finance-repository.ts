import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type { PostingLine } from '../domain/money.js';
import { normalizeMoney } from '../domain/money.js';

export interface BusinessDayRow {
  id: string;
  tenant_id: string;
  property_id: string;
  business_date: string;
  state: string;
  version: number;
  opened_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface JournalRow {
  id: string;
  tenant_id: string;
  property_id: string;
  business_date: string;
  currency: string;
  source_type: string;
  source_id: string | null;
  reversal_of_id: string | null;
  adjusts_journal_id: string | null;
  state: string;
  memo: string | null;
  total_debit: string;
  total_credit: string;
  correlation_id: string | null;
  posted_at: Date;
  created_at: Date;
}

export interface JournalLineRow {
  id: string;
  tenant_id: string;
  property_id: string;
  journal_id: string;
  line_no: number;
  account_code: string;
  debit: string;
  credit: string;
  memo: string | null;
}

export async function findBusinessDay(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  date: string,
): Promise<BusinessDayRow | null> {
  return one<BusinessDayRow>(
    em,
    `select * from "business_day"
      where "tenant_id" = ? and "property_id" = ? and "business_date" = ?`,
    [tenantId, propertyId, date],
  );
}

export async function findActiveBusinessDay(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BusinessDayRow | null> {
  return one<BusinessDayRow>(
    em,
    `select * from "business_day"
      where "tenant_id" = ? and "property_id" = ? and "state" <> 'CLOSED'
      ${options.forUpdate ? 'for update' : ''}`,
    [tenantId, propertyId],
  );
}

export async function insertBusinessDay(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; date: string },
): Promise<BusinessDayRow | null> {
  return one<BusinessDayRow>(
    em,
    `insert into "business_day" ("tenant_id", "property_id", "business_date", "state")
     values (?, ?, ?, 'OPEN')
     on conflict ("tenant_id", "property_id", "business_date") do nothing
     returning *`,
    [input.tenantId, input.propertyId, input.date],
  );
}

export async function advanceBusinessDay(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    id: string;
    fromState: string;
    toState: string;
    closedAt: Date | null;
  },
): Promise<BusinessDayRow | null> {
  return one<BusinessDayRow>(
    em,
    `update "business_day"
        set "state" = ?, "version" = "version" + 1,
            "closed_at" = ?, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = ?
      returning *`,
    [
      input.toState,
      input.closedAt,
      input.id,
      input.tenantId,
      input.propertyId,
      input.fromState,
    ],
  );
}

export async function insertJournal(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    businessDate: string;
    currency: string;
    sourceType: string;
    sourceId: string | null;
    reversalOfId: string | null;
    adjustsJournalId: string | null;
    memo: string | null;
    totalDebit: string;
    totalCredit: string;
    correlationId: string | null;
  },
): Promise<JournalRow> {
  const inserted = await one<JournalRow>(
    em,
    `insert into "journal" (
       "tenant_id", "property_id", "business_date", "currency", "source_type",
       "source_id", "reversal_of_id", "adjusts_journal_id", "state", "memo",
       "total_debit", "total_credit", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.businessDate,
      input.currency,
      input.sourceType,
      input.sourceId,
      input.reversalOfId,
      input.adjustsJournalId,
      input.memo,
      input.totalDebit,
      input.totalCredit,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('journal insert returned no row');
  return inserted;
}

export async function insertJournalLines(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    journalId: string;
    lines: readonly PostingLine[];
    memo?: string | null;
  },
): Promise<JournalLineRow[]> {
  const inserted: JournalLineRow[] = [];
  let lineNo = 1;
  for (const line of input.lines) {
    const row = await one<JournalLineRow>(
      em,
      `insert into "journal_line" (
         "tenant_id", "property_id", "journal_id", "line_no", "account_code",
         "debit", "credit", "memo"
       ) values (?, ?, ?, ?, ?, ?, ?, ?)
       returning *`,
      [
        input.tenantId,
        input.propertyId,
        input.journalId,
        lineNo,
        line.account_code,
        line.debit,
        line.credit,
        input.memo ?? null,
      ],
    );
    if (!row) throw new Error('journal line insert returned no row');
    inserted.push(row);
    lineNo += 1;
  }
  return inserted;
}

export async function listJournalLines(
  em: EntityManager,
  journalId: string,
): Promise<JournalLineRow[]> {
  return rows<JournalLineRow>(
    em,
    `select * from "journal_line" where "journal_id" = ? order by "line_no"`,
    [journalId],
  );
}

export async function findJournalForSource(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    sourceType: string;
    sourceId: string;
  },
): Promise<JournalRow | null> {
  return one<JournalRow>(
    em,
    `select * from "journal"
      where "tenant_id" = ? and "property_id" = ? and "source_type" = ?
        and "source_id" = ?`,
    [input.tenantId, input.propertyId, input.sourceType, input.sourceId],
  );
}

export function journalView(row: JournalRow) {
  return {
    id: row.id,
    business_date: row.business_date,
    currency: row.currency,
    source_type: row.source_type,
    source_id: row.source_id,
    reversal_of_id: row.reversal_of_id,
    adjusts_journal_id: row.adjusts_journal_id,
    state: row.state,
    memo: row.memo,
    total_debit: normalizeMoney(row.total_debit),
    total_credit: normalizeMoney(row.total_credit),
    correlation_id: row.correlation_id,
    posted_at: row.posted_at,
  };
}

export function lineView(row: JournalLineRow) {
  return {
    line_no: row.line_no,
    account_code: row.account_code,
    debit: row.debit,
    credit: row.credit,
  };
}

export function businessDayView(row: BusinessDayRow) {
  return {
    id: row.id,
    business_date: row.business_date,
    state: row.state,
    version: row.version,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
  };
}

export function postingMemo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : toJson(value);
}
