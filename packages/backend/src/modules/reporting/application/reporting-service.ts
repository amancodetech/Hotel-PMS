import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { findMembership } from '../../identity/persistence/org-repository.js';
import {
  evaluatePolicy,
  policyError,
} from '../../identity/application/policy-service.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import {
  checkIdempotency,
  hashRequest,
  normalizeIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { formatMoney } from '../../finance/domain/money.js';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import {
  metric,
  periodNights,
  ratioMetric,
  reportKindDefinitions,
  reportKinds,
} from '../domain/metrics.js';
import type { ReportKind, ReportMetric } from '../domain/metrics.js';
import * as repo from '../persistence/reporting-repository.js';
import type {
  ItemRow,
  MaintenanceNightRow,
  ResourceNightClassRow,
  ResourceStateCountRow,
} from '../persistence/reporting-repository.js';

export interface ReportPeriodInput {
  date_from: string;
  date_to: string;
}

export interface ReadReportInput {
  kind: ReportKind;
  period: ReportPeriodInput;
  currency?: 'IDR' | 'USD' | null;
  resource_type?: string | null;
  reference_date?: string | null;
}

export interface CaptureSnapshotInput {
  reference_date?: string | null;
  idempotencyKey?: string | null;
}

export interface ReportRow {
  label: string;
  value: string;
  unit: string;
  state?: string;
  date?: string;
}

const MAX_PERIOD_DAYS = 366;
const MAX_ROWS = 100;
const HOUSEKEEPING_STATES = [
  'CLEAN',
  'DIRTY',
  'CLEANING',
  'INSPECTED',
] as const;
const MAINTENANCE_STATES = ['NONE', 'OOO', 'OOS'] as const;
const ACTIVE_ITEM_STATES = [
  'CONFIRMED',
  'IN_HOUSE',
  'CHECKED_OUT',
  'COMPLETED',
] as const;

/**
 * Response views must expose RFC 3339 instants; raw driver timestamps such as
 * `2026-09-16 07:21:26.866184+00` violate the contract and crash `formatInstant`.
 */
export function toIsoInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string).toISOString();
}

function assertKind(value: string): ReportKind {
  if (!(reportKinds as readonly string[]).includes(value))
    throw new PropertyError('INVALID_REQUEST', {
      field: 'kind',
      reason: 'unknown_report_kind',
    });
  return value as ReportKind;
}

export function validatePeriod(period: ReportPeriodInput): void {
  assertIsoDate(period.date_from, 'period.date_from');
  assertIsoDate(period.date_to, 'period.date_to');
  if (period.date_to <= period.date_from)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'period',
      reason: 'period_end_must_follow_start',
    });
  if (periodNights(period.date_from, period.date_to) > MAX_PERIOD_DAYS)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'period',
      reason: 'period_too_long',
    });
}

export function requireCurrency(
  kind: ReportKind,
  currency?: string | null,
): string {
  if (!reportKindDefinitions[kind].requiresCurrency) return '';
  if (currency !== 'IDR' && currency !== 'USD')
    throw new PropertyError('INVALID_REQUEST', {
      field: 'currency',
      reason: 'currency_required',
    });
  return currency;
}

function sumNights(
  rows: ResourceNightClassRow[],
  predicate: (row: ResourceNightClassRow) => boolean,
): number {
  return rows.filter(predicate).reduce((total, row) => total + row.nights, 0);
}

function resourceTypesOf(
  counts: Array<{ key: string; count: number }>,
  occupied: ResourceNightClassRow[],
  reserved: ResourceNightClassRow[],
): string[] {
  return [
    ...new Set([
      ...counts.map((row) => row.key),
      ...occupied.map((row) => row.resource_type),
      ...reserved.map((row) => row.resource_type),
    ]),
  ].sort();
}

function maintenanceNights(
  rows: MaintenanceNightRow[],
  resourceType: string,
  impact: 'OOO' | 'OOS',
): number {
  return rows
    .filter(
      (row) => row.resource_type === resourceType && row.impact === impact,
    )
    .reduce((total, row) => total + row.nights, 0);
}

/**
 * Money-per-night ratio with the shared six-place HALF_UP rule. A zero
 * denominator is declared as `null` with `DENOMINATOR_ZERO` instead of a
 * misleading zero; posted charges are non-negative, so the numerator is
 * handled as an unsigned scaled amount.
 */
function moneyRatioMetric(input: {
  key: string;
  label: string;
  revenue: bigint;
  denominator: bigint;
  unit: string;
  basis: ReportMetric['basis'];
}): ReportMetric {
  if (input.denominator === 0n)
    return metric({
      key: input.key,
      label: input.label,
      value: null,
      unit: input.unit,
      basis: input.basis,
      numerator: formatMoney(input.revenue),
      denominator: '0',
      nullReason: 'DENOMINATOR_ZERO',
    });
  const value =
    (input.revenue * 2n + input.denominator) / (2n * input.denominator);
  return metric({
    key: input.key,
    label: input.label,
    value: formatMoney(value),
    unit: input.unit,
    basis: input.basis,
    numerator: formatMoney(input.revenue),
    denominator: input.denominator.toString(),
  });
}

