import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import {
  findMembership,
  findMembershipById,
} from '../../identity/persistence/org-repository.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { findPropertyScope } from '../../reservations/persistence/reservation-repository.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import { formatMoney } from '../../finance/domain/money.js';
import { loadFolioFinancials } from '../../finance/application/clearance-service.js';
import { postStayNightCharge } from '../../finance/application/folio-service.js';
import {
  addIsoDays,
  ensureOpenBusinessDay,
} from '../../finance/application/business-day-service.js';
import * as financeRepo from '../../finance/persistence/finance-repository.js';
import type { BusinessDayRow } from '../../finance/persistence/finance-repository.js';
import type { FolioRow } from '../../finance/persistence/folio-repository.js';
import {
  exceptionDefinition,
  nightAuditSteps,
  runIsTerminal,
} from '../domain/audit-steps.js';
import type {
  NightAuditExceptionCode,
  NightAuditStepKey,
} from '../domain/audit-steps.js';
import * as repo from '../persistence/night-audit-repository.js';
import type {
  NightAuditExceptionRow,
  NightAuditRunRow,
  NightAuditStepRow,
} from '../persistence/night-audit-repository.js';

export interface StartNightAuditInput {
  business_date: string;
  idempotencyKey?: string | null;
}

export type RunNightAuditInput = StartNightAuditInput;

export interface ResolveNightAuditExceptionInput {
  owner_membership_id?: string | null;
  owner_label?: string | null;
  reason: string;
  idempotencyKey?: string | null;
}

interface AuditActor {
  actorType: 'USER' | 'SERVICE';
  actorId: string | null;
  actorLabel: string | null;
}

export interface EngineOptions {
  tenantId: string;
  propertyId: string;
  timezone: string;
  actor: AuditActor;
  correlationId: string | null;
  leaseOwner: string;
  leaseMs: number;
  lockProperty: boolean;
  stepDelayMs?: number;
  maxSteps?: number;
}

class LostLeaseError extends Error {
  constructor() {
    super('NIGHT_AUDIT_LEASE_LOST');
    this.name = 'LostLeaseError';
  }
}

class ValidationBlockedError extends Error {
  readonly checkpoint: Record<string, unknown>;
  constructor(checkpoint: Record<string, unknown>) {
    super('AUDIT_EXCEPTIONS_OPEN');
    this.name = 'ValidationBlockedError';
    this.checkpoint = checkpoint;
  }
}

function actorOf(context: ServiceContext): AuditActor {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCodeOf(error: unknown): string {
  if (error instanceof PropertyError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return 'INTERNAL_ERROR';
}

function errorDetailsOf(error: unknown): Record<string, unknown> {
  if (error instanceof PropertyError) return error.details;
  if (error instanceof Error) return { message: error.message.slice(0, 300) };
  return {};
}

function nightCellAmount(
  cells: unknown,
  businessDate: string,
): { amount: string; quantity: number } | null {
  if (!Array.isArray(cells)) return null;
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') continue;
    const record = cell as Record<string, unknown>;
    if (record['date'] !== businessDate) continue;
    const amount =
      typeof record['amount'] === 'string' ? record['amount'] : null;
    if (!amount) return null;
    const quantity =
      typeof record['quantity'] === 'number' &&
      Number.isInteger(record['quantity']) &&
      record['quantity'] > 0
        ? record['quantity']
        : 1;
    return { amount, quantity };
  }
  return null;
}

async function requireRun(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  runId: string,
  options: { forUpdate?: boolean } = {},
): Promise<NightAuditRunRow> {
  const run = await repo.findRunById(em, tenantId, propertyId, runId, options);
  if (!run) throw new PropertyError('NOT_FOUND');
  return run;
}

async function ensureRunForDate(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    timezone: string;
    businessDate: string;
    actor: AuditActor;
    correlationId: string | null;
  },
): Promise<{ run: NightAuditRunRow; created: boolean; day: BusinessDayRow }> {
  const day = await ensureOpenBusinessDay(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    date: input.businessDate,
    timezone: input.timezone,
  });
  if (day.business_date !== input.businessDate)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'business_date',
      reason: 'business_date_mismatch',
      active_business_date: day.business_date,
    });
  if (day.state === 'CLOSING')
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      business_date: day.business_date,
      state: day.state,
    });
  const inserted = await translatePropertyWrite(() =>
    repo.insertRun(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      businessDate: input.businessDate,
      actorKind: input.actor.actorType,
      actorId: input.actor.actorId,
      actorLabel: input.actor.actorLabel,
      correlationId: input.correlationId,
    }),
  );
  const run =
    inserted ??
    (await repo.findRunByDate(
      em,
      input.tenantId,
      input.propertyId,
      input.businessDate,
    ));
  if (!run)
    throw new PropertyError('CONFLICT', { reason: 'night_audit_run_missing' });
  await translatePropertyWrite(() =>
    repo.ensureSteps(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      runId: run.id,
      businessDate: run.business_date,
      steps: nightAuditSteps,
    }),
  );
  return { run, created: Boolean(inserted), day };
}

function stepViewList(steps: NightAuditStepRow[]) {
  return steps.map((step) => repo.stepView(step));
}

function exceptionViewList(exceptions: NightAuditExceptionRow[]) {
  return exceptions.map((exception) => repo.exceptionView(exception));
}

function auditActorInput(actor: AuditActor) {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
  };
}

/* ------------------------------- step work ------------------------------- */

interface StepContext {
  em: EntityManager;
  run: NightAuditRunRow;
  step: NightAuditStepRow;
  options: EngineOptions;
}

async function insertAuditException(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    businessDate: string;
    stepKey: string;
    code: NightAuditExceptionCode;
    subjectType: string;
    subjectId: string | null;
    message: string;
    details?: Record<string, unknown>;
    correlationId: string | null;
  },
): Promise<void> {
  const definition = exceptionDefinition(input.code);
  await translatePropertyWrite(() =>
    repo.insertException(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      runId: input.runId,
      businessDate: input.businessDate,
      stepKey: input.stepKey,
      code: input.code,
      severity: definition.severity,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      message: input.message,
      details: input.details,
      correlationId: input.correlationId,
    }),
  );
}

