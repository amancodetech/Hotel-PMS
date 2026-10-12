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
import {
  findPropertyScope,
  findReservation,
} from '../../reservations/persistence/reservation-repository.js';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import { financeAccounts, ACCOUNT_CODE_PATTERN } from '../domain/accounts.js';
import { computeFolioTotals } from '../domain/folio-totals.js';
import {
  assertCurrency,
  assertMoneyCurrency,
  formatMoney,
  normalizeMoney,
  parsePositiveMoney,
  roundPosting,
} from '../domain/money.js';
import { addInterval, scheduleIntervals } from '../domain/schedule-periods.js';
import type { ScheduleInterval } from '../domain/schedule-periods.js';
import * as clearanceRepo from '../persistence/clearance-repository.js';
import * as repo from '../persistence/folio-repository.js';
import * as paymentRepo from '../persistence/payment-repository.js';
import * as refundRepo from '../persistence/refund-repository.js';
import type {
  FolioChargeRow,
  FolioRow,
} from '../persistence/folio-repository.js';
import { reopenClearanceForFolios } from './clearance-service.js';
import { postJournal } from './journal-service.js';
import { addIsoDays } from './business-day-service.js';

export interface OpenFolioInput {
  reservation_id?: string | null;
  kind?: string;
  payer_label: string;
  currency: string;
  idempotencyKey?: string | null;
}

export interface PostChargeInput {
  folio_id: string;
  business_date: string;
  net_money: string;
  currency?: string;
  tax_money?: string | null;
  tax_money_currency?: string | null;
  tax_policy?: Record<string, unknown> | null;
  policy_snapshot_id?: string | null;
  account_code?: string | null;
  source_ref: string;
  memo?: string | null;
  idempotencyKey?: string | null;
}

interface ChargePostingInput {
  tenantId: string;
  propertyId: string;
  timezone: string;
  folio: FolioRow;
  businessDate: string;
  kind: string;
  accountCode: string;
  netScaled: bigint;
  taxScaled: bigint;
  taxPolicy: Record<string, unknown>;
  policySnapshotId: string | null;
  sourceKind: string;
  sourceRef: string;
  periodStart: string | null;
  periodEnd: string | null;
  memo: string | null;
  actor: {
    actorType: 'USER' | 'SERVICE';
    actorId: string | null;
    actorLabel: string | null;
  };
  correlationId: string | null;
}

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

function optionalPostableMoney(
  value: unknown,
  field: string,
): { scaled: bigint; formatted: string } | null {
  if (value === undefined || value === null || value === '') return null;
  return postableMoney(value, field);
}

function moneyFromString(value: string): bigint {
  return parseDecimal(value, 'amount');
}

function sumStored(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + moneyFromString(value), 0n);
}

function assertAccountCode(value: string | null | undefined): string {
  const code = value ?? financeAccounts.REVENUE_OTHER;
  if (!ACCOUNT_CODE_PATTERN.test(code))
    throw new PropertyError('INVALID_REQUEST', { field: 'account_code' });
  return code;
}

function assertTaxPolicy(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new PropertyError('INVALID_REQUEST', { field: 'tax_policy' });
  return value as Record<string, unknown>;
}

async function auditActorOfWork(context: ServiceContext): Promise<{
  actorType: 'USER' | 'SERVICE';
  actorId: string | null;
  actorLabel: string | null;
}> {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

async function withWriteOperation<T extends Record<string, unknown>>(
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
      await authorize(em, context, 'folio.charge', propertyId);
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

async function withReadOperation<T>(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  work: (em: EntityManager, timezone: string) => Promise<T>,
): Promise<T> {
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
      return work(em, property.timezone);
    },
  );
}

async function requireFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioRow> {
  const folio = await repo.findFolio(em, tenantId, propertyId, folioId);
  if (!folio) throw new PropertyError('NOT_FOUND');
  return folio;
}

/**
 * Posts one charge and its journal. The journal is inserted first so the
 * charge can reference it; a duplicate source aborts the whole transaction and
 * is reported as SOURCE_ALREADY_POSTED without a second journal.
 */