function occupancyMetrics(
  input: ReadReportInput,
  physical: Array<{ key: string; count: number }>,
  occupied: ResourceNightClassRow[],
  reserved: ResourceNightClassRow[],
  maintenance: MaintenanceNightRow[],
  housekeeping: ResourceStateCountRow[],
  maintenanceState: ResourceStateCountRow[],
): ReportMetric[] {
  const nights = periodNights(input.period.date_from, input.period.date_to);
  const metrics: ReportMetric[] = [];
  const types = [
    ...new Set([
      ...resourceTypesOf(physical, occupied, reserved),
      ...housekeeping.map((row) => row.resource_type),
      ...maintenanceState.map((row) => row.resource_type),
    ]),
  ]
    .filter((type) => !input.resource_type || type === input.resource_type)
    .sort();
  const stateCount = (
    source: ResourceStateCountRow[],
    type: string,
    state: string,
  ) =>
    source.find((row) => row.resource_type === type && row.key === state)
      ?.count ?? 0;
  for (const type of types) {
    const count = physical.find((row) => row.key === type)?.count ?? 0;
    const ooo = maintenanceNights(maintenance, type, 'OOO');
    const oos = maintenanceNights(maintenance, type, 'OOS');
    const physicalNights = BigInt(count * nights);
    const operationalNights =
      physicalNights - BigInt(ooo) > 0n ? physicalNights - BigInt(ooo) : 0n;
    const occupiedType = occupied.filter((row) => row.resource_type === type);
    const reservedType = reserved.filter((row) => row.resource_type === type);
    const occupiedTotal = BigInt(sumNights(occupiedType, () => true));
    const paid = BigInt(sumNights(occupiedType, (row) => row.class === 'PAID'));
    const owner = BigInt(
      sumNights(occupiedType, (row) => row.class === 'OWNER'),
    );
    const complimentary = BigInt(
      sumNights(occupiedType, (row) => row.class === 'COMPLIMENTARY'),
    );
    const reservedTotal = BigInt(sumNights(reservedType, () => true));
    const notReady =
      stateCount(maintenanceState, type, 'OOO') +
      stateCount(maintenanceState, type, 'OOS') +
      stateCount(housekeeping, type, 'DIRTY') +
      stateCount(housekeeping, type, 'CLEANING');
    for (const state of HOUSEKEEPING_STATES)
      metrics.push(
        metric({
          key: `housekeeping_${state.toLowerCase()}.${type}`,
          label: `housekeeping_${state.toLowerCase()}.${type}`,
          value: stateCount(housekeeping, type, state),
          unit: 'resource',
          basis: 'CURRENT_STATE',
        }),
      );
    for (const state of MAINTENANCE_STATES)
      metrics.push(
        metric({
          key: `maintenance_${state.toLowerCase()}.${type}`,
          label: `maintenance_${state.toLowerCase()}.${type}`,
          value: stateCount(maintenanceState, type, state),
          unit: 'resource',
          basis: 'CURRENT_STATE',
        }),
      );
    metrics.push(
      metric({
        key: `resources_not_ready_current.${type}`,
        label: `resources_not_ready_current.${type}`,
        value: notReady,
        unit: 'resource',
        basis: 'CURRENT_STATE',
      }),
    );
    metrics.push(
      metric({
        key: `resources_physical.${type}`,
        label: `resources_physical.${type}`,
        value: count,
        unit: 'resource',
        basis: 'PHYSICAL',
      }),
      metric({
        key: `resource_nights_available.${type}`,
        label: `resource_nights_available.${type}`,
        value: physicalNights.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
        numerator: physicalNights.toString(),
        denominator: '1',
      }),
      metric({
        key: `resource_nights_available_operational.${type}`,
        label: `resource_nights_available_operational.${type}`,
        value: operationalNights.toString(),
        unit: 'resource_night',
        basis: 'OPERATIONAL',
        numerator: operationalNights.toString(),
        denominator: '1',
      }),
      metric({
        key: `resource_nights_ooo.${type}`,
        label: `resource_nights_ooo.${type}`,
        value: ooo,
        unit: 'resource_night',
        basis: 'OPERATIONAL',
      }),
      metric({
        key: `resource_nights_oos.${type}`,
        label: `resource_nights_oos.${type}`,
        value: oos,
        unit: 'resource_night',
        basis: 'OPERATIONAL',
      }),
      metric({
        key: `resource_nights_reserved.${type}`,
        label: `resource_nights_reserved.${type}`,
        value: reservedTotal.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
      }),
      metric({
        key: `resource_nights_occupied.${type}`,
        label: `resource_nights_occupied.${type}`,
        value: occupiedTotal.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
      }),
      metric({
        key: `resource_nights_occupied_paid.${type}`,
        label: `resource_nights_occupied_paid.${type}`,
        value: paid.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
      }),
      metric({
        key: `resource_nights_occupied_owner.${type}`,
        label: `resource_nights_occupied_owner.${type}`,
        value: owner.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
      }),
      metric({
        key: `resource_nights_occupied_complimentary.${type}`,
        label: `resource_nights_occupied_complimentary.${type}`,
        value: complimentary.toString(),
        unit: 'resource_night',
        basis: 'PHYSICAL',
      }),
      ratioMetric({
        key: `occupancy_physical.${type}`,
        label: `occupancy_physical.${type}`,
        numerator: occupiedTotal,
        denominator: physicalNights,
        unit: 'ratio',
        basis: 'PHYSICAL',
      }),
      ratioMetric({
        key: `occupancy_operational.${type}`,
        label: `occupancy_operational.${type}`,
        numerator: occupiedTotal,
        denominator: operationalNights,
        unit: 'ratio',
        basis: 'OPERATIONAL',
      }),
    );
  }
  return metrics;
}