async function listOpenExceptionIds(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    code: NightAuditExceptionCode;
  },
): Promise<string[]> {
  const exceptions = await repo.listExceptions(
    em,
    input.tenantId,
    input.propertyId,
    input.runId,
  );
  return exceptions
    .filter((row) => row.code === input.code && row.state === 'OPEN')
    .map((row) => row.id);
}

async function autoResolve(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    runId: string;
    code: NightAuditExceptionCode;
    keepIds: string[];
  },
): Promise<void> {
  await translatePropertyWrite(() =>
    repo.autoResolveCleared(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      runId: input.runId,
      code: input.code,
      keepIds: input.keepIds,
      reason: 'condition_cleared',
    }),
  );
}

async function runPrepare(step: StepContext): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const day = await financeRepo.findBusinessDay(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  if (!day)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: run.business_date,
    });
  if (day.state === 'OPEN') {
    const advanced = await translatePropertyWrite(() =>
      financeRepo.advanceBusinessDay(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        id: day.id,
        fromState: 'OPEN',
        toState: 'AUDIT_PREPARING',
        closedAt: null,
      }),
    );
    if (!advanced)
      throw new PropertyError('BUSINESS_DAY_BUSY', {
        business_date: run.business_date,
        reason: 'prepare_transition_failed',
      });
  }
  return {
    business_date: run.business_date,
    timezone: options.timezone,
    day_state: day.state === 'OPEN' ? 'AUDIT_PREPARING' : day.state,
  };
}

async function runArrivals(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const arrivals = await repo.listUnresolvedArrivals(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  const keep: string[] = [];
  for (const arrival of arrivals) {
    await insertAuditException(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      runId: run.id,
      businessDate: run.business_date,
      stepKey: step.step.step_key,
      code: 'ARRIVAL_NOT_RESOLVED',
      subjectType: 'RESERVATION_ITEM',
      subjectId: arrival.item_id,
      message: `Arrival ${arrival.arrival} is still not checked in`,
      details: {
        reservation_id: arrival.reservation_id,
        arrival: arrival.arrival,
      },
      correlationId: options.correlationId,
    });
    keep.push(arrival.item_id);
  }
  const previous = await listOpenExceptionIds(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'ARRIVAL_NOT_RESOLVED',
  });
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'ARRIVAL_NOT_RESOLVED',
    keepIds: keep,
  });
  return {
    arrivals: arrivals.length,
    exception_ids: previous.length,
    kept: keep.length,
  };
}

async function runDepartures(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const departures = await repo.listUnresolvedDepartures(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  const keep: string[] = [];
  for (const departure of departures) {
    await insertAuditException(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      runId: run.id,
      businessDate: run.business_date,
      stepKey: step.step.step_key,
      code: 'DEPARTURE_NOT_RESOLVED',
      subjectType: 'RESERVATION_ITEM',
      subjectId: departure.item_id,
      message: `Departure ${departure.end_date} is still in house`,
      details: {
        reservation_id: departure.reservation_id,
        departure: departure.end_date,
      },
      correlationId: options.correlationId,
    });
    keep.push(departure.item_id);
  }
  const previous = await listOpenExceptionIds(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'DEPARTURE_NOT_RESOLVED',
  });
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'DEPARTURE_NOT_RESOLVED',
    keepIds: keep,
  });
  return {
    departures: departures.length,
    exception_ids: previous.length,
    kept: keep.length,
  };
}

async function runNightlyCharges(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const segments = await repo.listInHouseSegments(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  const seen = new Set<string>();
  const openFolios = await repo.listOpenFolios(
    em,
    options.tenantId,
    options.propertyId,
  );
  const guestFolioByReservation = new Map<string, repo.OpenFolioRow>();
  const anyFolioByReservation = new Map<string, repo.OpenFolioRow>();
  for (const folio of openFolios) {
    if (!folio.reservation_id) continue;
    if (
      folio.kind === 'GUEST' &&
      !guestFolioByReservation.has(folio.reservation_id)
    )
      guestFolioByReservation.set(folio.reservation_id, folio);
    if (!anyFolioByReservation.has(folio.reservation_id))
      anyFolioByReservation.set(folio.reservation_id, folio);
  }
  let charged = 0;
  let reused = 0;
  let skippedZero = 0;
  const missingFolioKeep: string[] = [];
  const missingPriceKeep: string[] = [];
  const currencyKeep: string[] = [];
  for (const segment of segments) {
    if (seen.has(segment.item_id)) continue;
    seen.add(segment.item_id);
    const folio =
      guestFolioByReservation.get(segment.reservation_id) ??
      anyFolioByReservation.get(segment.reservation_id);
    if (!folio) {
      missingFolioKeep.push(segment.reservation_id);
      await insertAuditException(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        runId: run.id,
        businessDate: run.business_date,
        stepKey: step.step.step_key,
        code: 'MISSING_FOLIO',
        subjectType: 'RESERVATION',
        subjectId: segment.reservation_id,
        message: 'In-house stay has no open folio for the nightly charge',
        details: { item_id: segment.item_id },
        correlationId: options.correlationId,
      });
      continue;
    }
    if (!segment.price_snapshot_id) {
      missingPriceKeep.push(segment.item_id);
      await insertAuditException(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        runId: run.id,
        businessDate: run.business_date,
        stepKey: step.step.step_key,
        code: 'MISSING_PRICE',
        subjectType: 'RESERVATION_ITEM',
        subjectId: segment.item_id,
        message: 'In-house stay has no price snapshot for the night',
        details: { reservation_id: segment.reservation_id },
        correlationId: options.correlationId,
      });
      continue;
    }
    const quote = await repo.findPriceSnapshot(
      em,
      options.tenantId,
      options.propertyId,
      segment.price_snapshot_id,
    );
    const cell = quote ? nightCellAmount(quote.cells, run.business_date) : null;
    if (!quote || !cell) {
      missingPriceKeep.push(segment.item_id);
      await insertAuditException(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        runId: run.id,
        businessDate: run.business_date,
        stepKey: step.step.step_key,
        code: 'MISSING_PRICE',
        subjectType: 'RESERVATION_ITEM',
        subjectId: segment.item_id,
        message: `Price cell missing for ${run.business_date}`,
        details: { price_snapshot_id: segment.price_snapshot_id },
        correlationId: options.correlationId,
      });
      continue;
    }
    if (quote.currency !== folio.currency) {
      currencyKeep.push(segment.item_id);
      await insertAuditException(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        runId: run.id,
        businessDate: run.business_date,
        stepKey: step.step.step_key,
        code: 'RATE_CURRENCY_MISMATCH',
        subjectType: 'RESERVATION_ITEM',
        subjectId: segment.item_id,
        message: 'Rate snapshot currency differs from the folio currency',
        details: {
          quote_currency: quote.currency,
          folio_currency: folio.currency,
        },
        correlationId: options.correlationId,
      });
      continue;
    }
    const scaled =
      parseDecimal(cell.amount, 'amount') * BigInt(Math.max(1, cell.quantity));
    if (scaled <= 0n) {
      skippedZero += 1;
      continue;
    }
    const folioRow: FolioRow = {
      id: folio.id,
      tenant_id: options.tenantId,
      property_id: options.propertyId,
      reservation_id: folio.reservation_id,
      kind: folio.kind,
      payer_label: '',
      currency: folio.currency,
      state: folio.state,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    try {
      const result = await postStayNightCharge(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        timezone: options.timezone,
        businessDate: run.business_date,
        folio: folioRow,
        itemId: segment.item_id,
        amount: formatMoney(scaled),
        currency: quote.currency,
        correlationId: options.correlationId,
        actor: auditActorInput(options.actor),
      });
      if (result.created) charged += 1;
      else reused += 1;
    } catch (error) {
      if (
        error instanceof PropertyError &&
        error.code === 'SOURCE_ALREADY_POSTED'
      ) {
        reused += 1;
        continue;
      }
      throw error;
    }
  }
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'MISSING_FOLIO',
    keepIds: missingFolioKeep,
  });
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'MISSING_PRICE',
    keepIds: missingPriceKeep,
  });
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'RATE_CURRENCY_MISMATCH',
    keepIds: currencyKeep,
  });
  return {
    stays: seen.size,
    charged,
    reused,
    skipped_zero: skippedZero,
    missing_folio: missingFolioKeep.length,
    missing_price: missingPriceKeep.length,
    currency_mismatch: currencyKeep.length,
  };
}