async function postChargeInternal(
  em: EntityManager,
  input: ChargePostingInput,
): Promise<{ charge: FolioChargeRow; journalId: string }> {
  const total = input.netScaled + input.taxScaled;
  if (input.netScaled <= 0n)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'net_money',
      reason: 'positive_amount_required',
    });
  const existing = await repo.findChargeBySource(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
  });
  if (existing)
    throw new PropertyError('SOURCE_ALREADY_POSTED', {
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
      charge_id: existing.id,
    });
  const lines = [
    {
      account_code: financeAccounts.GUEST_FOLIO,
      side: 'DEBIT' as const,
      amount: total,
    },
    {
      account_code: input.accountCode,
      side: 'CREDIT' as const,
      amount: input.netScaled,
    },
  ];
  if (input.taxScaled > 0n)
    lines.push({
      account_code: financeAccounts.TAX_PAYABLE,
      side: 'CREDIT',
      amount: input.taxScaled,
    });
  const { journal } = await postJournal(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    timezone: input.timezone,
    currency: input.folio.currency,
    sourceType: 'CHARGE',
    sourceId: null,
    memo: input.memo,
    correlationId: input.correlationId,
    actor: input.actor,
    lines,
  });
  let charge: FolioChargeRow;
  try {
    charge = await repo.insertCharge(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      folioId: input.folio.id,
      businessDate: input.businessDate,
      currency: input.folio.currency,
      kind: input.kind,
      accountCode: input.accountCode,
      netAmount: formatMoney(input.netScaled),
      taxAmount: formatMoney(input.taxScaled),
      taxPolicy: input.taxPolicy,
      policySnapshotId: input.policySnapshotId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      memo: input.memo,
      journalId: journal.id,
      correlationId: input.correlationId,
    });
  } catch (error) {
    if (databaseErrorCode(error) === '23505')
      throw new PropertyError('SOURCE_ALREADY_POSTED', {
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
      });
    throw error;
  }
  await recordAudit(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    actorLabel: input.actor.actorLabel,
    action: 'finance.charge_posted',
    resourceType: 'folio_charge',
    resourceId: charge.id,
    outcome: 'SUCCESS',
    afterSafe: {
      folio_id: charge.folio_id,
      kind: charge.kind,
      net_amount: charge.net_amount,
      tax_amount: charge.tax_amount,
      journal_id: charge.journal_id,
    },
    correlationId: input.correlationId,
  });
  return { charge, journalId: journal.id };
}

export async function openFolio(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: OpenFolioInput,
): Promise<Record<string, unknown>> {
  const kind = input.kind ?? 'GUEST';
  if (!['GUEST', 'COMPANY', 'HOUSE', 'OWNER'].includes(kind))
    throw new PropertyError('INVALID_REQUEST', { field: 'kind' });
  const currency = assertCurrency(input.currency);
  const payerLabel = assertSafeText(input.payer_label, 'payer_label', 200);
  if (
    input.reservation_id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.reservation_id,
    )
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'reservation_id' });
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'OpenFolio',
    input.idempotencyKey,
    {
      reservation_id: input.reservation_id ?? null,
      kind,
      payer_label: payerLabel,
      currency,
    },
    async (em) => {
      if (input.reservation_id) {
        const reservation = await findReservation(
          em,
          context.tenantId,
          propertyId,
          input.reservation_id,
        );
        if (!reservation) throw new PropertyError('NOT_FOUND');
      }
      const folio = await translatePropertyWrite(() =>
        repo.insertFolio(em, {
          tenantId: context.tenantId,
          propertyId,
          reservationId: input.reservation_id ?? null,
          kind,
          payerLabel,
          currency,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.folio_opened',
        resourceType: 'folio',
        resourceId: folio.id,
        outcome: 'SUCCESS',
        afterSafe: {
          kind: folio.kind,
          currency: folio.currency,
          reservation_id: folio.reservation_id,
        },
        correlationId: context.correlationId,
      });
      return { folio: repo.folioView(folio) };
    },
  );
}

export async function listFolios(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  filter: { reservation_id?: string | null; state?: string | null },
): Promise<Record<string, unknown>> {
  return withReadOperation(orm, context, propertyId, async (em) => {
    const rows = await repo.listFolioRows(em, {
      tenantId: context.tenantId,
      propertyId,
      reservationId: filter.reservation_id ?? null,
      state: filter.state ?? null,
    });
    return { folios: rows.map((row) => repo.folioView(row)) };
  });
}

