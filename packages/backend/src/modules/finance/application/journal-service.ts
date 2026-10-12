import type { EntityManager } from '@mikro-orm/postgresql';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import {
  databaseErrorCode,
  translatePropertyWrite,
} from '../../property/persistence/db.js';
import {
  assertCurrency,
  formatMoney,
  planPostingLines,
  sumIntermediate,
} from '../domain/money.js';
import type { LineSide } from '../domain/money.js';
import * as repo from '../persistence/finance-repository.js';
import type {
  JournalLineRow,
  JournalRow,
} from '../persistence/finance-repository.js';
import { requireOpenBusinessDay } from './business-day-service.js';

export interface PostJournalLineInput {
  account_code: string;
  side: LineSide;
  amount: bigint;
}

export interface PostJournalInput {
  tenantId: string;
  propertyId: string;
  businessDate: string;
  timezone: string;
  currency: string;
  sourceType: string;
  sourceId: string | null;
  reversalOfId?: string | null;
  adjustsJournalId?: string | null;
  memo?: string | null;
  correlationId?: string | null;
  actor: {
    actorType: 'USER' | 'SERVICE';
    actorId: string | null;
    actorLabel: string | null;
  };
  lines: readonly PostJournalLineInput[];
}

const sourceTypePattern = /^[A-Z][A-Z0-9_]{2,31}$/;

export interface PostedJournal {
  journal: JournalRow;
  lines: JournalLineRow[];
}

/**
 * Posts one balanced double-entry journal in a single transaction. The caller
 * must already hold the property lock (all financial producers run under the
 * same per-property serialisation). Intermediate amounts are summed at six
 * decimals; posting rounds HALF_UP per line to two decimals and declares any
 * rounding residual. Posted rows have no UPDATE/DELETE grant for operational
 * roles, so immutability is enforced by the database.
 */
export async function postJournal(
  em: EntityManager,
  input: PostJournalInput,
): Promise<PostedJournal> {
  assertIsoDate(input.businessDate, 'business_date');
  const currency = assertCurrency(input.currency);
  if (!sourceTypePattern.test(input.sourceType))
    throw new PropertyError('INVALID_REQUEST', { field: 'source_type' });
  if (input.lines.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'lines' });
  const debitTotal = sumIntermediate(
    input.lines
      .filter((line) => line.side === 'DEBIT')
      .map((line) => line.amount),
  );
  const creditTotal = sumIntermediate(
    input.lines
      .filter((line) => line.side === 'CREDIT')
      .map((line) => line.amount),
  );
  if (debitTotal !== creditTotal)
    throw new PropertyError('JOURNAL_UNBALANCED', {
      total_debit: formatMoney(debitTotal),
      total_credit: formatMoney(creditTotal),
    });
  await requireOpenBusinessDay(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    date: input.businessDate,
    timezone: input.timezone,
  });
  if (input.sourceId) {
    const existing = await repo.findJournalForSource(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    if (existing)
      throw new PropertyError('SOURCE_ALREADY_POSTED', {
        source_type: input.sourceType,
        source_id: input.sourceId,
        journal_id: existing.id,
      });
  }
  const plan = planPostingLines(input.lines);
  let journal: JournalRow;
  try {
    journal = await repo.insertJournal(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      businessDate: input.businessDate,
      currency,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversalOfId: input.reversalOfId ?? null,
      adjustsJournalId: input.adjustsJournalId ?? null,
      memo: input.memo ?? null,
      totalDebit: plan.total_debit,
      totalCredit: plan.total_credit,
      correlationId: input.correlationId ?? null,
    });
  } catch (error) {
    if (databaseErrorCode(error) === '23505' && input.sourceId)
      throw new PropertyError('SOURCE_ALREADY_POSTED', {
        source_type: input.sourceType,
        source_id: input.sourceId,
      });
    throw error;
  }
  const lines = await translatePropertyWrite(() =>
    repo.insertJournalLines(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      journalId: journal.id,
      lines: plan.lines,
    }),
  );
  await recordAudit(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    actorLabel: input.actor.actorLabel,
    action: 'finance.journal_posted',
    resourceType: 'journal',
    resourceId: journal.id,
    outcome: 'SUCCESS',
    afterSafe: {
      business_date: journal.business_date,
      currency: journal.currency,
      source_type: journal.source_type,
      total_debit: journal.total_debit,
      total_credit: journal.total_credit,
    },
    correlationId: input.correlationId ?? null,
  });
  return { journal, lines };
}