async function runBalances(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const day = await financeRepo.findBusinessDay(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  if (!day)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: run.business_date,
    });
  if (day.state === 'AUDIT_PREPARING') {
    const advanced = await translatePropertyWrite(() =>
      financeRepo.advanceBusinessDay(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        id: day.id,
        fromState: 'AUDIT_PREPARING',
        toState: 'AUDIT_VALIDATION',
        closedAt: null,
      }),
    );
    if (!advanced)
      throw new PropertyError('BUSINESS_DAY_BUSY', {
        business_date: run.business_date,
        reason: 'validation_transition_failed',
      });
  }
  const folios = await repo.listOpenFolios(
    em,
    options.tenantId,
    options.propertyId,
  );
  const keep: string[] = [];
  let outstanding = 0;
  const totalsByCurrency = new Map<string, bigint>();
  for (const folio of folios) {
    const financials = await loadFolioFinancials(
      em,
      options.tenantId,
      options.propertyId,
      folio.id,
    );
    if (financials.totals.balance_due !== 0n) {
      outstanding += 1;
      keep.push(folio.id);
      const current = totalsByCurrency.get(folio.currency) ?? 0n;
      totalsByCurrency.set(
        folio.currency,
        current + financials.totals.balance_due,
      );
      await insertAuditException(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        runId: run.id,
        businessDate: run.business_date,
        stepKey: step.step.step_key,
        code: 'OUTSTANDING_BALANCE',
        subjectType: 'FOLIO',
        subjectId: folio.id,
        message: 'Open folio has a non-zero balance at night audit',
        details: {
          currency: folio.currency,
          balance_due: formatMoney(financials.totals.balance_due),
          kind: folio.kind,
        },
        correlationId: options.correlationId,
      });
    }
  }
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'OUTSTANDING_BALANCE',
    keepIds: keep,
  });
  return {
    folios: folios.length,
    outstanding,
    totals_by_currency: Object.fromEntries(
      [...totalsByCurrency.entries()].map(([currency, value]) => [
        currency,
        formatMoney(value),
      ]),
    ),
  };
}

async function runPaymentsRecon(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const payments = await repo.listUnknownPayments(
    em,
    options.tenantId,
    options.propertyId,
  );
  const keep: string[] = [];
  for (const payment of payments) {
    keep.push(payment.id);
    await insertAuditException(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      runId: run.id,
      businessDate: run.business_date,
      stepKey: step.step.step_key,
      code: 'PAYMENT_UNKNOWN',
      subjectType: 'PAYMENT',
      subjectId: payment.id,
      message: 'Payment is still UNKNOWN and must be reconciled',
      details: {
        folio_id: payment.folio_id,
        currency: payment.currency,
        amount: payment.amount,
      },
      correlationId: options.correlationId,
    });
  }
  await autoResolve(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    runId: run.id,
    code: 'PAYMENT_UNKNOWN',
    keepIds: keep,
  });
  return { unknown_payments: payments.length };
}

async function runValidate(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const blocking = await repo.countOpenBlockingExceptions(
    em,
    options.tenantId,
    options.propertyId,
    run.id,
  );
  if (blocking > 0)
    throw new ValidationBlockedError({
      open_blocking: blocking,
      reason: 'audit_exceptions_open',
    });
  const exceptions = await repo.listExceptions(
    em,
    options.tenantId,
    options.propertyId,
    run.id,
  );
  return {
    open_blocking: 0,
    acknowledged: exceptions.filter((row) => row.state === 'ACKNOWLEDGED')
      .length,
    warnings: exceptions.filter(
      (row) => row.state === 'OPEN' && row.severity === 'WARNING',
    ).length,
  };
}