function itemNightsInPeriod(
  items: ReadonlyArray<{
    arrival: string;
    departure: string;
    state: string;
  }>,
  from: string,
  to: string,
  activeOnly: boolean,
): number {
  let total = 0;
  for (const item of items) {
    if (activeOnly && !ACTIVE_ITEM_STATES.includes(item.state as never))
      continue;
    const start = item.arrival > from ? item.arrival : from;
    const end = item.departure < to ? item.departure : to;
    if (end > start) total += daysBetween(start, end);
  }
  return total;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function displayMetrics(
  input: ReadReportInput,
  display: Array<{ product_kind: string; nights: number }>,
  persons: Array<{ key: string; count: number }>,
  noShow: number,
): ReportMetric[] {
  const metrics: ReportMetric[] = [];
  for (const row of display) {
    metrics.push(
      metric({
        key: `display_nights.${row.product_kind}`,
        label: `display_nights.${row.product_kind}`,
        value: row.nights,
        unit: 'item_night',
        basis: 'ACTIVE_ITEM_NIGHTS',
      }),
    );
  }
  let personsTotal = 0;
  for (const row of persons) {
    personsTotal += row.count;
    metrics.push(
      metric({
        key: `persons.${row.key}`,
        label: `persons.${row.key}`,
        value: row.count,
        unit: 'person',
        basis: 'ACTIVE_ITEM_NIGHTS',
      }),
    );
  }
  metrics.push(
    metric({
      key: 'persons',
      label: 'persons',
      value: personsTotal,
      unit: 'person',
      basis: 'ACTIVE_ITEM_NIGHTS',
    }),
    metric({
      key: 'no_show_items',
      label: 'no_show_items',
      value: noShow,
      unit: 'item',
      basis: 'CURRENT_STATE',
    }),
  );
  return metrics;
}

function rowLimited(rows: ReportRow[], metrics: ReportMetric[]): ReportRow[] {
  if (rows.length <= MAX_ROWS) return rows;
  metrics.push(
    metric({
      key: 'rows_truncated',
      label: 'rows_truncated',
      value: rows.length - MAX_ROWS,
      unit: 'row',
      basis: 'CURRENT_STATE',
    }),
  );
  return rows.slice(0, MAX_ROWS);
}

function itemsToRows(items: ItemRow[]): ReportRow[] {
  return items.map((item) => ({
    label: `item:${item.id.slice(0, 8)}`,
    value: item.state,
    unit: 'item',
    state: item.state,
    date: item.arrival,
  }));
}

function arrivalsMetrics(
  kind: 'ARRIVALS' | 'DEPARTURES',
  states: Array<{ key: string; count: number }>,
): ReportMetric[] {
  const prefix = kind === 'ARRIVALS' ? 'arrivals' : 'departures';
  const total = states.reduce((sum, row) => sum + row.count, 0);
  const metrics: ReportMetric[] = [
    metric({
      key: `${prefix}_total`,
      label: `${prefix}_total`,
      value: total,
      unit: 'item',
      basis: 'ACTIVE_ITEM_NIGHTS',
    }),
  ];
  for (const row of states) {
    metrics.push(
      metric({
        key: `${prefix}_state_${row.key.toLowerCase()}`,
        label: `${prefix}_state_${row.key.toLowerCase()}`,
        value: row.count,
        unit: 'item',
        basis: 'ACTIVE_ITEM_NIGHTS',
      }),
    );
  }
  return metrics;
}

function pickupRows(
  snapshotItems: Array<{
    id: string;
    arrival: string;
    departure: string;
    state: string;
  }>,
  currentItems: ItemRow[],
  from: string,
  to: string,
): { rows: ReportRow[]; added: number; removed: number; net: number } {
  const snapshotById = new Map(snapshotItems.map((item) => [item.id, item]));
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const ids = [...new Set([...snapshotById.keys(), ...currentById.keys()])];
  const rows: ReportRow[] = [];
  let added = 0;
  let removed = 0;
  let net = 0;
  for (const id of ids) {
    const before = snapshotById.get(id) ?? null;
    const after = currentById.get(id) ?? null;
    const beforeNights = before
      ? itemNightsInPeriod([before], from, to, true)
      : 0;
    const afterNights = after ? itemNightsInPeriod([after], from, to, true) : 0;
    const delta = afterNights - beforeNights;
    const stateChanged = (before?.state ?? 'NONE') !== (after?.state ?? 'NONE');
    if (delta === 0 && !stateChanged) continue;
    if (delta > 0) added += delta;
    if (delta < 0) removed += -delta;
    net += delta;
    rows.push({
      label: `item:${id.slice(0, 8)}`,
      value: `${delta > 0 ? '+' : ''}${delta}`,
      unit: 'item_night',
      state: after?.state ?? before?.state ?? 'NONE',
      date: after?.arrival ?? before?.arrival,
    });
  }
  return { rows, added, removed, net };
}

async function buildReport(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  property: repo.PropertyReportScope,
  input: ReadReportInput,
  cutoff: repo.JournalCutoffRow | null,
): Promise<Record<string, unknown>> {
  const kind = assertKind(input.kind);
  validatePeriod(input.period);
  requireCurrency(kind, input.currency);
  const definition = reportKindDefinitions[kind];
  const metrics: ReportMetric[] = [];
  let rows: ReportRow[] = [];
  let snapshot: Record<string, unknown> | null = null;
  const from = input.period.date_from;
  const to = input.period.date_to;

  if (!definition.requiresCurrency) {
    const [
      physical,
      maintenance,
      occupied,
      reserved,
      display,
      persons,
      housekeeping,
      maintenanceState,
    ] = await Promise.all([
      repo.listActiveResourceCounts(em, tenantId, propertyId),
      repo.listMaintenanceResourceNights(em, tenantId, propertyId, from, to),
      repo.listOccupiedResourceNights(em, tenantId, propertyId, from, to),
      repo.listReservedResourceNights(em, tenantId, propertyId, from, to),
      repo.listDisplayNights(em, tenantId, propertyId, from, to),
      repo.countPersons(em, tenantId, propertyId, from, to),
      repo.listHousekeepingStateCounts(em, tenantId, propertyId),
      repo.listMaintenanceStateCounts(em, tenantId, propertyId),
    ]);
    const arrivalsStates = await repo.countItemsInState(
      em,
      tenantId,
      propertyId,
      'arrival',
      from,
      to,
    );
    const departuresStates = await repo.countItemsInState(
      em,
      tenantId,
      propertyId,
      'departure',
      from,
      to,
    );
    const noShow =
      arrivalsStates.find((row) => row.key === 'NO_SHOW')?.count ?? 0;
    if (kind === 'OCCUPANCY') {
      metrics.push(
        ...occupancyMetrics(
          input,
          physical,
          occupied,
          reserved,
          maintenance,
          housekeeping,
          maintenanceState,
        ),
        ...displayMetrics(input, display, persons, noShow),
      );
    } else if (kind === 'ARRIVALS' || kind === 'DEPARTURES') {
      const items = await repo.listItemsByDate(
        em,
        tenantId,
        propertyId,
        kind === 'ARRIVALS' ? 'arrival' : 'departure',
        from,
        to,
      );
      metrics.push(
        ...arrivalsMetrics(
          kind,
          kind === 'ARRIVALS' ? arrivalsStates : departuresStates,
        ),
      );
      rows = rowLimited(itemsToRows(items), metrics);
    } else if (kind === 'PICKUP') {
      const referenceDate = input.reference_date
        ? assertIsoDate(input.reference_date, 'reference_date')
        : businessToday(property.timezone);
      const stored = await repo.findSnapshot(
        em,
        tenantId,
        propertyId,
        'PICKUP',
        referenceDate,
      );
      if (!stored)
        throw new PropertyError('NOT_FOUND', {
          reason: 'report_snapshot_not_found',
          reference_date: referenceDate,
        });
      const snapshotData = stored.data as {
        items?: Array<{
          id: string;
          arrival: string;
          departure: string;
          state: string;
        }>;
      };
      const snapshotItems = snapshotData.items ?? [];
      // F-RVW11-01: mirror the snapshot side (departure >= reference) instead
      // of clipping to the period, so nights extending past `to` stay visible.
      const currentItems = (
        await repo.listItemsByDate(
          em,
          tenantId,
          propertyId,
          'departure',
          from,
          '9999-12-31',
        )
      ).filter((item) => ACTIVE_ITEM_STATES.includes(item.state as never));
      const diff = pickupRows(snapshotItems, currentItems, from, to);
      metrics.push(
        metric({
          key: 'pickup_nights_added',
          label: 'pickup_nights_added',
          value: diff.added,
          unit: 'item_night',
          basis: 'SNAPSHOT_DIFF_ACTIVE_ITEM_NIGHTS',
        }),
        metric({
          key: 'pickup_nights_removed',
          label: 'pickup_nights_removed',
          value: diff.removed,
          unit: 'item_night',
          basis: 'SNAPSHOT_DIFF_ACTIVE_ITEM_NIGHTS',
        }),
        metric({
          key: 'pickup_nights_net',
          label: 'pickup_nights_net',
          value: diff.net,
          unit: 'item_night',
          basis: 'SNAPSHOT_DIFF_ACTIVE_ITEM_NIGHTS',
        }),
      );
      rows = rowLimited(diff.rows, metrics);
      snapshot = {
        id: stored.id,
        kind: stored.kind,
        reference_date: stored.reference_date,
        captured_at: toIsoInstant(stored.created_at),
      };
    } else {
      throw new PropertyError('INVALID_REQUEST', {
        field: 'kind',
        reason: 'kind_not_available',
      });
    }
    return {
      report_id: randomUUID(),
      kind,
      generated_at: new Date().toISOString(),
      period: { date_from: from, date_to: to },
      currency: input.currency ?? null,
      cutoff: {
        business_date: cutoff?.business_date ?? null,
        state: cutoff?.state ?? null,
        property_timezone: property.timezone,
      },
      data_basis: 'OPERATING_DB',
      snapshot,
      metrics,
      rows,
    };
  }

  // Financial kinds build their totals from the same transaction snapshot as
  // the journal reconciliation below.
  return buildFinancialReport(
    em,
    tenantId,
    propertyId,
    property,
    input,
    cutoff,
  );
}

const REVENUE_ACCOUNTS = ['REVENUE_ROOM', 'REVENUE_OTHER'] as const;

interface AccountReconciliation {
  account_code: string;
  journal_total: string;
  charge_total: string;
  tax_total: string;
  delta: string;
  reconciled: boolean;
}

function moneyOf(value: string | undefined): bigint {
  return parseDecimal(value ?? '0', 'amount', { allowNegative: true });
}

async function buildFinancialReport(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  property: repo.PropertyReportScope,
  input: ReadReportInput,
  cutoff: repo.JournalCutoffRow | null,
): Promise<Record<string, unknown>> {
  const kind = input.kind;
  const currency = input.currency as string;
  const from = input.period.date_from;
  const to = input.period.date_to;
  const [journalRows, chargeRows] = await Promise.all([
    repo.listJournalAccountTotals(em, tenantId, propertyId, currency, from, to),
    repo.listChargeTotalsByAccount(
      em,
      tenantId,
      propertyId,
      currency,
      from,
      to,
    ),
  ]);
  const journalByAccount = new Map(
    journalRows.map((row) => [row.account_code, row.total]),
  );
  const chargeByAccount = new Map(
    chargeRows.map((row) => [row.account_code, row]),
  );
  const reconciliation = (codes: readonly string[]): AccountReconciliation[] =>
    codes.map((accountCode) => {
      const journalTotal = moneyOf(journalByAccount.get(accountCode));
      const charge = chargeByAccount.get(accountCode);
      const chargeTotal = moneyOf(charge?.net_total);
      const taxTotal = moneyOf(charge?.tax_total);
      const delta = journalTotal - chargeTotal;
      return {
        account_code: accountCode,
        journal_total: formatMoney(journalTotal),
        charge_total: formatMoney(chargeTotal),
        tax_total: formatMoney(taxTotal),
        delta: formatMoney(delta),
        reconciled: delta === 0n,
      };
    });
  const metrics: ReportMetric[] = [];
  const rows: ReportRow[] = [];
  let accounts: AccountReconciliation[] = [];

  if (kind === 'REVENUE') {
    accounts = reconciliation(REVENUE_ACCOUNTS);
    let total = 0n;
    for (const account of accounts) {
      total += moneyOf(account.journal_total);
      metrics.push(
        metric({
          key: `revenue_journal.${account.account_code}`,
          label: `revenue_journal.${account.account_code}`,
          value: account.journal_total,
          unit: currency,
          basis: 'POSTED_JOURNAL',
        }),
        metric({
          key: `revenue_charges.${account.account_code}`,
          label: `revenue_charges.${account.account_code}`,
          value: account.charge_total,
          unit: currency,
          basis: 'POSTED_CHARGES',
        }),
        metric({
          key: `revenue_delta.${account.account_code}`,
          label: `revenue_delta.${account.account_code}`,
          value: account.delta,
          unit: currency,
          basis: 'POSTED_JOURNAL',
        }),
      );
      rows.push({
        label: account.account_code,
        value: account.journal_total,
        unit: currency,
        state: account.reconciled ? 'RECONCILED' : 'DELTA',
      });
    }
    metrics.push(
      metric({
        key: 'revenue_total',
        label: 'revenue_total',
        value: formatMoney(total),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
      metric({
        key: 'revenue_journal_reconciled',
        label: 'revenue_journal_reconciled',
        value: accounts.every((account) => account.reconciled)
          ? 'true'
          : 'false',
        unit: 'boolean',
        basis: 'POSTED_JOURNAL',
      }),
    );
  } else if (kind === 'TAX') {
    const chargeTax = await repo.sumChargeTax(
      em,
      tenantId,
      propertyId,
      currency,
      from,
      to,
    );
    accounts = reconciliation(['TAX_PAYABLE']);
    const journalTotal = moneyOf(accounts[0]?.journal_total);
    const chargeTaxTotal = moneyOf(chargeTax);
    const delta = journalTotal - chargeTaxTotal;
    metrics.push(
      metric({
        key: 'tax_journal',
        label: 'tax_journal',
        value: formatMoney(journalTotal),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
      metric({
        key: 'tax_from_charges',
        label: 'tax_from_charges',
        value: formatMoney(chargeTaxTotal),
        unit: currency,
        basis: 'POSTED_CHARGES',
      }),
      metric({
        key: 'tax_delta',
        label: 'tax_delta',
        value: formatMoney(delta),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
      metric({
        key: 'tax_journal_reconciled',
        label: 'tax_journal_reconciled',
        value: delta === 0n ? 'true' : 'false',
        unit: 'boolean',
        basis: 'POSTED_JOURNAL',
      }),
    );
    rows.push({
      label: 'TAX_PAYABLE',
      value: formatMoney(journalTotal),
      unit: currency,
      state: delta === 0n ? 'RECONCILED' : 'DELTA',
    });
  } else if (kind === 'SETTLEMENTS') {
    const [payments, refunds, cashier] = await Promise.all([
      repo.listPaymentTotals(em, tenantId, propertyId, currency, from, to),
      repo.listRefundTotals(
        em,
        tenantId,
        propertyId,
        currency,
        from,
        to,
        property.timezone,
      ),
      repo.listCashierVariances(
        em,
        tenantId,
        propertyId,
        currency,
        from,
        to,
        property.timezone,
      ),
    ]);
    let collected = 0n;
    let refunded = 0n;
    for (const payment of payments) {
      const total = moneyOf(payment.total);
      if (payment.state === 'SUCCEEDED') collected += total;
      metrics.push(
        metric({
          key: `payments_${payment.method.toLowerCase()}_${payment.state.toLowerCase()}`,
          label: `payments_${payment.method.toLowerCase()}_${payment.state.toLowerCase()}`,
          value: formatMoney(moneyOf(payment.total)),
          unit: currency,
          basis: 'PAYMENT_RECORDS',
        }),
      );
    }
    for (const refund of refunds) {
      const total = moneyOf(refund.total);
      if (refund.state === 'SUCCEEDED') refunded += total;
      metrics.push(
        metric({
          key: `refunds_${refund.state.toLowerCase()}`,
          label: `refunds_${refund.state.toLowerCase()}`,
          value: formatMoney(moneyOf(refund.total)),
          unit: currency,
          basis: 'PAYMENT_RECORDS',
        }),
      );
    }
    for (const session of cashier) {
      metrics.push(
        metric({
          key: `cashier_${session.state.toLowerCase()}`,
          label: `cashier_${session.state.toLowerCase()}`,
          value: formatMoney(moneyOf(session.variance)),
          unit: currency,
          basis: 'PAYMENT_RECORDS',
        }),
      );
    }
    metrics.push(
      metric({
        key: 'payments_succeeded_total',
        label: 'payments_succeeded_total',
        value: formatMoney(collected),
        unit: currency,
        basis: 'PAYMENT_RECORDS',
      }),
      metric({
        key: 'refunds_succeeded_total',
        label: 'refunds_succeeded_total',
        value: formatMoney(refunded),
        unit: currency,
        basis: 'PAYMENT_RECORDS',
      }),
      metric({
        key: 'net_collected',
        label: 'net_collected',
        value: formatMoney(collected - refunded),
        unit: currency,
        basis: 'PAYMENT_RECORDS',
      }),
      // Payments are collections, not revenue: this declared row is the
      // cross-check that the same period's posted revenue stays separate.
      metric({
        key: 'payments_are_not_revenue',
        label: 'payments_are_not_revenue',
        value: 'true',
        unit: 'boolean',
        basis: 'PAYMENT_RECORDS',
      }),
    );
    rows.push(
      ...payments.map((payment) => ({
        label: `${payment.method}:${payment.state}`,
        value: payment.total,
        unit: currency,
        state: payment.state,
      })),
      ...refunds.map((refund) => ({
        label: `REFUND:${refund.state}`,
        value: refund.total,
        unit: currency,
        state: refund.state,
      })),
      ...cashier.map((session) => ({
        label: `CASHIER:${session.state}`,
        value: session.variance,
        unit: currency,
        state: session.state,
      })),
    );
  } else if (kind === 'ADR_REVPAR') {
    const [attribution, physical, maintenance, occupied] = await Promise.all([
      repo.listStayRevenueAttribution(
        em,
        tenantId,
        propertyId,
        currency,
        from,
        to,
      ),
      repo.listActiveResourceCounts(em, tenantId, propertyId),
      repo.listMaintenanceResourceNights(em, tenantId, propertyId, from, to),
      repo.listOccupiedResourceNights(em, tenantId, propertyId, from, to),
    ]);
    const journalStayRevenue = moneyOf(journalByAccount.get('REVENUE_ROOM'));
    const chargesRevenue = moneyOf(attribution.charges_total);
    const attributed = new Map(
      attribution.attributed.map((row) => [
        row.resource_type,
        moneyOf(row.total),
      ]),
    );
    const attributedRevenue = [...attributed.values()].reduce(
      (total, value) => total + value,
      0n,
    );
    const unattributedRevenue = chargesRevenue - attributedRevenue;
    const unattributedCharges =
      attribution.charges_count -
      attribution.attributed.reduce((total, row) => total + row.charges, 0);
    const delta = journalStayRevenue - chargesRevenue;
    metrics.push(
      metric({
        key: 'stay_revenue_journal',
        label: 'stay_revenue_journal',
        value: formatMoney(journalStayRevenue),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
      metric({
        key: 'stay_revenue_charges',
        label: 'stay_revenue_charges',
        value: formatMoney(chargesRevenue),
        unit: currency,
        basis: 'POSTED_CHARGES',
      }),
      metric({
        key: 'stay_revenue_unattributed',
        label: 'stay_revenue_unattributed',
        value: formatMoney(unattributedRevenue),
        unit: currency,
        basis: 'POSTED_CHARGES',
      }),
      metric({
        key: 'stay_revenue_unattributed_charges',
        label: 'stay_revenue_unattributed_charges',
        value: unattributedCharges,
        unit: 'charge',
        basis: 'POSTED_CHARGES',
      }),
      metric({
        key: 'stay_revenue_delta',
        label: 'stay_revenue_delta',
        value: formatMoney(delta),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
      metric({
        key: 'stay_revenue_reconciled',
        label: 'stay_revenue_reconciled',
        value: delta === 0n ? 'true' : 'false',
        unit: 'boolean',
        basis: 'POSTED_JOURNAL',
      }),
    );
    const nights = periodNights(from, to);
    const types = resourceTypesOf(physical, occupied, []).filter(
      (type) => !input.resource_type || type === input.resource_type,
    );
    for (const type of types) {
      const revenue = attributed.get(type) ?? 0n;
      const paidNights = BigInt(
        sumNights(
          occupied.filter((row) => row.resource_type === type),
          (row) => row.class === 'PAID',
        ),
      );
      const physicalCount =
        physical.find((row) => row.key === type)?.count ?? 0;
      const physicalNights = BigInt(physicalCount * nights);
      const ooo = maintenanceNights(maintenance, type, 'OOO');
      const operationalNights =
        physicalNights - BigInt(ooo) > 0n ? physicalNights - BigInt(ooo) : 0n;
      metrics.push(
        metric({
          key: `stay_revenue_type.${type}`,
          label: `stay_revenue_type.${type}`,
          value: formatMoney(revenue),
          unit: currency,
          basis: 'POSTED_CHARGES',
        }),
        metric({
          key: `resource_nights_paid.${type}`,
          label: `resource_nights_paid.${type}`,
          value: paidNights.toString(),
          unit: 'resource_night',
          basis: 'PHYSICAL',
        }),
        moneyRatioMetric({
          key: `adr.${type}`,
          label: `adr.${type}`,
          revenue,
          denominator: paidNights,
          unit: currency,
          basis: 'POSTED_CHARGES',
        }),
        moneyRatioMetric({
          key: `revpar_physical.${type}`,
          label: `revpar_physical.${type}`,
          revenue,
          denominator: physicalNights,
          unit: currency,
          basis: 'PHYSICAL',
        }),
        moneyRatioMetric({
          key: `revpar_operational.${type}`,
          label: `revpar_operational.${type}`,
          revenue,
          denominator: operationalNights,
          unit: currency,
          basis: 'OPERATIONAL',
        }),
      );
      rows.push({
        label: type,
        value: formatMoney(revenue),
        unit: currency,
        state: `${paidNights.toString()}/${physicalNights.toString()}`,
      });
    }
  } else if (kind === 'CHANNEL_PERFORMANCE') {
    const channels = await repo.listChannelPerformance(
      em,
      tenantId,
      propertyId,
      currency,
      from,
      to,
    );
    let gross = 0n;
    let commission = 0n;
    let net = 0n;
    for (const channel of channels) {
      gross += moneyOf(channel.gross_total);
      commission += moneyOf(channel.commission_total);
      net += moneyOf(channel.net_total);
      metrics.push(
        metric({
          key: `channel_gross.${channel.channel_key}`,
          label: `channel_gross.${channel.channel_key}`,
          value: formatMoney(moneyOf(channel.gross_total)),
          unit: currency,
          basis: 'CHANNEL_RECORDS',
        }),
        metric({
          key: `channel_commission.${channel.channel_key}`,
          label: `channel_commission.${channel.channel_key}`,
          value: formatMoney(moneyOf(channel.commission_total)),
          unit: currency,
          basis: 'CHANNEL_RECORDS',
        }),
        metric({
          key: `channel_net.${channel.channel_key}`,
          label: `channel_net.${channel.channel_key}`,
          value: formatMoney(moneyOf(channel.net_total)),
          unit: currency,
          basis: 'CHANNEL_RECORDS',
        }),
        metric({
          key: `channel_bookings.${channel.channel_key}`,
          label: `channel_bookings.${channel.channel_key}`,
          value: channel.external_bookings,
          unit: 'external_booking',
          basis: 'CHANNEL_RECORDS',
        }),
        metric({
          key: `channel_cancellations.${channel.channel_key}`,
          label: `channel_cancellations.${channel.channel_key}`,
          value: channel.cancelled_bookings,
          unit: 'external_booking',
          basis: 'CHANNEL_RECORDS',
        }),
      );
      rows.push({
        label: channel.channel_key,
        value: formatMoney(moneyOf(channel.net_total)),
        unit: currency,
        state: `${channel.external_bookings}/${channel.cancelled_bookings}`,
      });
    }
    metrics.push(
      metric({
        key: 'channel_gross_total',
        label: 'channel_gross_total',
        value: formatMoney(gross),
        unit: currency,
        basis: 'CHANNEL_RECORDS',
      }),
      metric({
        key: 'channel_commission_total',
        label: 'channel_commission_total',
        value: formatMoney(commission),
        unit: currency,
        basis: 'CHANNEL_RECORDS',
      }),
      metric({
        key: 'channel_net_total',
        label: 'channel_net_total',
        value: formatMoney(net),
        unit: currency,
        basis: 'CHANNEL_RECORDS',
      }),
    );
  } else {
    throw new PropertyError('INVALID_REQUEST', {
      field: 'kind',
      reason: 'kind_not_available',
    });
  }

  return {
    report_id: randomUUID(),
    kind,
    generated_at: new Date().toISOString(),
    period: { date_from: from, date_to: to },
    currency,
    cutoff: {
      business_date: cutoff?.business_date ?? null,
      state: cutoff?.state ?? null,
      property_timezone: property.timezone,
    },
    data_basis: 'OPERATING_DB',
    snapshot: null,
    reconciliation: {
      journal_source: 'POSTED',
      currency,
      accounts,
      reconciled: accounts.every((account) => account.reconciled),
    },
    metrics,
    rows: rowLimited(rows, metrics),
  };
}

export interface TenantReportInput {
  kind: ReportKind;
  period: ReportPeriodInput;
  currency?: 'IDR' | 'USD' | null;
  property_ids?: string[] | null;
}

/**
 * Multi-property portfolio report. The authorized property set is derived
 * server-side from the actor's grants; an explicit property_ids list may only
 * narrow it and any property outside the tenant or the actor scope fails
 * closed (no silent expansion through URL or body scope).
 */
export async function readTenantReport(
  orm: MikroORM,
  context: ServiceContext,
  tenantId: string,
  input: TenantReportInput,
): Promise<Record<string, unknown>> {
  const kind = assertKind(input.kind);
  if (kind !== 'PORTFOLIO')
    throw new PropertyError('INVALID_REQUEST', {
      field: 'kind',
      reason: 'tenant_report_kind_not_allowed',
    });
  validatePeriod(input.period);
  requireCurrency(kind, input.currency);
  return runScopedTransaction(
    orm,
    { tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.operational.view', null);
      await authorize(em, context, 'report.financial.view', null);
      if (tenantId !== context.tenantId) throw new PropertyError('NOT_FOUND');
      const properties = await repo.listTenantProperties(em, tenantId);
      let selected: repo.PropertyReportScope[];
      if (input.property_ids && input.property_ids.length > 0) {
        selected = [];
        for (const propertyId of input.property_ids) {
          const found = await repo.findPropertyInTenant(
            em,
            tenantId,
            propertyId,
          );
          if (!found)
            throw new PropertyError('NOT_FOUND', {
              reason: 'property_out_of_scope',
            });
          const decision = await evaluatePolicy(em, {
            actor: context.actor,
            tenantId,
            permission: 'report.financial.view',
            propertyRef: propertyId,
          });
          if (!decision.allowed) throw policyError(decision);
          const property = properties.find((row) => row.id === propertyId);
          if (property) selected.push(property);
        }
      } else {
        const allowed = [];
        for (const property of properties) {
          const decision = await evaluatePolicy(em, {
            actor: context.actor,
            tenantId,
            permission: 'report.financial.view',
            propertyRef: property.id,
          });
          if (decision.allowed) allowed.push(property);
        }
        selected = allowed;
      }
      return buildPortfolioPayload(em, tenantId, input, selected);
    },
  );
}

export async function buildPortfolioPayload(
  em: EntityManager,
  tenantId: string,
  input: TenantReportInput,
  properties: readonly repo.PropertyReportScope[],
): Promise<Record<string, unknown>> {
  const kind = 'PORTFOLIO' as const;
  const currency = input.currency as string;
  const from = input.period.date_from;
  const to = input.period.date_to;
  const metrics: ReportMetric[] = [];
  const rows: ReportRow[] = [];
  let total = 0n;
  for (const property of properties) {
    const accounts = await repo.listJournalAccountTotals(
      em,
      tenantId,
      property.id,
      currency,
      from,
      to,
    );
    const byAccount = new Map(
      accounts.map((row) => [row.account_code, row.total]),
    );
    let propertyTotal = 0n;
    for (const account of REVENUE_ACCOUNTS)
      propertyTotal += moneyOf(byAccount.get(account));
    total += propertyTotal;
    metrics.push(
      metric({
        key: `portfolio_revenue.${property.code}`,
        label: `portfolio_revenue.${property.code}`,
        value: formatMoney(propertyTotal),
        unit: currency,
        basis: 'POSTED_JOURNAL',
      }),
    );
    rows.push({
      label: property.code,
      value: formatMoney(propertyTotal),
      unit: currency,
      state: property.base_currency,
    });
  }
  metrics.push(
    metric({
      key: 'portfolio_revenue_total',
      label: 'portfolio_revenue_total',
      value: formatMoney(total),
      unit: currency,
      basis: 'POSTED_JOURNAL',
    }),
    metric({
      key: 'portfolio_properties',
      label: 'portfolio_properties',
      value: properties.length,
      unit: 'property',
      basis: 'POSTED_JOURNAL',
    }),
    metric({
      key: 'portfolio_single_currency',
      label: 'portfolio_single_currency',
      value: currency,
      unit: 'currency_code',
      basis: 'POSTED_JOURNAL',
    }),
  );
  return {
    report_id: randomUUID(),
    kind,
    generated_at: new Date().toISOString(),
    period: { date_from: from, date_to: to },
    currency,
    cutoff: {
      business_date: null,
      state: null,
      property_timezone: 'MULTI_PROPERTY',
    },
    data_basis: 'OPERATING_DB',
    snapshot: null,
    reconciliation: {
      journal_source: 'POSTED',
      currency,
      accounts: [],
      reconciled: true,
    },
    metrics,
    rows: rowLimited(rows, metrics),
  };
}

export async function buildReportPayload(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  input: ReadReportInput,
): Promise<Record<string, unknown>> {
  const property = await repo.findReportPropertyScope(em, tenantId, propertyId);
  if (!property) throw new PropertyError('NOT_FOUND');
  const cutoff = await repo.findReportActiveBusinessDay(
    em,
    tenantId,
    propertyId,
  );
  return buildReport(em, tenantId, propertyId, property, input, cutoff);
}

export async function readReport(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ReadReportInput,
): Promise<Record<string, unknown>> {
  const kind = assertKind(input.kind);
  const definition = reportKindDefinitions[kind];
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.operational.view', propertyId);
      if (definition.domain === 'FINANCIAL')
        await authorize(em, context, 'report.financial.view', propertyId);
      return buildReportPayload(em, context.tenantId, propertyId, input);
    },
  );
}

interface SnapshotItem {
  id: string;
  product_kind: string;
  arrival: string;
  departure: string;
  state: string;
  owner_stay: boolean;
  total_amount: string | null;
}

async function captureSnapshot(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  property: repo.PropertyReportScope,
  input: CaptureSnapshotInput,
): Promise<Record<string, unknown>> {
  const referenceDate = input.reference_date
    ? assertIsoDate(input.reference_date, 'reference_date')
    : businessToday(property.timezone);
  const existing = await repo.findSnapshot(
    em,
    context.tenantId,
    propertyId,
    'PICKUP',
    referenceDate,
  );
  if (existing)
    return {
      snapshot: {
        id: existing.id,
        kind: existing.kind,
        reference_date: existing.reference_date,
        captured_at: toIsoInstant(existing.created_at),
      },
      replayed: true,
    };
  const items = await repo.listItemsByDate(
    em,
    context.tenantId,
    propertyId,
    'departure',
    referenceDate,
    '9999-12-31',
  );
  const snapshotItems: SnapshotItem[] = items.map((item) => ({
    id: item.id,
    product_kind: item.product_kind,
    arrival: item.arrival,
    departure: item.departure,
    state: item.state,
    owner_stay: item.owner_stay,
    total_amount: item.total_amount,
  }));
  const summary = {
    items_total: snapshotItems.length,
    item_nights: itemNightsInPeriod(
      snapshotItems,
      referenceDate,
      '9999-12-31',
      true,
    ),
    states: snapshotItems.reduce<Record<string, number>>((counts, item) => {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    }, {}),
  };
  const membership = await findMembership(
    em,
    context.tenantId,
    context.actor.userId,
  );
  const stored = await repo.insertSnapshot(em, {
    tenantId: context.tenantId,
    propertyId,
    kind: 'PICKUP',
    referenceDate,
    data: { items: snapshotItems },
    sourceSummary: summary,
    capturedByMembershipId: membership?.id ?? null,
    capturedByLabel: context.actor.displayName,
    correlationId: context.correlationId,
  });
  if (!stored) {
    // F-RVW11-02: a concurrent capture committed this reference first; replay
    // the stored snapshot instead of surfacing the unique violation as a 500.
    const winner = await repo.findSnapshot(
      em,
      context.tenantId,
      propertyId,
      'PICKUP',
      referenceDate,
    );
    if (!winner)
      throw new Error('report snapshot conflict without a stored row');
    return {
      snapshot: {
        id: winner.id,
        kind: winner.kind,
        reference_date: winner.reference_date,
        captured_at: toIsoInstant(winner.created_at),
      },
      replayed: true,
    };
  }
  await recordAudit(em, {
    tenantId: context.tenantId,
    propertyId,
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
    action: 'report.snapshot_captured',
    resourceType: 'ReportSnapshot',
    resourceId: stored.id,
    outcome: 'SUCCESS',
    beforeSafe: {},
    afterSafe: {
      reference_date: referenceDate,
      items_total: summary.items_total,
      item_nights: summary.item_nights,
    },
    correlationId: context.correlationId,
  });
  return {
    snapshot: {
      id: stored.id,
      kind: stored.kind,
      reference_date: stored.reference_date,
      captured_at: toIsoInstant(stored.created_at),
    },
    replayed: false,
  };
}

export async function captureReportSnapshot(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: CaptureSnapshotInput,
): Promise<Record<string, unknown>> {
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    property_id: propertyId,
    kind: 'PICKUP',
    reference_date: input.reference_date ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.operational.view', propertyId);
      const property = await repo.findReportPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const replayed = await checkIdempotency(
        em,
        context,
        'CaptureReportSnapshot',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const result = await captureSnapshot(
        em,
        context,
        propertyId,
        property,
        input,
      );
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CaptureReportSnapshot',
        key,
        requestHash,
        response: result,
        resourceId: (result.snapshot as { id?: string }).id ?? null,
      });
      return result;
    },
  );
}

export async function listReportSnapshots(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Array<Record<string, unknown>>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'report.operational.view', propertyId);
      const property = await repo.findReportPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const snapshots = await repo.listSnapshots(
        em,
        context.tenantId,
        propertyId,
        'PICKUP',
      );
      return snapshots.map((snapshot) => ({
        id: snapshot.id,
        kind: snapshot.kind,
        reference_date: snapshot.reference_date,
        captured_at: toIsoInstant(snapshot.created_at),
        captured_by_label: snapshot.captured_by_label,
        summary: snapshot.source_summary,
      }));
    },
  );
}
