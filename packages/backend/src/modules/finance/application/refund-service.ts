import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { requestHash } from '../../identity/application/crypto.js';
import {
  consumeApproval,
  findApprovalById,
} from '../../identity/persistence/governance-repository.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertSafeText } from '../../property/domain/lifecycle.js';
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
import * as journalRepo from '../persistence/finance-repository.js';
import * as folioRepo from '../persistence/folio-repository.js';
import * as paymentRepo from '../persistence/payment-repository.js';
import * as repo from '../persistence/refund-repository.js';
import { reopenClearanceForFolios } from './clearance-service.js';
import { postJournal } from './journal-service.js';
import { methodAccount } from './payment-service.js';

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

async function auditActor(context: ServiceContext) {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

async function withAdjustOperation<T extends Record<string, unknown>>(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  permission: 'payment.refund.request' | 'folio.adjust',
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

function refundIntentHash(input: {
  paymentId: string;
  amount: string;
  currency: string;
}): string {
  return requestHash({
    action: 'payment.refund.request',
    payment_id: input.paymentId,
    amount: input.amount,
    currency: input.currency,
  });
}

function fxIntentHash(input: {
  pair: string;
  rate: string;
  effective_at: string;
  source: string;
}): string {
  return requestHash({
    action: 'fx.record',
    pair: input.pair,
    rate: input.rate,
    effective_at: input.effective_at,
    source: input.source,
  });
}

async function requireApproval(
  em: EntityManager,
  context: ServiceContext,
  input: {
    approvalId: string;
    action: string;
    resourceId: string | null;
    expectedHash: string;
  },
): Promise<void> {
  const approval = await findApprovalById(
    em,
    context.tenantId,
    input.approvalId,
  );
  if (!approval)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'approval_id',
      reason: 'approval_not_found',
    });
  if (approval.status !== 'APPROVED' || approval.consumed_at !== null)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'approval_id',
      reason: 'approval_not_approved',
    });
  if (
    approval.decided_by === null ||
    approval.decided_by === approval.requested_by
  )
    throw new PropertyError('INVALID_REQUEST', {
      field: 'approval_id',
      reason: 'independent_approval_required',
    });
  if (Date.parse(approval.expires_at) <= Date.now())
    throw new PropertyError('INVALID_REQUEST', {
      field: 'approval_id',
      reason: 'approval_expired',
    });
  if (
    approval.action !== input.action ||
    approval.request_hash !== input.expectedHash ||
    (input.resourceId !== null && approval.resource_id !== input.resourceId)
  )
    throw new PropertyError('INVALID_REQUEST', {
      field: 'approval_id',
      reason: 'approval_mismatch',
    });
}

export async function requestRefund(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  paymentId: string,
  input: {
    money: string;
    money_currency?: string | null;
    reason: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const amount = postableMoney(input.money, 'money');
  const reason = assertSafeText(input.reason, 'reason', 500);
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'payment.refund.request',
    'RequestRefund',
    input.idempotencyKey,
    { payment_id: paymentId, money: amount.formatted, reason },
    async (em) => {
      const payment = await paymentRepo.findPayment(
        em,
        context.tenantId,
        propertyId,
        paymentId,
      );
      if (!payment) throw new PropertyError('NOT_FOUND');
      if (payment.state !== 'SUCCEEDED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: payment.state,
        });
      assertMoneyCurrency(
        input.money_currency,
        payment.currency,
        'money.currency',
      );
      const existing = await repo.listRefundsForPayment(
        em,
        context.tenantId,
        propertyId,
        paymentId,
      );
      const reserved = existing
        .filter((row) => row.state !== 'FAILED')
        .reduce(
          (sum, row) => sum + parsePositiveMoney(row.amount, 'amount'),
          0n,
        );
      const paid = parsePositiveMoney(payment.amount, 'amount');
      if (reserved + amount.scaled > paid)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'money',
          reason: 'refund_exceeds_available',
          available: formatMoney(paid - reserved),
        });
      const refund = await translatePropertyWrite(() =>
        repo.insertRefund(em, {
          tenantId: context.tenantId,
          propertyId,
          paymentId,
          folioId: payment.folio_id,
          currency: payment.currency,
          amount: amount.formatted,
          reason,
          correlationId: context.correlationId,
        }),
      );
      const { insertApproval } =
        await import('../../identity/persistence/governance-repository.js');
      const approval = await insertApproval(em, {
        tenantId: context.tenantId,
        action: 'payment.refund.request',
        resourceType: 'folio_refund',
        resourceId: refund.id,
        requestHash: refundIntentHash({
          paymentId,
          amount: amount.formatted,
          currency: payment.currency,
        }),
        resourceVersion: null,
        currency: payment.currency,
        amount: amount.formatted,
        requestedBy: context.actor.userId,
        reason,
        ttlMinutes: 24 * 60,
      });
      await translatePropertyWrite(() =>
        repo.attachRefundApproval(
          em,
          context.tenantId,
          propertyId,
          refund.id,
          approval.id,
        ),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.refund_requested',
        resourceType: 'folio_refund',
        resourceId: refund.id,
        outcome: 'SUCCESS',
        afterSafe: {
          payment_id: paymentId,
          amount: refund.amount,
          state: refund.state,
          approval_id: approval.id,
        },
        correlationId: context.correlationId,
      });
      return { ...repo.refundView(refund), approval_id: approval.id };
    },
  );
}

