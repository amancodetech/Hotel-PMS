import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
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
import { financeAccounts } from '../domain/accounts.js';
import {
  assertCurrency,
  assertMoneyCurrency,
  formatMoney,
  normalizeMoney,
  parsePositiveMoney,
  roundPosting,
} from '../domain/money.js';
import * as folioRepo from '../persistence/folio-repository.js';
import * as journalRepo from '../persistence/finance-repository.js';
import * as repo from '../persistence/payment-repository.js';
import type { FolioPaymentRow } from '../persistence/payment-repository.js';
import { reopenClearanceForFolios } from './clearance-service.js';
import { postJournal } from './journal-service.js';

export interface RecordPaymentInput {
  folio_id: string;
  method: string;
  money: string;
  money_currency?: string | null;
  currency?: string | null;
  gross_money?: string | null;
  gross_currency?: string | null;
  commission_money?: string | null;
  commission_currency?: string | null;
  business_date: string;
  external_reference: string;
  evidence_ref?: string | null;
  source_ref: string;
  certainty?: 'CONFIRMED' | 'UNKNOWN';
  idempotencyKey?: string | null;
}

export interface ReconcilePaymentInput {
  outcome: 'SUCCEEDED' | 'FAILED';
  reconciliation_reference?: string | null;
  idempotencyKey?: string | null;
}

const paymentMethods = [
  'CASH',
  'BANK_TRANSFER',
  'OTA_SETTLEMENT',
  'EXTERNAL_POS',
] as const;

function postableMoney(
  value: unknown,
  field: string,
): { scaled: bigint; formatted: string } {
  const parsed = parsePositiveMoney(value, field);
  const rounded = roundPosting(parsed);
  if (rounded <= 0n)
    throw new PropertyError('FRACTION_NOT_SUPPORTED', {
      field,
      reason: 'rounds_to_zero',
    });
  return { scaled: rounded, formatted: formatMoney(rounded) };
}

function optionalZeroMoney(
  value: unknown,
  field: string,
): { scaled: bigint; formatted: string } | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parsePositiveMoney(value, field);
  const rounded = roundPosting(parsed);
  if (rounded < 0n) throw new PropertyError('INVALID_REQUEST', { field });
  return { scaled: rounded, formatted: formatMoney(rounded) };
}

export function methodAccount(method: string): string {
  if (method === 'CASH') return financeAccounts.CASH;
  if (method === 'BANK_TRANSFER') return financeAccounts.BANK;
  if (method === 'OTA_SETTLEMENT') return financeAccounts.BANK;
  return financeAccounts.POS_CLEARING;
}

async function auditActor(context: ServiceContext) {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

async function withPaymentOperation<T extends Record<string, unknown>>(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  operation: string,
  keyRaw: string | null | undefined,
  request: Record<string, unknown>,
  work: (em: EntityManager, timezone: string) => Promise<T>,
): Promise<T> {
  const key = requireIdempotencyKey(keyRaw);
  const requestHash = hashRequest({
    operation,
    property_id: propertyId,
    ...request,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'payment.record', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        operation,
        key,
        requestHash,
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
        requestHash,
        response: result,
        resourceId: typeof result.id === 'string' ? result.id : null,
      });
      return result;
    },
  );
}

/**
 * Posts the collection journal of a resolved payment. Non-OTA methods move the
 * folio balance to the collection account; OTA settlements keep gross, net and
 * commission separate (F-08): bank receives the net, commission is an expense
 * and the clearing account holds the gross.
 */
async function postPaymentJournal(
  em: EntityManager,
  context: ServiceContext,
  input: {
    tenantId: string;
    propertyId: string;
    timezone: string;
    businessDate: string;
    currency: string;
    method: string;
    amount: bigint;
    commission: bigint | null;
    memo: string | null;
  },
) {
  const lines: {
    account_code: string;
    side: 'DEBIT' | 'CREDIT';
    amount: bigint;
  }[] = [
    {
      account_code: methodAccount(input.method),
      side: 'DEBIT',
      amount: input.amount,
    },
  ];
  if (input.method === 'OTA_SETTLEMENT' && input.commission !== null) {
    if (input.commission > 0n)
      lines.push({
        account_code: financeAccounts.COMMISSION_EXPENSE,
        side: 'DEBIT',
        amount: input.commission,
      });
    lines.push({
      account_code: financeAccounts.OTA_CLEARING,
      side: 'CREDIT',
      amount: input.amount + input.commission,
    });
  } else {
    lines.push({
      account_code: financeAccounts.GUEST_FOLIO,
      side: 'CREDIT',
      amount: input.amount,
    });
  }
  return postJournal(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    timezone: input.timezone,
    currency: input.currency,
    sourceType: 'PAYMENT',
    sourceId: null,
    memo: input.memo,
    correlationId: context.correlationId,
    actor: await auditActor(context),
    lines,
  });
}