export async function getFolio(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  folioId: string,
): Promise<Record<string, unknown>> {
  return withReadOperation(orm, context, propertyId, async (em) => {
    const folio = await requireFolio(em, context.tenantId, propertyId, folioId);
    const charges = await repo.listChargesForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const allocations = await repo.listAllocationsForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const deposits = await repo.listDepositsForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const payments = await paymentRepo.listPaymentsForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const refunds = await refundRepo.listRefundsForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const entitlements = await repo.listEntitlementsForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const schedules = await repo.listSchedulesForFolio(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const depositTotals: {
      amount: string;
      applied: string;
      released: string;
    }[] = [];
    const depositViews = [];
    for (const deposit of deposits) {
      const sums = await repo.sumDepositApplications(
        em,
        context.tenantId,
        propertyId,
        deposit.id,
      );
      const applied = moneyFromString(sums.applied);
      const released = moneyFromString(sums.released);
      const held = moneyFromString(deposit.amount) - applied - released;
      depositTotals.push({
        amount: deposit.amount,
        applied: sums.applied,
        released: sums.released,
      });
      depositViews.push({
        id: deposit.id,
        kind: deposit.kind,
        method: deposit.method,
        currency: deposit.currency,
        amount: normalizeMoney(deposit.amount),
        applied: formatMoney(applied),
        released: formatMoney(released),
        held: formatMoney(held),
        external_reference: deposit.external_reference,
        source_ref: deposit.source_ref,
        journal_id: deposit.journal_id,
      });
    }
    const entitlementViews = [];
    for (const entitlement of entitlements) {
      const consumed = await repo.sumConsumedQuantity(em, entitlement.id);
      entitlementViews.push({
        id: entitlement.id,
        code: entitlement.code,
        quantity_total: entitlement.quantity_total,
        quantity_consumed: consumed,
        unit_net_amount: normalizeMoney(entitlement.unit_net_amount),
        unit_tax_amount: normalizeMoney(entitlement.unit_tax_amount),
        currency: entitlement.currency,
        state: entitlement.state,
      });
    }
    const adjustments = await clearanceRepo.sumFolioAdjustments(
      em,
      context.tenantId,
      propertyId,
      folioId,
    );
    const totals = computeFolioTotals({
      folioId,
      charges,
      allocations,
      deposits: depositTotals,
      payments,
      refunds,
      adjustments,
    });
    return {
      folio: repo.folioView(folio),
      charges: charges.map((charge) => repo.chargeView(charge)),
      allocations: allocations.map((allocation) => ({
        id: allocation.id,
        charge_id: allocation.charge_id,
        payer_folio_id: allocation.payer_folio_id,
        amount: allocation.amount,
        journal_id: allocation.journal_id,
      })),
      deposits: depositViews,
      payments: payments.map((payment) => paymentRepo.paymentView(payment)),
      refunds: refunds.map((refund) => refundRepo.refundView(refund)),
      entitlements: entitlementViews,
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        code: schedule.code,
        account_code: schedule.account_code,
        quantity: schedule.quantity,
        net_amount: normalizeMoney(schedule.net_amount),
        tax_amount: normalizeMoney(schedule.tax_amount),
        currency: schedule.currency,
        interval: schedule.interval,
        starts_on: schedule.starts_on,
        ends_on: schedule.ends_on,
        state: schedule.state,
        version: schedule.version,
      })),
      totals: {
        charges_total: formatMoney(totals.charges_total),
        adjustments_total: formatMoney(totals.adjustments_total),
        routed_out: formatMoney(totals.routed_out),
        routed_in: formatMoney(totals.routed_in),
        deposits_held: formatMoney(totals.deposits_held),
        deposits_applied: formatMoney(totals.deposits_applied),
        payments_total: formatMoney(totals.payments_total),
        refunds_total: formatMoney(totals.refunds_total),
        balance_due: formatMoney(totals.balance_due),
      },
    };
  });
}

export async function postCharge(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: PostChargeInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const net = postableMoney(input.net_money, 'net_money');
  const tax = optionalPostableMoney(input.tax_money, 'tax_money') ?? {
    scaled: 0n,
    formatted: '0',
  };
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'PostCharge',
    input.idempotencyKey,
    {
      folio_id: input.folio_id,
      business_date: input.business_date,
      net_money: net.formatted,
      tax_money: tax.formatted,
      source_ref: sourceRef,
    },
    async (em, timezone) => {
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        input.folio_id,
      );
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
      assertMoneyCurrency(
        input.tax_money_currency,
        currency,
        'tax_money.currency',
      );
      const { charge } = await postChargeInternal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        folio,
        businessDate: input.business_date,
        kind: 'MANUAL',
        accountCode: assertAccountCode(input.account_code),
        netScaled: net.scaled,
        taxScaled: tax.scaled,
        taxPolicy: assertTaxPolicy(input.tax_policy),
        policySnapshotId: input.policy_snapshot_id ?? null,
        sourceKind: 'MANUAL',
        sourceRef,
        periodStart: null,
        periodEnd: null,
        memo:
          input.memo == null ? null : assertSafeText(input.memo, 'memo', 500),
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
      ]);
      return repo.chargeView(charge);
    },
  );
}

export interface StayNightChargeInput {
  tenantId: string;
  propertyId: string;
  timezone: string;
  businessDate: string;
  folio: FolioRow;
  itemId: string;
  amount: string;
  currency: string;
  correlationId: string | null;
  actor: {
    actorType: 'USER' | 'SERVICE';
    actorId: string | null;
    actorLabel: string | null;
  };
}

/**
 * Posts the one room-night accrual for a stay. The source key
 * `STAY_NIGHT/<item_id>:<business_date>` is unique per tenant/property, so a
 * resumed night audit can call this again and get the existing charge instead
 * of a second journal (AT-F06). The charge goes through the same
 * journal-service posting rules as every other charge: balanced per currency,
 * immutable once posted, and rejected outside the open day.
 */
export async function postStayNightCharge(
  em: EntityManager,
  input: StayNightChargeInput,
): Promise<{ charge: FolioChargeRow; created: boolean }> {
  const sourceRef = `${input.itemId}:${input.businessDate}`;
  const existing = await repo.findChargeBySource(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    sourceKind: 'STAY_NIGHT',
    sourceRef,
  });
  if (existing) return { charge: existing, created: false };
  if (input.currency !== input.folio.currency)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'currency',
      reason: 'folio_currency_mismatch',
    });
  const amount = postableMoney(input.amount, 'amount');
  const { charge } = await postChargeInternal(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    timezone: input.timezone,
    folio: input.folio,
    businessDate: input.businessDate,
    kind: 'ACCRUAL',
    accountCode: financeAccounts.REVENUE_ROOM,
    netScaled: amount.scaled,
    taxScaled: 0n,
    taxPolicy: {},
    policySnapshotId: null,
    sourceKind: 'STAY_NIGHT',
    sourceRef,
    periodStart: input.businessDate,
    periodEnd: addIsoDays(input.businessDate, 1),
    memo: `Night ${input.businessDate}`,
    actor: input.actor,
    correlationId: input.correlationId,
  });
  return { charge, created: true };
}