export async function resolveRefund(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  refundId: string,
  input: {
    outcome: 'PENDING' | 'SUCCEEDED' | 'FAILED';
    approval_id?: string | null;
    evidence_ref?: string | null;
    external_reference?: string | null;
    reconciliation_reference?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!['PENDING', 'SUCCEEDED', 'FAILED'].includes(input.outcome))
    throw new PropertyError('INVALID_REQUEST', { field: 'outcome' });
  const externalReference =
    input.external_reference == null
      ? null
      : assertSafeText(input.external_reference, 'external_reference', 200);
  const reconciliationReference =
    input.reconciliation_reference == null
      ? null
      : assertSafeText(
          input.reconciliation_reference,
          'reconciliation_reference',
          200,
        );
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'payment.refund.request',
    'ResolveRefund',
    input.idempotencyKey,
    {
      refund_id: refundId,
      outcome: input.outcome,
      approval_id: input.approval_id ?? null,
    },
    async (em, timezone) => {
      const refund = await repo.findRefund(
        em,
        context.tenantId,
        propertyId,
        refundId,
      );
      if (!refund) throw new PropertyError('NOT_FOUND');
      if (refund.state === 'SUCCEEDED' || refund.state === 'FAILED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: refund.state,
        });
      const fromStates =
        input.outcome === 'PENDING' ? ['RESERVED'] : ['RESERVED', 'PENDING'];
      let journalId: string | null = null;
      if (input.outcome === 'SUCCEEDED') {
        if (!input.approval_id)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'approval_id',
            reason: 'approval_required',
          });
        await requireApproval(em, context, {
          approvalId: input.approval_id,
          action: 'payment.refund.request',
          resourceId: refundId,
          expectedHash: refundIntentHash({
            paymentId: refund.payment_id,
            amount: normalizeMoney(refund.amount),
            currency: refund.currency,
          }),
        });
        const payment = await paymentRepo.findPayment(
          em,
          context.tenantId,
          propertyId,
          refund.payment_id,
        );
        if (!payment) throw new PropertyError('NOT_FOUND');
        const amount = parsePositiveMoney(refund.amount, 'amount');
        const { journal } = await postJournal(em, {
          tenantId: context.tenantId,
          propertyId,
          businessDate: businessToday(timezone),
          timezone,
          currency: refund.currency,
          sourceType: 'REFUND',
          sourceId: refundId,
          memo: refund.reason,
          correlationId: context.correlationId,
          actor: await auditActor(context),
          lines: [
            {
              account_code: financeAccounts.GUEST_FOLIO,
              side: 'DEBIT',
              amount,
            },
            {
              account_code: methodAccount(payment.method),
              side: 'CREDIT',
              amount,
            },
          ],
        });
        journalId = journal.id;
        const consumed = await consumeApproval(em, {
          tenantId: context.tenantId,
          approvalId: input.approval_id,
          consumedBy: context.actor.userId,
          resourceType: 'folio_refund',
          resourceId: refundId,
        });
        if (!consumed)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'approval_id',
            reason: 'approval_already_used',
          });
      }
      const updated = await translatePropertyWrite(() =>
        repo.advanceRefund(em, {
          tenantId: context.tenantId,
          propertyId,
          refundId,
          fromStates,
          state: input.outcome,
          journalId,
          evidenceRef: input.evidence_ref ?? null,
          externalReference,
          reconciliationReference,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'refund_already_resolved',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.refund_resolved',
        resourceType: 'folio_refund',
        resourceId: refundId,
        outcome: 'SUCCESS',
        afterSafe: {
          state: updated.state,
          journal_id: updated.journal_id,
        },
        correlationId: context.correlationId,
      });
      if (updated.state === 'SUCCEEDED')
        await reopenClearanceForFolios(em, context, propertyId, [
          updated.folio_id,
        ]);
      return { ...repo.refundView(updated), replayed: false };
    },
  );
}