function assertPaymentShape(input: {
  method: string;
  evidenceRef: string | null;
  isOta: boolean;
  hasSettlement: boolean;
}): void {
  if (input.evidenceRef === null && input.method !== 'CASH')
    throw new PropertyError('INVALID_REQUEST', {
      field: 'evidence_ref',
      reason: 'evidence_required',
    });
  if (input.isOta !== input.hasSettlement)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'settlement',
      reason: input.isOta ? 'settlement_required' : 'settlement_not_allowed',
    });
}

export async function recordPayment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: RecordPaymentInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  if (!paymentMethods.includes(input.method as (typeof paymentMethods)[number]))
    throw new PropertyError('INVALID_REQUEST', { field: 'method' });
  const amount = postableMoney(input.money, 'money');
  const gross = optionalZeroMoney(input.gross_money, 'gross_money');
  const commission = optionalZeroMoney(
    input.commission_money,
    'commission_money',
  );
  const externalReference = assertSafeText(
    input.external_reference,
    'external_reference',
    200,
  );
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  const certainty = input.certainty ?? 'CONFIRMED';
  if (certainty !== 'CONFIRMED' && certainty !== 'UNKNOWN')
    throw new PropertyError('INVALID_REQUEST', { field: 'certainty' });
  const isOta = input.method === 'OTA_SETTLEMENT';
  assertPaymentShape({
    method: input.method,
    evidenceRef: input.evidence_ref ?? null,
    isOta,
    hasSettlement: gross !== null && commission !== null,
  });
  if (isOta && gross && commission) {
    if (gross.scaled !== amount.scaled + commission.scaled)
      throw new PropertyError('INVALID_REQUEST', {
        field: 'gross_money',
        reason: 'gross_must_equal_net_plus_commission',
      });
  }
  return withPaymentOperation(
    orm,
    context,
    propertyId,
    'RecordPayment',
    input.idempotencyKey,
    {
      folio_id: input.folio_id,
      method: input.method,
      money: amount.formatted,
      business_date: input.business_date,
      source_ref: sourceRef,
      certainty,
    },
    async (em, timezone) => {
      const folio = await folioRepo.findFolio(
        em,
        context.tenantId,
        propertyId,
        input.folio_id,
      );
      if (!folio) throw new PropertyError('NOT_FOUND');
      if (folio.state !== 'OPEN')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: folio.state,
        });
      const currency = assertCurrency(input.currency ?? folio.currency);
      if (currency !== folio.currency)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'currency',
          reason: 'folio_currency_mismatch',
        });
      assertMoneyCurrency(input.money_currency, currency, 'money.currency');
      assertMoneyCurrency(
        input.gross_currency,
        currency,
        'gross_money.currency',
      );
      assertMoneyCurrency(
        input.commission_currency,
        currency,
        'commission_money.currency',
      );
      const existing = await repo.findPaymentBySource(
        em,
        context.tenantId,
        propertyId,
        sourceRef,
      );
      if (existing)
        throw new PropertyError('SOURCE_ALREADY_POSTED', {
          source_ref: sourceRef,
          payment_id: existing.id,
        });
      let journalId: string | null = null;
      if (certainty === 'CONFIRMED') {
        const { journal } = await postPaymentJournal(em, context, {
          tenantId: context.tenantId,
          propertyId,
          timezone,
          businessDate: input.business_date,
          currency,
          method: input.method,
          amount: amount.scaled,
          commission: isOta ? (commission?.scaled ?? 0n) : null,
          memo: `payment ${input.method}`,
        });
        journalId = journal.id;
      }
      let payment: FolioPaymentRow;
      try {
        payment = await repo.insertPayment(em, {
          tenantId: context.tenantId,
          propertyId,
          folioId: folio.id,
          method: input.method,
          currency,
          amount: amount.formatted,
          grossAmount: gross?.formatted ?? null,
          commissionAmount: commission?.formatted ?? null,
          businessDate: input.business_date,
          externalReference,
          evidenceRef: input.evidence_ref ?? null,
          sourceRef,
          state: certainty === 'CONFIRMED' ? 'SUCCEEDED' : 'UNKNOWN',
          journalId,
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
        action:
          payment.state === 'UNKNOWN'
            ? 'finance.payment_unknown'
            : 'finance.payment_recorded',
        resourceType: 'folio_payment',
        resourceId: payment.id,
        outcome: 'SUCCESS',
        afterSafe: {
          folio_id: payment.folio_id,
          method: payment.method,
          amount: payment.amount,
          state: payment.state,
          journal_id: payment.journal_id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        payment.folio_id,
      ]);
      return { ...repo.paymentView(payment), replayed: false };
    },
  );
}