export async function routeCharge(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  chargeId: string,
  input: {
    allocations: {
      payer_folio_id: string;
      money: string;
      currency?: string | null;
    }[];
    memo?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Array.isArray(input.allocations) || input.allocations.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'allocations' });
  const allocations = input.allocations.map((allocation, index) => {
    const amount = postableMoney(
      allocation.money,
      `allocations[${index}].money`,
    );
    return {
      payerFolioId: allocation.payer_folio_id,
      amount,
      currency: allocation.currency ?? null,
    };
  });
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'RouteCharge',
    input.idempotencyKey,
    {
      charge_id: chargeId,
      allocations: allocations.map((allocation) => ({
        payer_folio_id: allocation.payerFolioId,
        money: allocation.amount.formatted,
      })),
    },
    async (em, timezone) => {
      const charge = await repo.findCharge(
        em,
        context.tenantId,
        propertyId,
        chargeId,
      );
      if (!charge) throw new PropertyError('NOT_FOUND');
      const existing = await repo.listAllocationsForCharge(
        em,
        context.tenantId,
        propertyId,
        chargeId,
      );
      const total =
        moneyFromString(charge.net_amount) + moneyFromString(charge.tax_amount);
      const already = sumStored(existing.map((row) => row.amount));
      const next = allocations.reduce(
        (sum, allocation) => sum + allocation.amount.scaled,
        0n,
      );
      if (already + next > total)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'allocations',
          reason: 'allocations_exceed_charge',
          remaining: formatMoney(total - already),
        });
      const payerFolios: FolioRow[] = [];
      for (const [index, allocation] of allocations.entries()) {
        if (allocation.payerFolioId === charge.folio_id)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'payer_folio_id',
            reason: 'same_folio',
          });
        const payer = await requireFolio(
          em,
          context.tenantId,
          propertyId,
          allocation.payerFolioId,
        );
        if (payer.state !== 'OPEN')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: payer.state,
            field: 'payer_folio_id',
          });
        if (payer.currency !== charge.currency)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'payer_folio_id',
            reason: 'currency_mismatch',
          });
        assertMoneyCurrency(
          allocation.currency,
          charge.currency,
          `allocations[${index}].money.currency`,
        );
        payerFolios.push(payer);
      }
      if (payerFolios.length !== allocations.length)
        throw new PropertyError('INVALID_REQUEST', { field: 'allocations' });
      const lines = [
        ...allocations.map((allocation) => ({
          account_code: financeAccounts.GUEST_RECEIVABLE,
          side: 'DEBIT' as const,
          amount: allocation.amount.scaled,
        })),
        {
          account_code: financeAccounts.GUEST_FOLIO,
          side: 'CREDIT' as const,
          amount: next,
        },
      ];
      const memo =
        input.memo === undefined || input.memo === null
          ? null
          : assertSafeText(input.memo, 'memo', 500);
      const { journal } = await postJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        businessDate: charge.business_date,
        timezone,
        currency: charge.currency,
        sourceType: 'ROUTING',
        sourceId: null,
        memo,
        correlationId: context.correlationId,
        actor: await auditActorOfWork(context),
        lines,
      });
      const inserted = [];
      for (const allocation of allocations) {
        const row = await translatePropertyWrite(() =>
          repo.insertAllocation(em, {
            tenantId: context.tenantId,
            propertyId,
            chargeId,
            payerFolioId: allocation.payerFolioId,
            amount: allocation.amount.formatted,
            journalId: journal.id,
            memo,
          }),
        );
        inserted.push(row);
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.charge_routed',
        resourceType: 'folio_charge',
        resourceId: chargeId,
        outcome: 'SUCCESS',
        afterSafe: {
          allocation_ids: inserted.map((row) => row.id),
          journal_id: journal.id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
        ...allocations.map((allocation) => allocation.payerFolioId),
      ]);
      return {
        charge_id: chargeId,
        journal_id: journal.id,
        allocations: inserted.map((row) => ({
          id: row.id,
          payer_folio_id: row.payer_folio_id,
          amount: row.amount,
        })),
      };
    },
  );
}