async function runClosingBarrier(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const day = await financeRepo.findBusinessDay(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  if (!day)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: run.business_date,
    });
  if (day.state === 'AUDIT_VALIDATION') {
    const advanced = await translatePropertyWrite(() =>
      financeRepo.advanceBusinessDay(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        id: day.id,
        fromState: 'AUDIT_VALIDATION',
        toState: 'CLOSING',
        closedAt: null,
      }),
    );
    if (!advanced)
      throw new PropertyError('BUSINESS_DAY_BUSY', {
        business_date: run.business_date,
        reason: 'closing_transition_failed',
      });
  } else if (day.state !== 'CLOSING' && day.state !== 'CLOSED') {
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      business_date: run.business_date,
      state: day.state,
      reason: 'not_validated',
    });
  }
  await translatePropertyWrite(() =>
    repo.insertEvent(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      runId: run.id,
      businessDate: run.business_date,
      stepKey: step.step.step_key,
      event: 'night_audit.closing_barrier',
      message:
        'CLOSING barrier engaged; new postings get BUSY until the next day opens',
      actorKind: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel,
      correlationId: options.correlationId,
    }),
  );
  return { day_state: day.state === 'CLOSED' ? 'CLOSED' : 'CLOSING' };
}

async function closeDayAndOpenNext(
  em: EntityManager,
  options: EngineOptions,
  run: NightAuditRunRow,
): Promise<{ closed: BusinessDayRow; opened: BusinessDayRow }> {
  const day = await financeRepo.findBusinessDay(
    em,
    options.tenantId,
    options.propertyId,
    run.business_date,
  );
  if (!day)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: run.business_date,
    });
  let closed: BusinessDayRow;
  if (day.state === 'CLOSING') {
    const advanced = await translatePropertyWrite(() =>
      financeRepo.advanceBusinessDay(em, {
        tenantId: options.tenantId,
        propertyId: options.propertyId,
        id: day.id,
        fromState: 'CLOSING',
        toState: 'CLOSED',
        closedAt: new Date(),
      }),
    );
    if (!advanced)
      throw new PropertyError('BUSINESS_DAY_BUSY', {
        business_date: run.business_date,
        reason: 'close_transition_failed',
      });
    closed = advanced;
  } else if (day.state === 'CLOSED') {
    closed = day;
  } else {
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      business_date: run.business_date,
      state: day.state,
      reason: 'not_closing',
    });
  }
  const nextDate = addIsoDays(run.business_date, 1);
  await translatePropertyWrite(() =>
    financeRepo.insertBusinessDay(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      date: nextDate,
    }),
  );
  const opened = await financeRepo.findActiveBusinessDay(
    em,
    options.tenantId,
    options.propertyId,
    { forUpdate: true },
  );
  if (!opened || opened.business_date !== nextDate)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: nextDate,
      reason: 'next_day_open_failed',
    });
  await recordAudit(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    ...auditActorInput(options.actor),
    action: 'finance.business_day_closed',
    resourceType: 'business_day',
    resourceId: closed.id,
    outcome: 'SUCCESS',
    afterSafe: {
      business_date: closed.business_date,
      opened_business_date: opened.business_date,
    },
    correlationId: options.correlationId,
  });
  return { closed, opened };
}

async function runCloseDay(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const closed = await closeDayAndOpenNext(step.em, step.options, step.run);
  return {
    closed: financeRepo.businessDayView(closed.closed),
    opened: financeRepo.businessDayView(closed.opened),
  };
}

function closeResultFromSteps(
  steps: NightAuditStepRow[],
): Record<string, unknown> | null {
  const close = steps.find((row) => row.step_key === 'CLOSE_DAY');
  const checkpoint = close?.checkpoint as
    { closed?: unknown; opened?: unknown } | null | undefined;
  if (!checkpoint?.closed || !checkpoint?.opened) return null;
  return {
    closed: checkpoint.closed,
    opened: checkpoint.opened,
    business_day: checkpoint.opened,
    replayed: false,
  };
}

async function runFinalize(
  step: StepContext,
): Promise<Record<string, unknown>> {
  const { em, run, options } = step;
  const steps = await repo.listSteps(
    em,
    options.tenantId,
    options.propertyId,
    run.id,
  );
  const result = closeResultFromSteps(steps);
  if (!result)
    throw new PropertyError('NIGHT_AUDIT_FAILED', {
      reason: 'close_step_checkpoint_missing',
    });
  return { state: 'SUCCEEDED', result };
}

async function executeStepWork(
  context: StepContext,
): Promise<Record<string, unknown>> {
  switch (context.step.step_key as NightAuditStepKey) {
    case 'PREPARE':
      return runPrepare(context);
    case 'ARRIVALS':
      return runArrivals(context);
    case 'DEPARTURES':
      return runDepartures(context);
    case 'NIGHTLY_CHARGES':
      return runNightlyCharges(context);
    case 'BALANCES':
      return runBalances(context);
    case 'PAYMENTS_RECON':
      return runPaymentsRecon(context);
    case 'VALIDATE':
      return runValidate(context);
    case 'CLOSING_BARRIER':
      return runClosingBarrier(context);
    case 'CLOSE_DAY':
      return runCloseDay(context);
    case 'FINALIZE':
      return runFinalize(context);
    default:
      throw new PropertyError('NIGHT_AUDIT_FAILED', {
        reason: 'unknown_step',
        step_key: context.step.step_key,
      });
  }
}

/* ------------------------------- engine loop ------------------------------ */

export interface StepExecutionOutcome {
  done: boolean;
  blocked: boolean;
  failed: boolean;
  leaseLost: boolean;
  stepKey: string | null;
  errorCode?: string;
}

