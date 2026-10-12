import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertSafeText } from '../../property/domain/lifecycle.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import { financeAccounts } from '../domain/accounts.js';
import { computeFolioTotals } from '../domain/folio-totals.js';
import { assertCurrency, formatMoney } from '../domain/money.js';
import { addInterval } from '../domain/schedule-periods.js';
import type { ScheduleInterval } from '../domain/schedule-periods.js';
import * as billingRepo from '../persistence/billing-repository.js';
import * as clearanceRepo from '../persistence/clearance-repository.js';
import * as folioRepo from '../persistence/folio-repository.js';
import * as paymentRepo from '../persistence/payment-repository.js';
import * as refundRepo from '../persistence/refund-repository.js';
import { postJournal } from './journal-service.js';

export interface SettleClearanceInput {
  version: number;
  basis: 'SETTLED' | 'TRANSFER_TO_PAYER';
  payer_folio_id?: string | null;
  collection_plan_ref?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
}

function money(value: string): bigint {
  return parseDecimal(value, 'amount');
}

async function auditActor(context: ServiceContext) {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

export interface FolioFinancials {
  totals: ReturnType<typeof computeFolioTotals>;
  charges: folioRepo.FolioChargeRow[];
  allocations: folioRepo.PayerAllocationRow[];
  deposits: { amount: string; applied: string; released: string }[];
  payments: paymentRepo.FolioPaymentRow[];
  refunds: refundRepo.FolioRefundRow[];
}

export async function loadFolioFinancials(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioFinancials> {
  const charges = await folioRepo.listChargesForFolio(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const allocations = await folioRepo.listAllocationsForFolio(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const depositRows = await folioRepo.listDepositsForFolio(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const deposits: { amount: string; applied: string; released: string }[] = [];
  for (const deposit of depositRows) {
    const sums = await folioRepo.sumDepositApplications(
      em,
      tenantId,
      propertyId,
      deposit.id,
    );
    deposits.push({
      amount: deposit.amount,
      applied: sums.applied,
      released: sums.released,
    });
  }
  const payments = await paymentRepo.listPaymentsForFolio(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const refunds = await refundRepo.listRefundsForFolio(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const adjustments = await clearanceRepo.sumFolioAdjustments(
    em,
    tenantId,
    propertyId,
    folioId,
  );
  const totals = computeFolioTotals({
    folioId,
    charges,
    allocations,
    deposits,
    payments,
    refunds,
    adjustments,
  });
  return { totals, charges, allocations, deposits, payments, refunds };
}

function totalsView(totals: ReturnType<typeof computeFolioTotals>) {
  return {
    charges_total: formatMoney(totals.charges_total),
    adjustments_total: formatMoney(totals.adjustments_total),
    routed_out: formatMoney(totals.routed_out),
    routed_in: formatMoney(totals.routed_in),
    deposits_held: formatMoney(totals.deposits_held),
    deposits_applied: formatMoney(totals.deposits_applied),
    payments_total: formatMoney(totals.payments_total),
    refunds_total: formatMoney(totals.refunds_total),
    balance_due: formatMoney(totals.balance_due),
  };
}

/**
 * Reopens the financial clearance of any CLEARED reservation whose folio
 * received a new financial posting. Called inside the posting transaction so
 * the stored CLEARED state can never outlive the ledger facts behind it.
 */
export async function reopenClearanceForFolios(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  folioIds: readonly string[],
): Promise<void> {
  const reopened = await clearanceRepo.invalidateClearanceForFolios(em, {
    tenantId: context.tenantId,
    propertyId,
    folioIds,
  });
  for (const row of reopened) {
    await recordAudit(em, {
      tenantId: context.tenantId,
      propertyId,
      ...(await auditActor(context)),
      action: 'finance.clearance_reopened',
      resourceType: 'Reservation',
      resourceId: row.reservation_id,
      outcome: 'SUCCESS',
      afterSafe: {
        reason: 'financial_posting_after_clearance',
        folio_ids: [...new Set(folioIds)],
      },
      correlationId: context.correlationId,
    });
  }
}

function scheduleView(
  schedule: folioRepo.ChargeScheduleRow,
  postedPeriods: number,
) {
  let nextPeriod: string | null = schedule.starts_on;
  for (let index = 0; index < postedPeriods; index += 1)
    nextPeriod = addInterval(
      nextPeriod as string,
      schedule.interval as ScheduleInterval,
    );
  if (nextPeriod && schedule.ends_on && nextPeriod > schedule.ends_on)
    nextPeriod = null;
  return {
    id: schedule.id,
    code: schedule.code,
    account_code: schedule.account_code,
    quantity: schedule.quantity,
    net_amount: formatMoney(money(schedule.net_amount)),
    tax_amount: formatMoney(money(schedule.tax_amount)),
    currency: schedule.currency,
    interval: schedule.interval,
    starts_on: schedule.starts_on,
    ends_on: schedule.ends_on,
    state: schedule.state,
    version: schedule.version,
    posted_periods: postedPeriods,
    next_period_start: nextPeriod,
  };
}

async function folioClearanceView(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folio: folioRepo.FolioRow,
  financials: FolioFinancials,
) {
  const invoices = await billingRepo.listInvoiceRows(
    em,
    tenantId,
    propertyId,
    folio.id,
  );
  const schedules = await folioRepo.listSchedulesForFolio(
    em,
    tenantId,
    propertyId,
    folio.id,
  );
  const scheduleViews = [];
  for (const schedule of schedules) {
    const posted = await folioRepo.countScheduleCharges(
      em,
      tenantId,
      propertyId,
      schedule.id,
    );
    scheduleViews.push(scheduleView(schedule, posted));
  }
  const entitlementRows = await folioRepo.listEntitlementsForFolio(
    em,
    tenantId,
    propertyId,
    folio.id,
  );
  const entitlements = [];
  for (const entitlement of entitlementRows) {
    const consumed = await folioRepo.sumConsumedQuantity(em, entitlement.id);
    entitlements.push({
      id: entitlement.id,
      code: entitlement.code,
      quantity_total: entitlement.quantity_total,
      quantity_consumed: consumed,
      unit_net_amount: formatMoney(money(entitlement.unit_net_amount)),
      unit_tax_amount: formatMoney(money(entitlement.unit_tax_amount)),
      currency: entitlement.currency,
      state: entitlement.state,
    });
  }
  return {
    folio: folioRepo.folioView(folio),
    totals: totalsView(financials.totals),
    charges: financials.charges.map((charge) => folioRepo.chargeView(charge)),
    allocations: financials.allocations.map((allocation) => ({
      id: allocation.id,
      charge_id: allocation.charge_id,
      payer_folio_id: allocation.payer_folio_id,
      amount: formatMoney(money(allocation.amount)),
      journal_id: allocation.journal_id,
    })),
    payments: financials.payments.map((payment) =>
      paymentRepo.paymentView(payment),
    ),
    refunds: financials.refunds.map((refund) => refundRepo.refundView(refund)),
    invoices: invoices.map((invoice) => billingRepo.invoiceView(invoice)),
    schedules: scheduleViews,
    entitlements,
  };
}

async function reservationFolios(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationId: string,
): Promise<folioRepo.FolioRow[]> {
  return folioRepo.listFolioRows(em, {
    tenantId,
    propertyId,
    reservationId,
    state: null,
  });
}

export async function getReservationClearance(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const reservation = await clearanceRepo.findReservationClearance(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const folios = await reservationFolios(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      const folioViews = [];
      const byCurrency = new Map<
        string,
        ReturnType<typeof computeFolioTotals>
      >();
      let balanced = true;
      let outstanding = false;
      let credit = false;
      for (const folio of folios) {
        const financials = await loadFolioFinancials(
          em,
          context.tenantId,
          propertyId,
          folio.id,
        );
        folioViews.push(
          await folioClearanceView(
            em,
            context.tenantId,
            propertyId,
            folio,
            financials,
          ),
        );
        if (financials.totals.balance_due !== 0n) balanced = false;
        if (financials.totals.balance_due > 0n) outstanding = true;
        if (financials.totals.balance_due < 0n) credit = true;
        const current = byCurrency.get(folio.currency) ?? {
          charges_total: 0n,
          adjustments_total: 0n,
          routed_out: 0n,
          routed_in: 0n,
          deposits_held: 0n,
          deposits_applied: 0n,
          payments_total: 0n,
          refunds_total: 0n,
          balance_due: 0n,
        };
        current.charges_total += financials.totals.charges_total;
        current.adjustments_total += financials.totals.adjustments_total;
        current.routed_out += financials.totals.routed_out;
        current.routed_in += financials.totals.routed_in;
        current.deposits_held += financials.totals.deposits_held;
        current.deposits_applied += financials.totals.deposits_applied;
        current.payments_total += financials.totals.payments_total;
        current.refunds_total += financials.totals.refunds_total;
        current.balance_due += financials.totals.balance_due;
        byCurrency.set(folio.currency, current);
      }
      const externalBooking =
        await clearanceRepo.findExternalBookingForReservation(
          em,
          context.tenantId,
          propertyId,
          reservationId,
        );
      return {
        reservation: {
          id: reservation.id,
          state: reservation.state,
          version: reservation.version,
          source: reservation.source,
          channel_connection_id: reservation.channel_connection_id,
          external_booking_key: reservation.external_booking_key,
          financial_clearance_state: reservation.financial_clearance_state,
          financial_cleared_at: reservation.financial_cleared_at,
          financial_clearance_basis: reservation.financial_clearance_basis,
          financial_clearance_reference:
            reservation.financial_clearance_reference,
          departed: [
            'CHECKED_OUT',
            'PARTIALLY_CHECKED_OUT',
            'COMPLETED',
          ].includes(reservation.state),
        },
        external_booking: externalBooking
          ? {
              id: externalBooking.id,
              connection_id: externalBooking.connection_id,
              channel_key: externalBooking.channel_key,
              external_booking_id: externalBooking.external_booking_id,
              provider_booking_id: externalBooking.provider_booking_id,
              state: externalBooking.state,
            }
          : null,
        folios: folioViews,
        totals_by_currency: [...byCurrency.entries()].map(
          ([currency, totals]) => ({ currency, ...totalsView(totals) }),
        ),
        balanced,
        outstanding,
        credit,
        settled: reservation.financial_clearance_state === 'CLEARED',
      };
    },
  );
}

interface TransferAllocation {
  chargeId: string;
  payerFolioId: string;
  amount: bigint;
}

function postedAtMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function planTransfer(
  folioId: string,
  payerFolioId: string,
  financials: FolioFinancials,
): TransferAllocation[] {
  const balance = financials.totals.balance_due;
  if (balance <= 0n) return [];
  const already = new Map<string, bigint>();
  for (const allocation of financials.allocations) {
    already.set(
      allocation.charge_id,
      (already.get(allocation.charge_id) ?? 0n) + money(allocation.amount),
    );
  }
  const ordered = [...financials.charges].sort((left, right) =>
    postedAtMillis(left.posted_at) === postedAtMillis(right.posted_at)
      ? left.id.localeCompare(right.id)
      : postedAtMillis(left.posted_at) - postedAtMillis(right.posted_at),
  );
  let capacity = 0n;
  for (const charge of ordered) {
    const total = money(charge.net_amount) + money(charge.tax_amount);
    const remaining = total - (already.get(charge.id) ?? 0n);
    if (remaining > 0n) capacity += remaining;
  }
  if (capacity < balance)
    throw new PropertyError('TRANSFER_NOT_SUPPORTED', {
      folio_id: folioId,
      balance_due: formatMoney(balance),
      routable_remaining: formatMoney(capacity),
    });
  const plan: TransferAllocation[] = [];
  let remainingBalance = balance;
  for (const charge of ordered) {
    if (remainingBalance === 0n) break;
    const total = money(charge.net_amount) + money(charge.tax_amount);
    const remaining = total - (already.get(charge.id) ?? 0n);
    if (remaining <= 0n) continue;
    const take = remaining < remainingBalance ? remaining : remainingBalance;
    plan.push({ chargeId: charge.id, payerFolioId, amount: take });
    remainingBalance -= take;
  }
  if (remainingBalance !== 0n)
    throw new PropertyError('TRANSFER_NOT_SUPPORTED', {
      folio_id: folioId,
      reason: 'routing_plan_incomplete',
    });
  return plan;
}

export async function settleClearance(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  input: SettleClearanceInput,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (input.basis !== 'SETTLED' && input.basis !== 'TRANSFER_TO_PAYER')
    throw new PropertyError('INVALID_REQUEST', { field: 'basis' });
  const isTransfer = input.basis === 'TRANSFER_TO_PAYER';
  const payerFolioId = input.payer_folio_id ?? null;
  const planRef =
    input.collection_plan_ref == null
      ? null
      : assertSafeText(input.collection_plan_ref, 'collection_plan_ref', 200);
  const reason =
    input.reason == null ? null : assertSafeText(input.reason, 'reason', 500);
  if (!isTransfer && (payerFolioId !== null || planRef !== null))
    throw new PropertyError('INVALID_REQUEST', {
      field: 'basis',
      reason: 'transfer_fields_not_allowed',
    });
  if (isTransfer && (payerFolioId === null || planRef === null))
    throw new PropertyError('INVALID_REQUEST', {
      field: payerFolioId === null ? 'payer_folio_id' : 'collection_plan_ref',
      reason: 'authorized_payer_and_plan_required',
    });
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'SettleClearance',
    property_id: propertyId,
    reservation_id: reservationId,
    version: input.version,
    basis: input.basis,
    payer_folio_id: payerFolioId,
    collection_plan_ref: planRef,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.charge', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'SettleClearance',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const reservation = await clearanceRepo.findReservationClearance(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      if (reservation.version !== input.version)
        throw new PropertyError('STALE_VERSION', {
          expected: input.version,
          current: reservation.version,
        });
      if (reservation.financial_clearance_state !== 'PENDING')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: reservation.financial_clearance_state,
        });
      if (!['CHECKED_OUT', 'COMPLETED'].includes(reservation.state))
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'clearance_requires_departure',
          state: reservation.state,
        });
      const folios = await reservationFolios(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      const financialsByFolio = new Map<string, FolioFinancials>();
      for (const folio of folios) {
        const financials = await loadFolioFinancials(
          em,
          context.tenantId,
          propertyId,
          folio.id,
        );
        financialsByFolio.set(folio.id, financials);
        if (financials.totals.balance_due < 0n)
          throw new PropertyError('CLEARANCE_CREDIT', {
            folio_id: folio.id,
            balance_due: formatMoney(financials.totals.balance_due),
            reason: 'refund_pending',
          });
      }
      let payerFolio: folioRepo.FolioRow | null;
      const transferPlan: TransferAllocation[] = [];
      if (isTransfer) {
        payerFolio = await folioRepo.findFolio(
          em,
          context.tenantId,
          propertyId,
          payerFolioId as string,
        );
        if (!payerFolio) throw new PropertyError('NOT_FOUND');
        if (payerFolio.state !== 'OPEN')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: payerFolio.state,
            field: 'payer_folio_id',
          });
        if (payerFolio.kind !== 'COMPANY')
          throw new PropertyError('INVALID_REQUEST', {
            field: 'payer_folio_id',
            reason: 'authorized_company_payer_required',
          });
        if (payerFolio.reservation_id !== null)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'payer_folio_id',
            reason: 'payer_must_be_city_ledger_account',
          });
        for (const folio of folios) {
          const financials = financialsByFolio.get(folio.id) as FolioFinancials;
          if (financials.totals.balance_due <= 0n) continue;
          if (folio.currency !== payerFolio.currency)
            throw new PropertyError('INVALID_REQUEST', {
              field: 'payer_folio_id',
              reason: 'currency_mismatch',
              folio_id: folio.id,
            });
          transferPlan.push(
            ...planTransfer(folio.id, payerFolio.id, financials),
          );
        }
        if (transferPlan.length === 0)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'basis',
            reason: 'no_outstanding_balance',
          });
        const total = transferPlan.reduce(
          (sum, allocation) => sum + allocation.amount,
          0n,
        );
        const { journal } = await postJournal(em, {
          tenantId: context.tenantId,
          propertyId,
          businessDate: businessToday(property.timezone),
          timezone: property.timezone,
          currency: payerFolio.currency,
          sourceType: 'ROUTING',
          sourceId: null,
          memo: `clearance transfer ${reservationId}`,
          correlationId: context.correlationId,
          actor: await auditActor(context),
          lines: [
            ...transferPlan.map((allocation) => ({
              account_code: financeAccounts.GUEST_RECEIVABLE,
              side: 'DEBIT' as const,
              amount: allocation.amount,
            })),
            {
              account_code: financeAccounts.GUEST_FOLIO,
              side: 'CREDIT' as const,
              amount: total,
            },
          ],
        });
        for (const allocation of transferPlan) {
          await folioRepo.insertAllocation(em, {
            tenantId: context.tenantId,
            propertyId,
            chargeId: allocation.chargeId,
            payerFolioId: allocation.payerFolioId,
            amount: formatMoney(allocation.amount),
            journalId: journal.id,
            memo: reason,
          });
        }
      } else {
        let outstanding = 0n;
        for (const financials of financialsByFolio.values())
          outstanding += financials.totals.balance_due;
        if (outstanding > 0n)
          throw new PropertyError('CLEARANCE_OUTSTANDING', {
            balance_due: formatMoney(outstanding),
            folios: [...financialsByFolio.entries()]
              .filter(([, financials]) => financials.totals.balance_due > 0n)
              .map(([folioId, financials]) => ({
                folio_id: folioId,
                balance_due: formatMoney(financials.totals.balance_due),
              })),
            reason: 'payment_or_authorized_transfer_required',
          });
      }
      const cleared = await clearanceRepo.markReservationClearance(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId,
        version: input.version,
        basis: input.basis,
        reference: planRef,
        payerFolioId: isTransfer ? (payerFolioId as string) : null,
      });
      if (!cleared)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'clearance_changed',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActor(context)),
        action: 'finance.clearance_cleared',
        resourceType: 'Reservation',
        resourceId: reservationId,
        outcome: 'SUCCESS',
        beforeSafe: {
          financial_clearance_state: 'PENDING',
          reservation_state: reservation.state,
        },
        afterSafe: {
          financial_clearance_state: 'CLEARED',
          basis: input.basis,
          collection_plan_ref: planRef,
          payer_folio_id: isTransfer ? payerFolioId : null,
          transfer_total: isTransfer
            ? formatMoney(
                transferPlan.reduce(
                  (sum, allocation) => sum + allocation.amount,
                  0n,
                ),
              )
            : null,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: reservationId,
        state: cleared.state,
        reservation_version: cleared.version,
        financial_clearance_state: cleared.financial_clearance_state,
        financial_cleared_at: cleared.financial_cleared_at,
        financial_clearance_basis: cleared.financial_clearance_basis,
        financial_clearance_reference: cleared.financial_clearance_reference,
        financial_clearance_payer_folio_id:
          cleared.financial_clearance_payer_folio_id,
        transfer_allocations: isTransfer
          ? transferPlan.map((allocation) => ({
              charge_id: allocation.chargeId,
              payer_folio_id: allocation.payerFolioId,
              amount: formatMoney(allocation.amount),
            }))
          : [],
        replayed: false,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'SettleClearance',
        key,
        requestHash,
        response,
        resourceId: reservationId,
      });
      return response;
    },
  );
}

