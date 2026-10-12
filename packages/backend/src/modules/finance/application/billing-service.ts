import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import {
  databaseErrorCode,
  translatePropertyWrite,
} from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { findPropertyScope } from '../../reservations/persistence/reservation-repository.js';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import { financeAccounts } from '../domain/accounts.js';
import {
  assertMoneyCurrency,
  formatMoney,
  normalizeMoney,
  parsePositiveMoney,
  roundPosting,
} from '../domain/money.js';
import * as billing from '../persistence/billing-repository.js';
import * as folioRepo from '../persistence/folio-repository.js';
import { reopenClearanceForFolios } from './clearance-service.js';
import { postJournal } from './journal-service.js';

async function auditActor(context: ServiceContext) {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

function postableMoney(value: unknown, field: string) {
  const parsed = parsePositiveMoney(value, field);
  const rounded = roundPosting(parsed);
  if (rounded <= 0n)
    throw new PropertyError('FRACTION_NOT_SUPPORTED', {
      field,
      reason: 'rounds_to_zero',
    });
  return { scaled: rounded, formatted: formatMoney(rounded) };
}

function nonNegativeMoney(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,6})?$/.test(value))
    throw new PropertyError('INVALID_REQUEST', { field });
  const rounded = roundPosting(parseDecimal(value, field));
  if (rounded < 0n) throw new PropertyError('INVALID_REQUEST', { field });
  return { scaled: rounded, formatted: formatMoney(rounded) };
}

async function withBillingOperation<T extends Record<string, unknown>>(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  permission: 'invoice.issue' | 'cashier.operate',
  operation: string,
  keyRaw: string | null | undefined,
  request: Record<string, unknown>,
  work: (em: EntityManager, timezone: string) => Promise<T>,
): Promise<T> {
  const key = requireIdempotencyKey(keyRaw);
  const requestHashValue = hashRequest({
    operation,
    property_id: propertyId,
    ...request,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, permission, propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        operation,
        key,
        requestHashValue,
        propertyId,
      );
      if (replayed) return replayed as unknown as T;
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const result = await work(em, property.timezone);
      await storeIdempotency(em, context, {
        propertyId,
        operation,
        key,
        requestHash: requestHashValue,
        response: result,
        resourceId: typeof result.id === 'string' ? result.id : null,
      });
      return result;
    },
  );
}

async function nextNumber(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  series: string,
  kind: string,
): Promise<string> {
  const counter = await translatePropertyWrite(() =>
    billing.ensureInvoiceCounter(em, { tenantId, propertyId, series, kind }),
  );
  if (counter.kind !== kind)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'kind',
      reason: 'series_kind_mismatch',
    });
  if (kind === 'PRODUCTION' && !counter.approved)
    throw new PropertyError('EX03_NOT_APPROVED', { series });
  return translatePropertyWrite(() =>
    billing.consumeInvoiceNumber(em, counter.id),
  );
}

export async function issueInvoice(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    folio_id: string;
    series: string;
    kind?: 'SYNTHETIC' | 'PRODUCTION';
    source_ref: string;
    business_date: string;
    net_money: string;
    net_money_currency?: string | null;
    tax_money?: string | null;
    tax_money_currency?: string | null;
    tax_policy?: Record<string, unknown> | null;
    account_code?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const series = assertSafeText(input.series, 'series', 8).toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(series))
    throw new PropertyError('INVALID_REQUEST', { field: 'series' });
  const kind = input.kind ?? 'SYNTHETIC';
  const net = postableMoney(input.net_money, 'net_money');
  const tax =
    input.tax_money == null
      ? null
      : postableMoney(input.tax_money, 'tax_money');
  const taxScaled = tax?.scaled ?? 0n;
  const total = net.scaled + taxScaled;
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  return withBillingOperation(
    orm,
    context,
    propertyId,
    'invoice.issue',
    'IssueInvoice',
    input.idempotencyKey,
    {
      folio_id: input.folio_id,
      series,
      kind,
      source_ref: sourceRef,
      business_date: input.business_date,
    },
    async (em) => {
      const folio = await folioRepo.findFolio(
        em,
        context.tenantId,
        propertyId,
        input.folio_id,
      );
      if (!folio) throw new PropertyError('NOT_FOUND');
      assertMoneyCurrency(
        input.net_money_currency,
        folio.currency,
        'money.currency',
      );
      assertMoneyCurrency(
        input.tax_money_currency,
        folio.currency,
        'tax_money.currency',
      );
      const number = await nextNumber(
        em,
        context.tenantId,
        propertyId,
        series,
        kind,
      );
      let invoice;
      try {
        invoice = await billing.insertInvoice(em, {
          tenantId: context.tenantId,
          propertyId,
          folioId: folio.id,
          series,
          number,
          kind,
          currency: folio.currency,
          netAmount: net.formatted,
          taxAmount: tax?.formatted ?? '0',
          totalAmount: formatMoney(total),
          taxPolicy: input.tax_policy ?? {},
          accountCode: input.account_code ?? financeAccounts.REVENUE_OTHER,
          sourceRef,
          businessDate: input.business_date,
          correlationId: context.correlationId,
        });
      } catch (error) {
        if (databaseErrorCode(error) === '23505')
          throw new PropertyError('SOURCE_ALREADY_POSTED', {
            source_ref: sourceRef,
          });
        throw error;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.invoice_issued',
        resourceType: 'folio_invoice',
        resourceId: invoice.id,
        outcome: 'SUCCESS',
        afterSafe: { series, number, kind, total_amount: invoice.total_amount },
        correlationId: context.correlationId,
      });
      return billing.invoiceView(invoice);
    },
  );
}