async function markStepFailure(
  orm: MikroORM,
  options: EngineOptions,
  input: {
    runId: string;
    stepId: string | null;
    stepKey: string | null;
    state: 'FAILED' | 'VALIDATION_FAILED';
    code: string;
    details: Record<string, unknown>;
    level: 'WARN' | 'ERROR';
    event: string;
    checkpoint?: Record<string, unknown>;
  },
): Promise<void> {
  await runScopedTransaction(
    orm,
    { tenantId: options.tenantId, userId: options.actor.actorId },
    async (em) => {
      const run = await requireRun(
        em,
        options.tenantId,
        options.propertyId,
        input.runId,
        { forUpdate: true },
      );
      if (runIsTerminal(run.state)) return;
      if (input.stepId) {
        await translatePropertyWrite(() =>
          repo.updateStep(em, {
            tenantId: options.tenantId,
            propertyId: options.propertyId,
            stepId: input.stepId as string,
            state: 'FAILED',
            checkpoint: input.checkpoint,
            errorCode: input.code,
            error: input.details,
            correlationId: options.correlationId,
            incrementAttempts: true,
          }),
        );
      }
      await translatePropertyWrite(async () => {
        await repo.finishRun(em, {
          tenantId: options.tenantId,
          propertyId: options.propertyId,
          runId: input.runId,
          state: input.state,
          result: run.result ?? null,
          errorCode: input.code,
          error: input.details,
        });
        await repo.insertEvent(em, {
          tenantId: options.tenantId,
          propertyId: options.propertyId,
          runId: input.runId,
          businessDate: run.business_date,
          stepKey: input.stepKey,
          level: input.level,
          event: input.event,
          message: input.code,
          data: input.details,
          actorKind: options.actor.actorType,
          actorId: options.actor.actorId,
          actorLabel: options.actor.actorLabel,
          correlationId: options.correlationId,
        });
      });
    },
  );
}

async function executeOneStep(
  orm: MikroORM,
  options: EngineOptions,
  runId: string,
): Promise<StepExecutionOutcome> {
  let stepId: string | null = null;
  let stepKey: string | null = null;
  try {
    return await runScopedTransaction(
      orm,
      { tenantId: options.tenantId, userId: options.actor.actorId },
      async (em) => {
        if (options.lockProperty)
          await lockProperty(em, options.tenantId, options.propertyId);
        const run = await requireRun(
          em,
          options.tenantId,
          options.propertyId,
          runId,
          { forUpdate: true },
        );
        if (runIsTerminal(run.state))
          return {
            done: true,
            blocked: false,
            failed: false,
            leaseLost: false,
            stepKey: null,
          };
        if (run.lease_owner !== options.leaseOwner)
          return {
            done: false,
            blocked: false,
            failed: false,
            leaseLost: true,
            stepKey: null,
          };
        const steps = await repo.listSteps(
          em,
          options.tenantId,
          options.propertyId,
          runId,
        );
        const next = steps.find(
          (row) => row.state !== 'DONE' && row.state !== 'SKIPPED',
        );
        if (!next) {
          return {
            done: true,
            blocked: false,
            failed: false,
            leaseLost: false,
            stepKey: null,
          };
        }
        stepId = next.id;
        stepKey = next.step_key;
        await translatePropertyWrite(() =>
          repo.updateStep(em, {
            tenantId: options.tenantId,
            propertyId: options.propertyId,
            stepId: next.id,
            state: 'RUNNING',
            errorCode: null,
            error: null,
            correlationId: options.correlationId,
            incrementAttempts: true,
          }),
        );
        await translatePropertyWrite(() =>
          repo.updateRunProgress(em, {
            tenantId: options.tenantId,
            propertyId: options.propertyId,
            runId,
            currentStep: next.step_key,
            stepsTotal: steps.length,
            stepsDone: steps.filter((row) => row.state === 'DONE').length,
          }),
        );
        const checkpoint = await executeStepWork({
          em,
          run,
          step: next,
          options,
        });
        await translatePropertyWrite(async () => {
          await repo.updateStep(em, {
            tenantId: options.tenantId,
            propertyId: options.propertyId,
            stepId: next.id,
            state: 'DONE',
            checkpoint,
            errorCode: null,
            error: null,
            correlationId: options.correlationId,
          });
          if (next.step_key === 'FINALIZE') {
            const finalSteps = await repo.listSteps(
              em,
              options.tenantId,
              options.propertyId,
              runId,
            );
            const result = closeResultFromSteps(finalSteps) ?? {};
            await repo.finishRun(em, {
              tenantId: options.tenantId,
              propertyId: options.propertyId,
              runId,
              state: 'SUCCEEDED',
              result,
              errorCode: null,
              error: null,
            });
            await repo.updateRunProgress(em, {
              tenantId: options.tenantId,
              propertyId: options.propertyId,
              runId,
              currentStep: next.step_key,
              stepsTotal: finalSteps.length,
              stepsDone: finalSteps.filter((row) => row.state === 'DONE')
                .length,
            });
            await repo.insertEvent(em, {
              tenantId: options.tenantId,
              propertyId: options.propertyId,
              runId,
              businessDate: run.business_date,
              stepKey: next.step_key,
              event: 'night_audit.run_succeeded',
              message: 'Business day closed and next day opened',
              actorKind: options.actor.actorType,
              actorId: options.actor.actorId,
              actorLabel: options.actor.actorLabel,
              correlationId: options.correlationId,
            });
          } else {
            await repo.updateRunProgress(em, {
              tenantId: options.tenantId,
              propertyId: options.propertyId,
              runId,
              currentStep: next.step_key,
              stepsTotal: steps.length,
              stepsDone: steps.filter((row) => row.state === 'DONE').length + 1,
            });
          }
          const renewed = await repo.renewLease(em, {
            tenantId: options.tenantId,
            propertyId: options.propertyId,
            runId,
            leaseOwner: options.leaseOwner,
            leaseMs: options.leaseMs,
          });
          if (!renewed) void 0;
        });
        return {
          done: next.step_key === 'FINALIZE',
          blocked: false,
          failed: false,
          leaseLost: false,
          stepKey: next.step_key,
        };
      },
    );
  } catch (error) {
    if (error instanceof LostLeaseError)
      return {
        done: false,
        blocked: false,
        failed: false,
        leaseLost: true,
        stepKey,
      };
    if (error instanceof ValidationBlockedError) {
      await markStepFailure(orm, options, {
        runId,
        stepId,
        stepKey,
        state: 'VALIDATION_FAILED',
        code: 'AUDIT_EXCEPTIONS_OPEN',
        details: error.checkpoint,
        level: 'WARN',
        event: 'night_audit.validation_failed',
        checkpoint: error.checkpoint,
      });
      return {
        done: false,
        blocked: true,
        failed: false,
        leaseLost: false,
        stepKey,
        errorCode: 'AUDIT_EXCEPTIONS_OPEN',
      };
    }
    await markStepFailure(orm, options, {
      runId,
      stepId,
      stepKey,
      state: 'FAILED',
      code: errorCodeOf(error),
      details: errorDetailsOf(error),
      level: 'ERROR',
      event: 'night_audit.step_failed',
    });
    return {
      done: false,
      blocked: false,
      failed: true,
      leaseLost: false,
      stepKey,
      errorCode: errorCodeOf(error),
    };
  }
}