export async function listExternalSettlements(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  filter: { reservation_id?: string | null; state?: string | null },
): Promise<Record<string, unknown>> {
  if (
    filter.state &&
    !['UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(filter.state)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'state' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const rows = await clearanceRepo.listExternalSettlementRows(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: filter.reservation_id ?? null,
        state: filter.state ?? null,
      });
      return {
        settlements: rows.map((row) => ({
          id: row.id,
          folio_id: row.folio_id,
          folio_reservation_id: row.folio_reservation_id,
          method: row.method,
          currency: assertCurrency(row.currency),
          amount: formatMoney(money(row.amount)),
          gross_amount:
            row.gross_amount === null
              ? null
              : formatMoney(money(row.gross_amount)),
          commission_amount:
            row.commission_amount === null
              ? null
              : formatMoney(money(row.commission_amount)),
          business_date: row.business_date,
          external_reference: row.external_reference,
          evidence_ref: row.evidence_ref,
          source_ref: row.source_ref,
          state: row.state,
          journal_id: row.journal_id,
          reservation: row.reservation_id
            ? {
                id: row.reservation_id,
                state: row.reservation_state,
                source: row.reservation_source,
                channel_connection_id: row.channel_connection_id,
                external_booking_key: row.external_booking_key,
              }
            : null,
          external_booking: row.external_booking_id
            ? {
                id: row.external_booking_id,
                channel_key: row.external_channel_key,
                provider_booking_id: row.external_provider_booking_id,
                state: row.external_booking_state,
              }
            : null,
          linked_to_external_booking: Boolean(row.external_booking_id),
        })),
      };
    },
  );
}