export async function reverseCharge(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  chargeId: string,
  input: { reason: string; idempotencyKey?: string | null },
): Promise<Record<string, unknown>> {
  const reason = assertSafeText(input.reason, 'reason', 500);
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'folio.adjust',
    'ReverseCharge',
    input.idempotencyKey,
    { charge_id: chargeId, reason },
    async (em, timezone) => {
      const charge = await folioRepo.findCharge(
        em,
        context.tenantId,
        propertyId,
        chargeId,
      );
      if (!charge) throw new PropertyError('NOT_FOUND');
      const original = await journalRepo.listJournalLines(
        em,
        charge.journal_id,
      );
      if (original.length === 0) throw new PropertyError('NOT_FOUND');
      const lines = original.map((line) => {
        const debit = parseDecimal(line.debit, 'debit');
        return {
          account_code: line.account_code,
          side: debit > 0n ? ('DEBIT' as const) : ('CREDIT' as const),
          amount:
            debit > 0n ? debit : parsePositiveMoney(line.credit, 'credit'),
        };
      });
      const flipped = lines.map((line) => ({
        ...line,
        side: line.side === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      }));
      let journal;
      try {
        ({ journal } = await postJournal(em, {
          tenantId: context.tenantId,
          propertyId,
          businessDate: businessToday(timezone),
          timezone,
          currency: charge.currency,
          sourceType: 'REVERSAL',
          sourceId: charge.journal_id,
          reversalOfId: charge.journal_id,
          adjustsJournalId: charge.journal_id,
          memo: reason,
          correlationId: context.correlationId,
          actor: await auditActor(context),
          lines: flipped,
        }));
      } catch (error) {
        if (databaseErrorCode(error) === '23505')
          throw new PropertyError('SOURCE_ALREADY_POSTED', {
            reason: 'charge_already_reversed',
            charge_id: chargeId,
          });
        throw error;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.charge_reversed',
        resourceType: 'folio_charge',
        resourceId: chargeId,
        outcome: 'SUCCESS',
        afterSafe: {
          original_journal_id: charge.journal_id,
          reversal_journal_id: journal.id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
      ]);
      return {
        charge_id: chargeId,
        original_journal_id: charge.journal_id,
        journal_id: journal.id,
        reason,
      };
    },
  );
}

export async function postAdjustment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  chargeId: string,
  input: {
    money: string;
    money_currency?: string | null;
    direction: 'INCREASE' | 'DECREASE';
    account_code?: string | null;
    reason: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const amount = postableMoney(input.money, 'money');
  const reason = assertSafeText(input.reason, 'reason', 500);
  if (input.direction !== 'INCREASE' && input.direction !== 'DECREASE')
    throw new PropertyError('INVALID_REQUEST', { field: 'direction' });
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'folio.adjust',
    'PostAdjustment',
    input.idempotencyKey,
    {
      charge_id: chargeId,
      money: amount.formatted,
      direction: input.direction,
    },
    async (em, timezone) => {
      const charge = await folioRepo.findCharge(
        em,
        context.tenantId,
        propertyId,
        chargeId,
      );
      if (!charge) throw new PropertyError('NOT_FOUND');
      assertMoneyCurrency(
        input.money_currency,
        charge.currency,
        'money.currency',
      );
      const account = input.account_code ?? charge.account_code;
      const { journal } = await postJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        businessDate: businessToday(timezone),
        timezone,
        currency: charge.currency,
        sourceType: 'ADJUSTMENT',
        sourceId: null,
        adjustsJournalId: charge.journal_id,
        memo: reason,
        correlationId: context.correlationId,
        actor: await auditActor(context),
        lines:
          input.direction === 'DECREASE'
            ? [
                { account_code: account, side: 'DEBIT', amount: amount.scaled },
                {
                  account_code: financeAccounts.GUEST_FOLIO,
                  side: 'CREDIT',
                  amount: amount.scaled,
                },
              ]
            : [
                {
                  account_code: financeAccounts.GUEST_FOLIO,
                  side: 'DEBIT',
                  amount: amount.scaled,
                },
                {
                  account_code: account,
                  side: 'CREDIT',
                  amount: amount.scaled,
                },
              ],
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.charge_adjusted',
        resourceType: 'folio_charge',
        resourceId: chargeId,
        outcome: 'SUCCESS',
        afterSafe: {
          journal_id: journal.id,
          direction: input.direction,
          amount: amount.formatted,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
      ]);
      return {
        charge_id: chargeId,
        journal_id: journal.id,
        direction: input.direction,
        amount: amount.formatted,
      };
    },
  );
}