export interface EngineOutcome {
  run: NightAuditRunRow;
  steps: NightAuditStepRow[];
  exceptions: NightAuditExceptionRow[];
  blocked: boolean;
  failed: boolean;
  leaseLost: boolean;
}

export async function executeNightAuditRun(
  orm: MikroORM,
  runId: string,
  options: EngineOptions,
): Promise<EngineOutcome> {
  const maxSteps = options.maxSteps ?? 100;
  let blocked = false;
  let failed = false;
  let leaseLost = false;
  for (let executed = 0; executed < maxSteps; executed += 1) {
    const outcome = await executeOneStep(orm, options, runId);
    if (outcome.leaseLost) {
      leaseLost = true;
      break;
    }
    if (outcome.blocked) {
      blocked = true;
      break;
    }
    if (outcome.failed) {
      failed = true;
      break;
    }
    if (outcome.done) break;
    if (options.stepDelayMs && options.stepDelayMs > 0)
      await delay(options.stepDelayMs);
  }
  return runScopedTransaction(
    orm,
    { tenantId: options.tenantId, userId: options.actor.actorId },
    async (em) => {
      const run = await requireRun(
        em,
        options.tenantId,
        options.propertyId,
        runId,
      );
      return {
        run,
        steps: await repo.listSteps(
          em,
          options.tenantId,
          options.propertyId,
          runId,
        ),
        exceptions: await repo.listExceptions(
          em,
          options.tenantId,
          options.propertyId,
          runId,
        ),
        blocked,
        failed,
        leaseLost,
      };
    },
  );
}

async function claimRun(
  em: EntityManager,
  options: EngineOptions,
  runId: string,
): Promise<NightAuditRunRow> {
  const claimed = await translatePropertyWrite(() =>
    repo.claimRun(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      runId,
      leaseOwner: options.leaseOwner,
      leaseMs: options.leaseMs,
    }),
  );
  if (!claimed)
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      reason: 'night_audit_run_in_progress',
    });
  return claimed;
}

function assertRunExecuted(outcome: EngineOutcome): Record<string, unknown> {
  if (outcome.leaseLost)
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      reason: 'night_audit_lease_lost',
    });
  if (outcome.failed)
    throw new PropertyError('NIGHT_AUDIT_FAILED', {
      run_id: outcome.run.id,
      last_error_code: outcome.run.last_error_code,
    });
  return {};
}

/* ------------------------------ public API ------------------------------- */

export async function getNightAuditOverview(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  date?: string | null,
): Promise<Record<string, unknown>> {
  if (date) assertIsoDate(date, 'date');
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
      const active = await financeRepo.findActiveBusinessDay(
        em,
        context.tenantId,
        propertyId,
      );
      let businessDate =
        date ?? active?.business_date ?? businessToday(property.timezone);
      // When the active day has no run yet, keep showing the latest completed
      // run (the operator just closed that day) instead of an empty screen.
      if (!date && active) {
        const activeRun = await repo.findRunByDate(
          em,
          context.tenantId,
          propertyId,
          active.business_date,
        );
        if (!activeRun) {
          const latest = await repo.listRunsForProperty(
            em,
            context.tenantId,
            propertyId,
            1,
          );
          if (latest[0]) businessDate = latest[0].business_date;
        }
      }
      const day = date
        ? await financeRepo.findBusinessDay(
            em,
            context.tenantId,
            propertyId,
            businessDate,
          )
        : businessDate === active?.business_date
          ? active
          : await financeRepo.findBusinessDay(
              em,
              context.tenantId,
              propertyId,
              businessDate,
            );
      const run = await repo.findRunByDate(
        em,
        context.tenantId,
        propertyId,
        businessDate,
      );
      const steps = run
        ? await repo.listSteps(em, context.tenantId, propertyId, run.id)
        : [];
      const exceptions = run
        ? await repo.listExceptions(em, context.tenantId, propertyId, run.id)
        : [];
      const events = run
        ? await repo.listEvents(em, context.tenantId, propertyId, run.id)
        : [];
      return {
        date: businessDate,
        active_business_date: active?.business_date ?? null,
        timezone: property.timezone,
        business_day: day ? financeRepo.businessDayView(day) : null,
        run: run ? repo.runView(run) : null,
        steps: stepViewList(steps),
        exceptions: exceptionViewList(exceptions),
        events: events.map((event) => repo.eventView(event)),
        open_blocking: exceptions.filter(
          (row) => row.state === 'OPEN' && row.severity === 'BLOCKING',
        ).length,
      };
    },
  );
}

export async function listNightAuditRuns(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const runs = await repo.listRunsForProperty(
        em,
        context.tenantId,
        propertyId,
      );
      return { runs: runs.map((run) => repo.runView(run)) };
    },
  );
}