export async function createChargeSchedule(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  folioId: string,
  input: {
    code: string;
    account_code?: string | null;
    quantity?: number;
    net_money: string;
    net_money_currency?: string | null;
    tax_money?: string | null;
    tax_money_currency?: string | null;
    tax_policy?: Record<string, unknown> | null;
    currency?: string | null;
    interval: string;
    starts_on: string;
    ends_on?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const code = assertSafeText(input.code, 'code', 32);
  if (!scheduleIntervals.includes(input.interval as ScheduleInterval))
    throw new PropertyError('INVALID_REQUEST', { field: 'interval' });
  const interval = input.interval as ScheduleInterval;
  const net = postableMoney(input.net_money, 'net_money');
  const tax = optionalPostableMoney(input.tax_money, 'tax_money') ?? {
    scaled: 0n,
    formatted: '0',
  };
  assertIsoDate(input.starts_on, 'starts_on');
  if (input.ends_on) {
    assertIsoDate(input.ends_on, 'ends_on');
    if (input.ends_on <= input.starts_on)
      throw new PropertyError('INVALID_REQUEST', { field: 'ends_on' });
  }
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000)
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'CreateChargeSchedule',
    input.idempotencyKey,
    { folio_id: folioId, code, interval, starts_on: input.starts_on },
    async (em) => {
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        folioId,
      );
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
      assertMoneyCurrency(input.net_money_currency, currency, 'money.currency');
      assertMoneyCurrency(
        input.tax_money_currency,
        currency,
        'tax_money.currency',
      );
      const schedule = await translatePropertyWrite(() =>
        repo.insertSchedule(em, {
          tenantId: context.tenantId,
          propertyId,
          folioId,
          code,
          accountCode: assertAccountCode(input.account_code),
          quantity,
          netAmount: net.formatted,
          taxAmount: tax.formatted,
          taxPolicy: assertTaxPolicy(input.tax_policy),
          currency,
          interval,
          startsOn: input.starts_on,
          endsOn: input.ends_on ?? null,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.schedule_created',
        resourceType: 'charge_schedule',
        resourceId: schedule.id,
        outcome: 'SUCCESS',
        afterSafe: {
          folio_id: schedule.folio_id,
          code: schedule.code,
          interval: schedule.interval,
          starts_on: schedule.starts_on,
        },
        correlationId: context.correlationId,
      });
      return {
        id: schedule.id,
        folio_id: schedule.folio_id,
        code: schedule.code,
        account_code: schedule.account_code,
        quantity: schedule.quantity,
        net_amount: normalizeMoney(schedule.net_amount),
        tax_amount: normalizeMoney(schedule.tax_amount),
        currency: schedule.currency,
        interval: schedule.interval,
        starts_on: schedule.starts_on,
        ends_on: schedule.ends_on,
        state: schedule.state,
        version: schedule.version,
      };
    },
  );
}