export async function reconcilePayment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  paymentId: string,
  input: ReconcilePaymentInput,
): Promise<Record<string, unknown>> {
  if (input.outcome !== 'SUCCEEDED' && input.outcome !== 'FAILED')
    throw new PropertyError('INVALID_REQUEST', { field: 'outcome' });
  const reference =
    input.reconciliation_reference == null
      ? null
      : assertSafeText(
          input.reconciliation_reference,
          'reconciliation_reference',
          200,
        );
  return withPaymentOperation(
    orm,
    context,
    propertyId,
    'ReconcilePayment',
    input.idempotencyKey,
    { payment_id: paymentId, outcome: input.outcome },
    async (em, timezone) => {
      const payment = await repo.findPayment(
        em,
        context.tenantId,
        propertyId,
        paymentId,
      );
      if (!payment) throw new PropertyError('NOT_FOUND');
      if (payment.state !== 'UNKNOWN')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: payment.state,
        });
      const amount = parsePositiveMoney(payment.amount, 'amount');
      const commission =
        payment.commission_amount === null
          ? null
          : parsePositiveMoney(payment.commission_amount, 'commission_amount');
      let journalId: string | null = null;
      if (input.outcome === 'SUCCEEDED') {
        const { journal } = await postPaymentJournal(em, context, {
          tenantId: context.tenantId,
          propertyId,
          timezone,
          businessDate: payment.business_date,
          currency: payment.currency,
          method: payment.method,
          amount,
          commission,
          memo: 'payment reconciliation',
        });
        journalId = journal.id;
      }
      const resolved = await translatePropertyWrite(() =>
        repo.resolvePayment(em, {
          tenantId: context.tenantId,
          propertyId,
          paymentId,
          state: input.outcome,
          journalId,
          reconciliationReference: reference,
        }),
      );
      if (!resolved)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'payment_already_resolved',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.payment_reconciled',
        resourceType: 'folio_payment',
        resourceId: resolved.id,
        outcome: 'SUCCESS',
        afterSafe: {
          state: resolved.state,
          journal_id: resolved.journal_id,
          reconciliation_reference: resolved.reconciliation_reference,
        },
        correlationId: context.correlationId,
      });
      if (resolved.state === 'SUCCEEDED')
        await reopenClearanceForFolios(em, context, propertyId, [
          resolved.folio_id,
        ]);
      return { ...repo.paymentView(resolved), replayed: false };
    },
  );
}

export async function listPayments(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  filter: { folio_id?: string | null; state?: string | null },
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
      const payments = await repo.listPaymentRows(em, {
        tenantId: context.tenantId,
        propertyId,
        folioId: filter.folio_id ?? null,
        state: filter.state ?? null,
      });
      return { payments: payments.map((row) => repo.paymentView(row)) };
    },
  );
}

export async function getPayment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  paymentId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const payment = await repo.findPayment(
        em,
        context.tenantId,
        propertyId,
        paymentId,
      );
      if (!payment) throw new PropertyError('NOT_FOUND');
      const journal = payment.journal_id
        ? await journalRepo.listJournalLines(em, payment.journal_id)
        : [];
      return {
        payment: repo.paymentView(payment),
        journal_lines: journal.map((line) => ({
          line_no: line.line_no,
          account_code: line.account_code,
          debit: normalizeMoney(line.debit),
          credit: normalizeMoney(line.credit),
        })),
      };
    },
  );
}