export async function issueCreditNote(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  invoiceId: string,
  input: {
    money: string;
    money_currency?: string | null;
    reason: string;
    source_ref: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const amount = postableMoney(input.money, 'money');
  const reason = assertSafeText(input.reason, 'reason', 500);
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  return withBillingOperation(
    orm,
    context,
    propertyId,
    'invoice.issue',
    'IssueCreditNote',
    input.idempotencyKey,
    { invoice_id: invoiceId, money: amount.formatted, source_ref: sourceRef },
    async (em, timezone) => {
      const invoice = await billing.findInvoice(
        em,
        context.tenantId,
        propertyId,
        invoiceId,
      );
      if (!invoice) throw new PropertyError('NOT_FOUND');
      assertMoneyCurrency(
        input.money_currency,
        invoice.currency,
        'money.currency',
      );
      const credited = await billing.sumIssuedCreditNotes(
        em,
        context.tenantId,
        propertyId,
        invoiceId,
      );
      const total = parseDecimal(invoice.total_amount, 'amount');
      if (credited + amount.scaled > total)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'money',
          reason: 'credit_note_exceeds_invoice',
          remaining: formatMoney(total - credited),
        });
      const number = await nextNumber(
        em,
        context.tenantId,
        propertyId,
        'CN',
        invoice.kind,
      );
      const { journal } = await postJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        businessDate: businessToday(timezone),
        timezone,
        currency: invoice.currency,
        sourceType: 'CREDIT_NOTE',
        sourceId: null,
        memo: reason,
        correlationId: context.correlationId,
        actor: await auditActor(context),
        lines: [
          {
            account_code: invoice.account_code,
            side: 'DEBIT',
            amount: amount.scaled,
          },
          {
            account_code: financeAccounts.GUEST_FOLIO,
            side: 'CREDIT',
            amount: amount.scaled,
          },
        ],
      });
      let note;
      try {
        note = await billing.insertCreditNote(em, {
          tenantId: context.tenantId,
          propertyId,
          invoiceId,
          series: 'CN',
          number,
          currency: invoice.currency,
          amount: amount.formatted,
          reason,
          sourceRef,
          journalId: journal.id,
        });
      } catch (error) {
        if (databaseErrorCode(error) === '23505')
          throw new PropertyError('SOURCE_ALREADY_POSTED', {
            source_ref: sourceRef,
          });
        throw error;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.credit_note_issued',
        resourceType: 'folio_credit_note',
        resourceId: note.id,
        outcome: 'SUCCESS',
        afterSafe: {
          invoice_id: invoiceId,
          number,
          amount: note.amount,
          journal_id: journal.id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        invoice.folio_id,
      ]);
      return billing.creditNoteView(note);
    },
  );
}

export async function listInvoices(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  filter: { folio_id?: string | null },
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const invoices = await billing.listInvoiceRows(
        em,
        context.tenantId,
        propertyId,
        filter.folio_id ?? null,
      );
      const views = [];
      for (const invoice of invoices) {
        const notes = await billing.listCreditNotesForInvoice(
          em,
          context.tenantId,
          propertyId,
          invoice.id,
        );
        views.push({
          ...billing.invoiceView(invoice),
          credit_notes: notes.map((note) => billing.creditNoteView(note)),
        });
      }
      return { invoices: views };
    },
  );
}