export async function postSchedulePeriod(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  scheduleId: string,
  input: {
    business_date: string;
    period_start?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  if (input.period_start) assertIsoDate(input.period_start, 'period_start');
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'PostSchedulePeriod',
    input.idempotencyKey,
    {
      schedule_id: scheduleId,
      business_date: input.business_date,
      period_start: input.period_start ?? null,
    },
    async (em, timezone) => {
      const schedule = await repo.findSchedule(
        em,
        context.tenantId,
        propertyId,
        scheduleId,
      );
      if (!schedule) throw new PropertyError('NOT_FOUND');
      if (schedule.state !== 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: schedule.state,
        });
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        schedule.folio_id,
      );
      if (folio.state !== 'OPEN')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: folio.state,
        });
      const posted = await repo.countScheduleCharges(
        em,
        context.tenantId,
        propertyId,
        scheduleId,
      );
      let expected = schedule.starts_on;
      for (let index = 0; index < posted; index += 1)
        expected = addInterval(expected, schedule.interval as ScheduleInterval);
      const periodStart = input.period_start ?? expected;
      if (periodStart !== expected)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'period_start',
          reason: 'period_out_of_order',
          expected,
        });
      if (schedule.ends_on && periodStart > schedule.ends_on)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'EXHAUSTED',
          field: 'schedule',
        });
      const periodEnd = addInterval(
        periodStart,
        schedule.interval as ScheduleInterval,
      );
      const netScaled =
        moneyFromString(schedule.net_amount) * BigInt(schedule.quantity);
      const taxScaled =
        moneyFromString(schedule.tax_amount) * BigInt(schedule.quantity);
      const { charge } = await postChargeInternal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        folio,
        businessDate: input.business_date,
        kind: 'ACCRUAL',
        accountCode: schedule.account_code,
        netScaled,
        taxScaled,
        taxPolicy: schedule.tax_policy,
        policySnapshotId: null,
        sourceKind: 'ACCRUAL',
        sourceRef: `schedule:${schedule.id}:${periodStart}`,
        periodStart,
        periodEnd,
        memo: `schedule ${schedule.code}`,
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      let scheduleState = schedule.state;
      const nextPeriod = addInterval(
        periodStart,
        schedule.interval as ScheduleInterval,
      );
      if (schedule.ends_on && nextPeriod > schedule.ends_on) {
        await em.execute(
          `update "charge_schedule"
              set "state" = 'STOPPED', "version" = "version" + 1, "updated_at" = now()
            where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
          [schedule.id, context.tenantId, propertyId] as never[],
        );
        scheduleState = 'STOPPED';
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.schedule_posted',
        resourceType: 'charge_schedule',
        resourceId: schedule.id,
        outcome: 'SUCCESS',
        afterSafe: {
          period_start: periodStart,
          period_end: periodEnd,
          charge_id: charge.id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
      ]);
      return {
        ...repo.chargeView(charge),
        schedule_id: schedule.id,
        schedule_state: scheduleState,
        period_start: periodStart,
        period_end: periodEnd,
        replayed: false,
      };
    },
  );
}

export async function createPackageEntitlement(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  folioId: string,
  input: {
    code: string;
    account_code?: string | null;
    quantity_total: number;
    unit_net_money: string;
    unit_net_money_currency?: string | null;
    unit_tax_money?: string | null;
    unit_tax_money_currency?: string | null;
    tax_policy?: Record<string, unknown> | null;
    currency?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const code = assertSafeText(input.code, 'code', 32);
  if (
    !Number.isInteger(input.quantity_total) ||
    input.quantity_total < 1 ||
    input.quantity_total > 10000
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity_total' });
  const net = postableMoney(input.unit_net_money, 'unit_net_money');
  const tax = optionalPostableMoney(input.unit_tax_money, 'unit_tax_money') ?? {
    scaled: 0n,
    formatted: '0',
  };
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'CreatePackageEntitlement',
    input.idempotencyKey,
    { folio_id: folioId, code, quantity_total: input.quantity_total },
    async (em) => {
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        folioId,
      );
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
      assertMoneyCurrency(
        input.unit_net_money_currency,
        currency,
        'unit_money.currency',
      );
      assertMoneyCurrency(
        input.unit_tax_money_currency,
        currency,
        'unit_tax_money.currency',
      );
      const entitlement = await translatePropertyWrite(() =>
        repo.insertEntitlement(em, {
          tenantId: context.tenantId,
          propertyId,
          folioId,
          code,
          accountCode: assertAccountCode(input.account_code),
          quantityTotal: input.quantity_total,
          unitNetAmount: net.formatted,
          unitTaxAmount: tax.formatted,
          taxPolicy: assertTaxPolicy(input.tax_policy),
          currency,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.package_created',
        resourceType: 'package_entitlement',
        resourceId: entitlement.id,
        outcome: 'SUCCESS',
        afterSafe: {
          folio_id: entitlement.folio_id,
          code: entitlement.code,
          quantity_total: entitlement.quantity_total,
        },
        correlationId: context.correlationId,
      });
      return {
        id: entitlement.id,
        folio_id: entitlement.folio_id,
        code: entitlement.code,
        account_code: entitlement.account_code,
        quantity_total: entitlement.quantity_total,
        quantity_consumed: 0,
        unit_net_amount: normalizeMoney(entitlement.unit_net_amount),
        unit_tax_amount: normalizeMoney(entitlement.unit_tax_amount),
        currency: entitlement.currency,
        state: entitlement.state,
        version: entitlement.version,
      };
    },
  );
}

export async function consumePackage(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  entitlementId: string,
  input: {
    quantity: number;
    source_ref: string;
    business_date: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  assertIsoDate(input.business_date, 'business_date');
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 10000
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'ConsumePackage',
    input.idempotencyKey,
    {
      entitlement_id: entitlementId,
      quantity: input.quantity,
      source_ref: sourceRef,
      business_date: input.business_date,
    },
    async (em, timezone) => {
      const entitlement = await repo.findEntitlement(
        em,
        context.tenantId,
        propertyId,
        entitlementId,
      );
      if (!entitlement) throw new PropertyError('NOT_FOUND');
      if (entitlement.state !== 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: entitlement.state,
        });
      const existing = await repo.findConsumption(
        em,
        entitlementId,
        'CONSUMPTION',
        sourceRef,
      );
      if (existing)
        throw new PropertyError('CONFLICT', {
          reason: 'duplicate_consumption',
          entitlement_id: entitlementId,
          source_ref: sourceRef,
        });
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        entitlement.folio_id,
      );
      if (folio.state !== 'OPEN')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: folio.state,
        });
      const consumed = await repo.sumConsumedQuantity(em, entitlementId);
      if (consumed + input.quantity > entitlement.quantity_total)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'quantity',
          reason: 'exceeds_entitlement',
          remaining: entitlement.quantity_total - consumed,
        });
      const netScaled =
        moneyFromString(entitlement.unit_net_amount) * BigInt(input.quantity);
      const taxScaled =
        moneyFromString(entitlement.unit_tax_amount) * BigInt(input.quantity);
      const { charge } = await postChargeInternal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        folio,
        businessDate: input.business_date,
        kind: 'PACKAGE',
        accountCode: entitlement.account_code,
        netScaled,
        taxScaled,
        taxPolicy: entitlement.tax_policy,
        policySnapshotId: null,
        sourceKind: 'PACKAGE',
        sourceRef: `package:${entitlementId}:${sourceRef}`,
        periodStart: null,
        periodEnd: null,
        memo: `package ${entitlement.code}`,
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      const consumption = await translatePropertyWrite(() =>
        repo.insertConsumption(em, {
          tenantId: context.tenantId,
          propertyId,
          entitlementId,
          quantity: input.quantity,
          sourceKind: 'CONSUMPTION',
          sourceRef,
          chargeId: charge.id,
        }),
      );
      const nextConsumed = consumed + input.quantity;
      if (nextConsumed >= entitlement.quantity_total)
        await translatePropertyWrite(() =>
          repo.updateEntitlementState(
            em,
            context.tenantId,
            propertyId,
            entitlementId,
            'EXHAUSTED',
          ),
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.package_consumed',
        resourceType: 'package_entitlement',
        resourceId: entitlementId,
        outcome: 'SUCCESS',
        afterSafe: {
          quantity: input.quantity,
          charge_id: charge.id,
          source_ref: sourceRef,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        charge.folio_id,
      ]);
      return {
        entitlement_id: entitlementId,
        quantity: input.quantity,
        quantity_consumed: nextConsumed,
        quantity_total: entitlement.quantity_total,
        state:
          nextConsumed >= entitlement.quantity_total ? 'EXHAUSTED' : 'ACTIVE',
        charge: repo.chargeView(charge),
        consumption_id: consumption.id,
      };
    },
  );
}

function methodAccount(method: string): string {
  if (method === 'CASH') return financeAccounts.CASH;
  if (method === 'BANK_TRANSFER') return financeAccounts.BANK;
  return financeAccounts.POS_CLEARING;
}

function depositLiability(kind: string): string {
  return kind === 'DAMAGE'
    ? financeAccounts.DAMAGE_DEPOSIT_LIABILITY
    : financeAccounts.DEPOSIT_LIABILITY;
}

async function postDepositJournal(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    timezone: string;
    businessDate: string;
    currency: string;
    sourceType: string;
    debitAccount: string;
    creditAccount: string;
    amount: bigint;
    memo: string | null;
    actor: {
      actorType: 'USER' | 'SERVICE';
      actorId: string | null;
      actorLabel: string | null;
    };
    correlationId: string | null;
  },
) {
  return postJournal(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    timezone: input.timezone,
    currency: input.currency,
    sourceType: input.sourceType,
    sourceId: null,
    memo: input.memo,
    correlationId: input.correlationId,
    actor: input.actor,
    lines: [
      {
        account_code: input.debitAccount,
        side: 'DEBIT' as const,
        amount: input.amount,
      },
      {
        account_code: input.creditAccount,
        side: 'CREDIT' as const,
        amount: input.amount,
      },
    ],
  });
}

export async function collectDeposit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  folioId: string,
  input: {
    kind: string;
    method: string;
    money: string;
    money_currency?: string | null;
    business_date: string;
    external_reference: string;
    source_ref: string;
    evidence_ref?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  if (!['DEPOSIT', 'DAMAGE'].includes(input.kind))
    throw new PropertyError('INVALID_REQUEST', { field: 'kind' });
  if (!['CASH', 'BANK_TRANSFER', 'EXTERNAL_POS'].includes(input.method))
    throw new PropertyError('INVALID_REQUEST', { field: 'method' });
  const amount = postableMoney(input.money, 'money');
  const externalReference = assertSafeText(
    input.external_reference,
    'external_reference',
    200,
  );
  const sourceRef = assertSafeText(input.source_ref, 'source_ref', 200);
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'CollectDeposit',
    input.idempotencyKey,
    {
      folio_id: folioId,
      kind: input.kind,
      method: input.method,
      money: amount.formatted,
      business_date: input.business_date,
      source_ref: sourceRef,
    },
    async (em, timezone) => {
      const folio = await requireFolio(
        em,
        context.tenantId,
        propertyId,
        folioId,
      );
      if (folio.state !== 'OPEN')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: folio.state,
        });
      assertMoneyCurrency(
        input.money_currency,
        folio.currency,
        'money.currency',
      );
      const existing = await repo.findDepositBySource(
        em,
        context.tenantId,
        propertyId,
        sourceRef,
      );
      if (existing)
        throw new PropertyError('SOURCE_ALREADY_POSTED', {
          source_ref: sourceRef,
          deposit_id: existing.id,
        });
      const { journal } = await postDepositJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        businessDate: input.business_date,
        currency: folio.currency,
        sourceType: 'DEPOSIT',
        debitAccount: methodAccount(input.method),
        creditAccount: depositLiability(input.kind),
        amount: amount.scaled,
        memo: `deposit ${input.kind}`,
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      let deposit;
      try {
        deposit = await repo.insertDeposit(em, {
          tenantId: context.tenantId,
          propertyId,
          folioId,
          kind: input.kind,
          method: input.method,
          currency: folio.currency,
          amount: amount.formatted,
          externalReference,
          evidenceRef: input.evidence_ref ?? null,
          sourceRef,
          journalId: journal.id,
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
        ...(await auditActorOfWork(context)),
        action: 'finance.deposit_collected',
        resourceType: 'folio_deposit',
        resourceId: deposit.id,
        outcome: 'SUCCESS',
        afterSafe: {
          folio_id: deposit.folio_id,
          kind: deposit.kind,
          method: deposit.method,
          amount: deposit.amount,
          journal_id: deposit.journal_id,
        },
        correlationId: context.correlationId,
      });
      return {
        id: deposit.id,
        folio_id: deposit.folio_id,
        kind: deposit.kind,
        method: deposit.method,
        currency: deposit.currency,
        amount: normalizeMoney(deposit.amount),
        external_reference: deposit.external_reference,
        source_ref: deposit.source_ref,
        journal_id: deposit.journal_id,
        held_amount: normalizeMoney(deposit.amount),
      };
    },
  );
}

export async function applyDeposit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  depositId: string,
  input: {
    charge_id: string;
    money: string;
    money_currency?: string | null;
    business_date: string;
    reason: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const amount = postableMoney(input.money, 'money');
  const reason = assertSafeText(input.reason, 'reason', 500);
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'ApplyDeposit',
    input.idempotencyKey,
    {
      deposit_id: depositId,
      charge_id: input.charge_id,
      money: amount.formatted,
      business_date: input.business_date,
      reason,
    },
    async (em, timezone) => {
      const deposit = await repo.findDeposit(
        em,
        context.tenantId,
        propertyId,
        depositId,
      );
      if (!deposit) throw new PropertyError('NOT_FOUND');
      assertMoneyCurrency(
        input.money_currency,
        deposit.currency,
        'money.currency',
      );
      const charge = await repo.findCharge(
        em,
        context.tenantId,
        propertyId,
        input.charge_id,
      );
      if (!charge) throw new PropertyError('NOT_FOUND');
      if (charge.folio_id !== deposit.folio_id)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'charge_id',
          reason: 'charge_not_on_deposit_folio',
        });
      const sums = await repo.sumDepositApplications(
        em,
        context.tenantId,
        propertyId,
        depositId,
      );
      const applied = moneyFromString(sums.applied);
      const released = moneyFromString(sums.released);
      const remaining = moneyFromString(deposit.amount) - applied - released;
      if (amount.scaled > remaining)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'money',
          reason: 'exceeds_deposit_remaining',
          remaining: formatMoney(remaining),
        });
      const chargeTotal =
        moneyFromString(charge.net_amount) + moneyFromString(charge.tax_amount);
      const chargeApplied = moneyFromString(
        await repo.sumAppliedToCharge(
          em,
          context.tenantId,
          propertyId,
          charge.id,
        ),
      );
      if (amount.scaled > chargeTotal - chargeApplied)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'money',
          reason: 'exceeds_charge_outstanding',
          remaining: formatMoney(chargeTotal - chargeApplied),
        });
      const { journal } = await postDepositJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        businessDate: input.business_date,
        currency: deposit.currency,
        sourceType: 'DEPOSIT_APPLICATION',
        debitAccount: depositLiability(deposit.kind),
        creditAccount: financeAccounts.GUEST_FOLIO,
        amount: amount.scaled,
        memo: reason,
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      const application = await repo.insertDepositApplication(em, {
        tenantId: context.tenantId,
        propertyId,
        depositId,
        chargeId: charge.id,
        kind: 'APPLY',
        amount: amount.formatted,
        reason,
        journalId: journal.id,
        correlationId: context.correlationId,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.deposit_applied',
        resourceType: 'folio_deposit',
        resourceId: depositId,
        outcome: 'SUCCESS',
        afterSafe: {
          charge_id: charge.id,
          amount: amount.formatted,
          journal_id: journal.id,
        },
        correlationId: context.correlationId,
      });
      await reopenClearanceForFolios(em, context, propertyId, [
        deposit.folio_id,
        charge.folio_id,
      ]);
      return {
        id: application.id,
        deposit_id: depositId,
        charge_id: charge.id,
        kind: 'APPLY',
        amount: normalizeMoney(application.amount),
        held_remaining: formatMoney(remaining - amount.scaled),
        journal_id: journal.id,
      };
    },
  );
}

export async function releaseDeposit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  depositId: string,
  input: {
    money: string;
    money_currency?: string | null;
    business_date: string;
    reason: string;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const amount = postableMoney(input.money, 'money');
  const reason = assertSafeText(input.reason, 'reason', 500);
  return withWriteOperation(
    orm,
    context,
    propertyId,
    'ReleaseDeposit',
    input.idempotencyKey,
    {
      deposit_id: depositId,
      money: amount.formatted,
      business_date: input.business_date,
      reason,
    },
    async (em, timezone) => {
      const deposit = await repo.findDeposit(
        em,
        context.tenantId,
        propertyId,
        depositId,
      );
      if (!deposit) throw new PropertyError('NOT_FOUND');
      assertMoneyCurrency(
        input.money_currency,
        deposit.currency,
        'money.currency',
      );
      const sums = await repo.sumDepositApplications(
        em,
        context.tenantId,
        propertyId,
        depositId,
      );
      const applied = moneyFromString(sums.applied);
      const released = moneyFromString(sums.released);
      const remaining = moneyFromString(deposit.amount) - applied - released;
      if (amount.scaled > remaining)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'money',
          reason: 'exceeds_deposit_remaining',
          remaining: formatMoney(remaining),
        });
      const { journal } = await postDepositJournal(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone,
        businessDate: input.business_date,
        currency: deposit.currency,
        sourceType: 'DEPOSIT_APPLICATION',
        debitAccount: depositLiability(deposit.kind),
        creditAccount: financeAccounts.REFUND_CLEARING,
        amount: amount.scaled,
        memo: reason,
        actor: await auditActorOfWork(context),
        correlationId: context.correlationId,
      });
      const application = await repo.insertDepositApplication(em, {
        tenantId: context.tenantId,
        propertyId,
        depositId,
        chargeId: null,
        kind: 'RELEASE',
        amount: amount.formatted,
        reason,
        journalId: journal.id,
        correlationId: context.correlationId,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...(await auditActorOfWork(context)),
        action: 'finance.deposit_released',
        resourceType: 'folio_deposit',
        resourceId: depositId,
        outcome: 'SUCCESS',
        afterSafe: {
          amount: amount.formatted,
          journal_id: journal.id,
        },
        correlationId: context.correlationId,
      });
      return {
        id: application.id,
        deposit_id: depositId,
        kind: 'RELEASE',
        amount: normalizeMoney(application.amount),
        held_remaining: formatMoney(remaining - amount.scaled),
        journal_id: journal.id,
      };
    },
  );
}