export async function requestFxApproval(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    pair: string;
    rate: string;
    effective_at: string;
    source: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!['IDR/USD', 'USD/IDR'].includes(input.pair))
    throw new PropertyError('INVALID_REQUEST', { field: 'pair' });
  const rate = input.rate;
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(rate) || Number(rate) <= 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'rate' });
  const effectiveAt = new Date(input.effective_at);
  if (Number.isNaN(effectiveAt.getTime()))
    throw new PropertyError('INVALID_REQUEST', { field: 'effective_at' });
  const source = assertSafeText(input.source, 'source', 200);
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'folio.adjust',
    'RequestFxSnapshotApproval',
    input.idempotencyKey,
    {
      pair: input.pair,
      rate,
      effective_at: effectiveAt.toISOString(),
      source,
    },
    async (em) => {
      const { insertApproval } =
        await import('../../identity/persistence/governance-repository.js');
      const approval = await insertApproval(em, {
        tenantId: context.tenantId,
        action: 'fx.record',
        resourceType: 'fx_snapshot_request',
        resourceId: null,
        requestHash: fxIntentHash({
          pair: input.pair,
          rate,
          effective_at: effectiveAt.toISOString(),
          source,
        }),
        resourceVersion: null,
        currency: null,
        amount: null,
        requestedBy: context.actor.userId,
        reason: source,
        ttlMinutes: 24 * 60,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.fx_approval_requested',
        resourceType: 'approval_request',
        resourceId: approval.id,
        outcome: 'SUCCESS',
        afterSafe: { pair: input.pair, rate },
        correlationId: context.correlationId,
      });
      return { id: approval.id, status: approval.status };
    },
  );
}

export async function recordFxSnapshot(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    pair: string;
    rate: string;
    effective_at: string;
    source: string;
    approval_id: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!['IDR/USD', 'USD/IDR'].includes(input.pair))
    throw new PropertyError('INVALID_REQUEST', { field: 'pair' });
  const rate = input.rate;
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(rate) || Number(rate) <= 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'rate' });
  const effectiveAt = new Date(input.effective_at);
  if (Number.isNaN(effectiveAt.getTime()))
    throw new PropertyError('INVALID_REQUEST', { field: 'effective_at' });
  const source = assertSafeText(input.source, 'source', 200);
  return withAdjustOperation(
    orm,
    context,
    propertyId,
    'folio.adjust',
    'RecordFxSnapshot',
    input.idempotencyKey,
    {
      pair: input.pair,
      rate,
      effective_at: effectiveAt.toISOString(),
      source,
      approval_id: input.approval_id,
    },
    async (em) => {
      await requireApproval(em, context, {
        approvalId: input.approval_id,
        action: 'fx.record',
        resourceId: null,
        expectedHash: fxIntentHash({
          pair: input.pair,
          rate,
          effective_at: effectiveAt.toISOString(),
          source,
        }),
      });
      const snapshot = await translatePropertyWrite(() =>
        repo.insertFxSnapshot(em, {
          tenantId: context.tenantId,
          propertyId,
          pair: input.pair,
          rate,
          effectiveAt: effectiveAt.toISOString(),
          source,
          approvalId: input.approval_id,
          recordedBy: context.actor.userId,
          correlationId: context.correlationId,
        }),
      );
      const consumed = await consumeApproval(em, {
        tenantId: context.tenantId,
        approvalId: input.approval_id,
        consumedBy: context.actor.userId,
        resourceType: 'fx_snapshot',
        resourceId: snapshot.id,
      });
      if (!consumed)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'approval_id',
          reason: 'approval_already_used',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.fx_recorded',
        resourceType: 'fx_snapshot',
        resourceId: snapshot.id,
        outcome: 'SUCCESS',
        afterSafe: { pair: snapshot.pair, rate: snapshot.rate },
        correlationId: context.correlationId,
      });
      return repo.fxView(snapshot);
    },
  );
}

export async function listFxSnapshots(
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
      const snapshots = await repo.listFxSnapshotRows(
        em,
        context.tenantId,
        propertyId,
      );
      return { fx_snapshots: snapshots.map((row) => repo.fxView(row)) };
    },
  );
}