export async function openCashierSession(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    currency?: string | null;
    opening_float?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const openingFloat = nonNegativeMoney(
    input.opening_float ?? '0',
    'opening_float',
  );
  return withBillingOperation(
    orm,
    context,
    propertyId,
    'cashier.operate',
    'OpenCashierSession',
    input.idempotencyKey,
    { opening_float: openingFloat.formatted },
    async (em) => {
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const currency = input.currency ?? 'IDR';
      if (currency !== 'IDR' && currency !== 'USD')
        throw new PropertyError('INVALID_REQUEST', { field: 'currency' });
      let session;
      try {
        session = await billing.insertCashierSession(em, {
          tenantId: context.tenantId,
          propertyId,
          currency,
          openingFloat: openingFloat.formatted,
          openedBy: context.actor.userId,
        });
      } catch (error) {
        if (databaseErrorCode(error) === '23505')
          throw new PropertyError('CONFLICT', {
            reason: 'cashier_session_already_open',
            currency,
          });
        throw error;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.cashier_opened',
        resourceType: 'cashier_session',
        resourceId: session.id,
        outcome: 'SUCCESS',
        afterSafe: { currency, opening_float: session.opening_float },
        correlationId: context.correlationId,
      });
      return billing.cashierView(session);
    },
  );
}

export async function countCashierSession(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  sessionId: string,
  input: { counted_money: string; idempotencyKey?: string | null },
): Promise<Record<string, unknown>> {
  const counted = nonNegativeMoney(input.counted_money, 'counted_money');
  return withBillingOperation(
    orm,
    context,
    propertyId,
    'cashier.operate',
    'CountCashierSession',
    input.idempotencyKey,
    { session_id: sessionId, counted_money: counted.formatted },
    async (em) => {
      const session = await billing.findCashierSession(
        em,
        context.tenantId,
        propertyId,
        sessionId,
      );
      if (!session) throw new PropertyError('NOT_FOUND');
      if (session.state !== 'OPEN' && session.state !== 'COUNTING')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: session.state,
        });
      const operations = await billing.cashierExpectedAmount(
        em,
        context.tenantId,
        propertyId,
        session.currency,
        session.opened_at,
      );
      const expected =
        operations + parseDecimal(session.opening_float, 'opening_float');
      const variance = counted.scaled - expected;
      const updated = await translatePropertyWrite(() =>
        billing.reconcileCashierSession(em, {
          tenantId: context.tenantId,
          propertyId,
          sessionId,
          expected: formatMoney(expected),
          counted: counted.formatted,
          variance: formatMoney(variance),
          countedBy: context.actor.userId,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'count_race',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.cashier_counted',
        resourceType: 'cashier_session',
        resourceId: sessionId,
        outcome: 'SUCCESS',
        afterSafe: {
          expected_amount: updated.expected_amount,
          counted_amount: updated.counted_amount,
          variance: updated.variance,
        },
        correlationId: context.correlationId,
      });
      return billing.cashierView(updated);
    },
  );
}

export async function closeCashierSession(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  sessionId: string,
  input: { idempotencyKey?: string | null },
): Promise<Record<string, unknown>> {
  return withBillingOperation(
    orm,
    context,
    propertyId,
    'cashier.operate',
    'CloseCashierSession',
    input.idempotencyKey,
    { session_id: sessionId },
    async (em) => {
      const session = await billing.findCashierSession(
        em,
        context.tenantId,
        propertyId,
        sessionId,
      );
      if (!session) throw new PropertyError('NOT_FOUND');
      if (session.state !== 'RECONCILED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: session.state,
        });
      const updated = await translatePropertyWrite(() =>
        billing.closeCashierSessionRow(em, {
          tenantId: context.tenantId,
          propertyId,
          sessionId,
          closedBy: context.actor.userId,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'close_race',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.cashier_closed',
        resourceType: 'cashier_session',
        resourceId: sessionId,
        outcome: 'SUCCESS',
        afterSafe: {
          variance: updated.variance,
          counted_amount: updated.counted_amount,
        },
        correlationId: context.correlationId,
      });
      return billing.cashierView(updated);
    },
  );
}

export async function listCashierSessions(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const sessions = await billing.listCashierSessionRows(
        em,
        context.tenantId,
        propertyId,
      );
      return {
        cashier_sessions: sessions.map((row) => billing.cashierView(row)),
      };
    },
  );
}

export { normalizeMoney };