export async function startNightAudit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: StartNightAuditInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'StartNightAudit',
    property_id: propertyId,
    business_date: input.business_date,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'business_day.close', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'StartNightAudit',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const { run, created } = await ensureRunForDate(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone: property.timezone,
        businessDate: input.business_date,
        actor: actorOf(context),
        correlationId: context.correlationId,
      });
      await translatePropertyWrite(() =>
        repo.insertEvent(em, {
          tenantId: context.tenantId,
          propertyId,
          runId: run.id,
          businessDate: run.business_date,
          event: created ? 'night_audit.run_queued' : 'night_audit.run_reused',
          message: created
            ? 'Night audit run queued for the worker'
            : 'Existing night audit run reused',
          actorKind: context.actor.kind,
          actorId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        }),
      );
      const result = {
        run: repo.runView(run),
        created,
        replayed: false,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'StartNightAudit',
        key,
        requestHash,
        response: result,
        resourceId: run.id,
      });
      return result;
    },
  );
}

export async function runNightAudit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: RunNightAuditInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.business_date, 'business_date');
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'RunNightAudit',
    property_id: propertyId,
    business_date: input.business_date,
  });
  const prepared = await runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'business_day.close', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'RunNightAudit',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return { kind: 'idempotent' as const, response: replayed };
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const existing = await repo.findRunByDate(
        em,
        context.tenantId,
        propertyId,
        input.business_date,
      );
      if (existing?.state === 'SUCCEEDED')
        return {
          kind: 'stored' as const,
          stored: (existing.result ?? {}) as Record<string, unknown>,
          runId: existing.id,
        };
      const { run } = await ensureRunForDate(em, {
        tenantId: context.tenantId,
        propertyId,
        timezone: property.timezone,
        businessDate: input.business_date,
        actor: actorOf(context),
        correlationId: context.correlationId,
      });
      if (run.state === 'FAILED' || run.state === 'VALIDATION_FAILED') {
        const requeued = await translatePropertyWrite(() =>
          repo.requeueRun(em, {
            tenantId: context.tenantId,
            propertyId,
            runId: run.id,
          }),
        );
        if (!requeued)
          throw new PropertyError('BUSINESS_DAY_BUSY', {
            run_id: run.id,
            reason: 'night_audit_requeue_failed',
          });
        await translatePropertyWrite(() =>
          repo.resetFailedSteps(em, {
            tenantId: context.tenantId,
            propertyId,
            runId: run.id,
          }),
        );
      }
      const options: EngineOptions = {
        tenantId: context.tenantId,
        propertyId,
        timezone: property.timezone,
        actor: actorOf(context),
        correlationId: context.correlationId,
        leaseOwner: `api-${process.pid}`,
        leaseMs: 60_000,
        lockProperty: true,
      };
      await claimRun(em, options, run.id);
      return {
        kind: 'execute' as const,
        runId: run.id,
        timezone: property.timezone,
      };
    },
  );
  if (prepared.kind === 'idempotent')
    return prepared.response as Record<string, unknown>;
  if (prepared.kind === 'stored') {
    const response = { ...prepared.stored, replayed: true };
    await runScopedTransaction(
      orm,
      { tenantId: context.tenantId, userId: context.actor.userId },
      async (em) => {
        await storeIdempotency(em, context, {
          propertyId,
          operation: 'RunNightAudit',
          key,
          requestHash,
          response,
          resourceId: prepared.runId,
        });
      },
    );
    return response;
  }
  const outcome = await executeNightAuditRun(orm, prepared.runId, {
    tenantId: context.tenantId,
    propertyId,
    timezone: prepared.timezone,
    actor: actorOf(context),
    correlationId: context.correlationId,
    leaseOwner: `api-${process.pid}`,
    leaseMs: 60_000,
    lockProperty: true,
  });
  assertRunExecuted(outcome);
  if (outcome.blocked) {
    const blocking = outcome.exceptions.filter(
      (row) => row.state === 'OPEN' && row.severity === 'BLOCKING',
    );
    throw new PropertyError('AUDIT_EXCEPTIONS_OPEN', {
      run_id: outcome.run.id,
      open_blocking: blocking.length,
      exceptions: blocking.map((row) => repo.exceptionView(row)),
    });
  }
  if (outcome.run.state !== 'SUCCEEDED')
    throw new PropertyError('NIGHT_AUDIT_FAILED', {
      run_id: outcome.run.id,
      state: outcome.run.state,
    });
  const stored = (outcome.run.result ?? {}) as Record<string, unknown>;
  const response = {
    ...stored,
    run: repo.runView(outcome.run),
    steps: stepViewList(outcome.steps),
    exceptions: exceptionViewList(outcome.exceptions),
    replayed: false,
  };
  await runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'RunNightAudit',
        key,
        requestHash,
        response,
        resourceId: outcome.run.id,
      });
    },
  );
  return response;
}

export async function retryNightAudit(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  runId: string,
  input: { idempotencyKey?: string | null },
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'RetryNightAudit',
    property_id: propertyId,
    run_id: runId,
  });
  const prepared = await runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'business_day.close', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'RetryNightAudit',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return { kind: 'idempotent' as const, response: replayed };
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const run = await requireRun(em, context.tenantId, propertyId, runId, {
        forUpdate: true,
      });
      if (run.state === 'SUCCEEDED')
        return {
          kind: 'stored' as const,
          stored: (run.result ?? {}) as Record<string, unknown>,
          runId: run.id,
        };
      if (run.state === 'PENDING' || run.state === 'RUNNING')
        throw new PropertyError('BUSINESS_DAY_BUSY', {
          run_id: run.id,
          state: run.state,
          reason: 'night_audit_run_in_progress',
        });
      const requeued = await translatePropertyWrite(() =>
        repo.requeueRun(em, {
          tenantId: context.tenantId,
          propertyId,
          runId: run.id,
        }),
      );
      if (!requeued)
        throw new PropertyError('NIGHT_AUDIT_NOT_RETRYABLE', {
          run_id: run.id,
          state: run.state,
        });
      await translatePropertyWrite(() =>
        repo.resetFailedSteps(em, {
          tenantId: context.tenantId,
          propertyId,
          runId: run.id,
        }),
      );
      await translatePropertyWrite(() =>
        repo.insertEvent(em, {
          tenantId: context.tenantId,
          propertyId,
          runId: run.id,
          businessDate: run.business_date,
          event: 'night_audit.run_retried',
          message: 'Failed night audit run requeued for retry',
          data: { previous_state: run.state },
          actorKind: context.actor.kind,
          actorId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        }),
      );
      const options: EngineOptions = {
        tenantId: context.tenantId,
        propertyId,
        timezone: property.timezone,
        actor: actorOf(context),
        correlationId: context.correlationId,
        leaseOwner: `api-${process.pid}`,
        leaseMs: 60_000,
        lockProperty: true,
      };
      await claimRun(em, options, run.id);
      return {
        kind: 'execute' as const,
        runId: run.id,
        timezone: property.timezone,
      };
    },
  );
  if (prepared.kind === 'idempotent')
    return prepared.response as Record<string, unknown>;
  if (prepared.kind === 'stored') {
    const response = { ...prepared.stored, replayed: true };
    await runScopedTransaction(
      orm,
      { tenantId: context.tenantId, userId: context.actor.userId },
      async (em) => {
        await storeIdempotency(em, context, {
          propertyId,
          operation: 'RetryNightAudit',
          key,
          requestHash,
          response,
          resourceId: prepared.runId,
        });
      },
    );
    return response;
  }
  const outcome = await executeNightAuditRun(orm, prepared.runId, {
    tenantId: context.tenantId,
    propertyId,
    timezone: prepared.timezone,
    actor: actorOf(context),
    correlationId: context.correlationId,
    leaseOwner: `api-${process.pid}`,
    leaseMs: 60_000,
    lockProperty: true,
  });
  assertRunExecuted(outcome);
  if (outcome.blocked) {
    const blocking = outcome.exceptions.filter(
      (row) => row.state === 'OPEN' && row.severity === 'BLOCKING',
    );
    throw new PropertyError('AUDIT_EXCEPTIONS_OPEN', {
      run_id: outcome.run.id,
      open_blocking: blocking.length,
      exceptions: blocking.map((row) => repo.exceptionView(row)),
    });
  }
  if (outcome.run.state !== 'SUCCEEDED')
    throw new PropertyError('NIGHT_AUDIT_FAILED', {
      run_id: outcome.run.id,
      state: outcome.run.state,
    });
  const stored = (outcome.run.result ?? {}) as Record<string, unknown>;
  const response = {
    ...stored,
    run: repo.runView(outcome.run),
    steps: stepViewList(outcome.steps),
    exceptions: exceptionViewList(outcome.exceptions),
    replayed: false,
  };
  await runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'RetryNightAudit',
        key,
        requestHash,
        response,
        resourceId: outcome.run.id,
      });
    },
  );
  return response;
}

export async function resolveNightAuditException(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  exceptionId: string,
  input: ResolveNightAuditExceptionInput,
): Promise<Record<string, unknown>> {
  const reason = assertSafeText(input.reason, 'reason', 500);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ResolveNightAuditException',
    property_id: propertyId,
    exception_id: exceptionId,
    reason,
    owner_membership_id: input.owner_membership_id ?? null,
    owner_label: input.owner_label ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'business_day.close', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'ResolveNightAuditException',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const exception = await repo.findException(
        em,
        context.tenantId,
        propertyId,
        exceptionId,
      );
      if (!exception) throw new PropertyError('NOT_FOUND');
      let ownerMembershipId = input.owner_membership_id ?? null;
      let ownerLabel = input.owner_label ?? null;
      if (ownerMembershipId) {
        const membership = await findMembershipById(
          em,
          context.tenantId,
          ownerMembershipId,
        );
        if (!membership) throw new PropertyError('NOT_FOUND');
        ownerLabel = ownerLabel ?? membership.user_id;
      } else if (context.actor.kind === 'USER' && context.actor.userId) {
        const membership = await findMembership(
          em,
          context.tenantId,
          context.actor.userId,
        );
        ownerMembershipId = membership?.id ?? null;
        ownerLabel = ownerLabel ?? context.actor.displayName;
      }
      if (!ownerMembershipId && !ownerLabel)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'owner_membership_id',
          reason: 'owner_required',
        });
      if (exception.state !== 'OPEN') {
        const result = {
          exception: repo.exceptionView(exception),
          replayed: true,
        };
        await storeIdempotency(em, context, {
          propertyId,
          operation: 'ResolveNightAuditException',
          key,
          requestHash,
          response: result,
          resourceId: exception.id,
        });
        return result;
      }
      const resolved = await translatePropertyWrite(() =>
        repo.resolveException(em, {
          tenantId: context.tenantId,
          propertyId,
          exceptionId: exception.id,
          state: 'ACKNOWLEDGED',
          ownerMembershipId,
          ownerLabel,
          reason,
          resolvedBy: context.actor.userId,
        }),
      );
      if (!resolved)
        throw new PropertyError('CONFLICT', {
          reason: 'exception_not_open',
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        actorType: context.actor.kind,
        actorId: context.actor.userId,
        actorLabel: context.actor.displayName,
        action: 'night_audit.exception_acknowledged',
        resourceType: 'night_audit_exception',
        resourceId: resolved.id,
        outcome: 'SUCCESS',
        afterSafe: {
          code: resolved.code,
          severity: resolved.severity,
          owner_label: resolved.owner_label,
          reason,
        },
        correlationId: context.correlationId,
      });
      await translatePropertyWrite(() =>
        repo.insertEvent(em, {
          tenantId: context.tenantId,
          propertyId,
          runId: resolved.run_id,
          businessDate: resolved.business_date,
          stepKey: resolved.step_key,
          level: 'WARN',
          event: 'night_audit.exception_acknowledged',
          message: resolved.message,
          data: {
            code: resolved.code,
            severity: resolved.severity,
            owner_label: resolved.owner_label,
            reason,
          },
          actorKind: context.actor.kind,
          actorId: context.actor.userId,
          actorLabel: context.actor.displayName,
          correlationId: context.correlationId,
        }),
      );
      const result = {
        exception: repo.exceptionView(resolved),
        replayed: false,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ResolveNightAuditException',
        key,
        requestHash,
        response: result,
        resourceId: resolved.id,
      });
      return result;
    },
  );
}
