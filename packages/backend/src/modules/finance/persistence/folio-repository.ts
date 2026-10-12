import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { normalizeMoney } from '../domain/money.js';

export interface FolioRow {
  id: string;
  tenant_id: string;
  property_id: string;
  reservation_id: string | null;
  kind: string;
  payer_label: string;
  currency: string;
  state: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface FolioChargeRow {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  business_date: string;
  currency: string;
  kind: string;
  account_code: string;
  net_amount: string;
  tax_amount: string;
  tax_policy: Record<string, unknown>;
  policy_snapshot_id: string | null;
  source_kind: string;
  source_ref: string;
  period_start: string | null;
  period_end: string | null;
  memo: string | null;
  journal_id: string;
  posted_at: Date;
}

export interface PayerAllocationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  charge_id: string;
  payer_folio_id: string;
  amount: string;
  journal_id: string;
  memo: string | null;
  created_at: Date;
}

export interface ChargeScheduleRow {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  code: string;
  account_code: string;
  quantity: number;
  net_amount: string;
  tax_amount: string;
  tax_policy: Record<string, unknown>;
  currency: string;
  interval: string;
  starts_on: string;
  ends_on: string | null;
  state: string;
  version: number;
}

export interface PackageEntitlementRow {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  code: string;
  account_code: string;
  quantity_total: number;
  unit_net_amount: string;
  unit_tax_amount: string;
  tax_policy: Record<string, unknown>;
  currency: string;
  state: string;
  version: number;
}

export interface PackageConsumptionRow {
  id: string;
  entitlement_id: string;
  quantity: number;
  source_kind: string;
  source_ref: string;
  charge_id: string;
  consumed_at: Date;
}

export interface FolioDepositRow {
  id: string;
  tenant_id: string;
  property_id: string;
  folio_id: string;
  kind: string;
  method: string;
  currency: string;
  amount: string;
  external_reference: string;
  evidence_ref: string | null;
  source_ref: string;
  journal_id: string;
  created_at: Date;
}

export interface DepositApplicationRow {
  id: string;
  deposit_id: string;
  charge_id: string | null;
  kind: string;
  amount: string;
  reason: string;
  journal_id: string;
  created_at: Date;
}

export async function findFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioRow | null> {
  return one<FolioRow>(
    em,
    `select * from "folio"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [folioId, tenantId, propertyId],
  );
}

export async function listFolioRows(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId?: string | null;
    state?: string | null;
  },
): Promise<FolioRow[]> {
  return rows<FolioRow>(
    em,
    `select * from "folio"
      where "tenant_id" = ? and "property_id" = ?
        and (?::uuid is null or "reservation_id" = ?::uuid)
        and (?::text is null or "state" = ?::text)
      order by "created_at", "id"`,
    [
      input.tenantId,
      input.propertyId,
      input.reservationId ?? null,
      input.reservationId ?? null,
      input.state ?? null,
      input.state ?? null,
    ],
  );
}

export async function insertFolio(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string | null;
    kind: string;
    payerLabel: string;
    currency: string;
  },
): Promise<FolioRow> {
  const inserted = await one<FolioRow>(
    em,
    `insert into "folio"
       ("tenant_id", "property_id", "reservation_id", "kind", "payer_label", "currency")
     values (?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.kind,
      input.payerLabel,
      input.currency,
    ],
  );
  if (!inserted) throw new Error('folio insert returned no row');
  return inserted;
}

export async function insertCharge(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    businessDate: string;
    currency: string;
    kind: string;
    accountCode: string;
    netAmount: string;
    taxAmount: string;
    taxPolicy: Record<string, unknown>;
    policySnapshotId: string | null;
    sourceKind: string;
    sourceRef: string;
    periodStart: string | null;
    periodEnd: string | null;
    memo: string | null;
    journalId: string;
    correlationId: string | null;
  },
): Promise<FolioChargeRow> {
  const inserted = await one<FolioChargeRow>(
    em,
    `insert into "folio_charge" (
       "tenant_id", "property_id", "folio_id", "business_date", "currency",
       "kind", "account_code", "net_amount", "tax_amount", "tax_policy",
       "policy_snapshot_id", "source_kind", "source_ref", "period_start",
       "period_end", "memo", "journal_id", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.businessDate,
      input.currency,
      input.kind,
      input.accountCode,
      input.netAmount,
      input.taxAmount,
      JSON.stringify(input.taxPolicy ?? {}),
      input.policySnapshotId,
      input.sourceKind,
      input.sourceRef,
      input.periodStart,
      input.periodEnd,
      input.memo,
      input.journalId,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('charge insert returned no row');
  return inserted;
}

export async function findCharge(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  chargeId: string,
): Promise<FolioChargeRow | null> {
  return one<FolioChargeRow>(
    em,
    `select * from "folio_charge"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [chargeId, tenantId, propertyId],
  );
}

export async function listChargesForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioChargeRow[]> {
  return rows<FolioChargeRow>(
    em,
    `select * from "folio_charge"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "posted_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function insertAllocation(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    chargeId: string;
    payerFolioId: string;
    amount: string;
    journalId: string;
    memo: string | null;
  },
): Promise<PayerAllocationRow> {
  const inserted = await one<PayerAllocationRow>(
    em,
    `insert into "payer_allocation" (
       "tenant_id", "property_id", "charge_id", "payer_folio_id", "amount",
       "journal_id", "memo"
     ) values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.chargeId,
      input.payerFolioId,
      input.amount,
      input.journalId,
      input.memo,
    ],
  );
  if (!inserted) throw new Error('allocation insert returned no row');
  return inserted;
}

export async function listAllocationsForCharge(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  chargeId: string,
): Promise<PayerAllocationRow[]> {
  return rows<PayerAllocationRow>(
    em,
    `select * from "payer_allocation"
      where "tenant_id" = ? and "property_id" = ? and "charge_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, chargeId],
  );
}

export async function listAllocationsForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<PayerAllocationRow[]> {
  return rows<PayerAllocationRow>(
    em,
    `select a.* from "payer_allocation" a
       join "folio_charge" c on c."id" = a."charge_id"
      where a."tenant_id" = ? and a."property_id" = ?
        and (c."folio_id" = ? or a."payer_folio_id" = ?)
      order by a."created_at", a."id"`,
    [tenantId, propertyId, folioId, folioId],
  );
}

export async function insertSchedule(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    code: string;
    accountCode: string;
    quantity: number;
    netAmount: string;
    taxAmount: string;
    taxPolicy: Record<string, unknown>;
    currency: string;
    interval: string;
    startsOn: string;
    endsOn: string | null;
  },
): Promise<ChargeScheduleRow> {
  const inserted = await one<ChargeScheduleRow>(
    em,
    `insert into "charge_schedule" (
       "tenant_id", "property_id", "folio_id", "code", "account_code",
       "quantity", "net_amount", "tax_amount", "tax_policy", "currency",
       "interval", "starts_on", "ends_on"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.code,
      input.accountCode,
      input.quantity,
      input.netAmount,
      input.taxAmount,
      JSON.stringify(input.taxPolicy ?? {}),
      input.currency,
      input.interval,
      input.startsOn,
      input.endsOn,
    ],
  );
  if (!inserted) throw new Error('schedule insert returned no row');
  return inserted;
}

export async function findSchedule(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  scheduleId: string,
): Promise<ChargeScheduleRow | null> {
  return one<ChargeScheduleRow>(
    em,
    `select * from "charge_schedule"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [scheduleId, tenantId, propertyId],
  );
}

export async function listSchedulesForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<ChargeScheduleRow[]> {
  return rows<ChargeScheduleRow>(
    em,
    `select * from "charge_schedule"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function countScheduleCharges(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  scheduleId: string,
): Promise<number> {
  const result = await one<{ count: number }>(
    em,
    `select count(*)::int as "count" from "folio_charge"
      where "tenant_id" = ? and "property_id" = ? and "source_kind" = 'ACCRUAL'
        and "source_ref" like ?`,
    [tenantId, propertyId, `schedule:${scheduleId}:%`],
  );
  return result?.count ?? 0;
}

export async function insertEntitlement(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    code: string;
    accountCode: string;
    quantityTotal: number;
    unitNetAmount: string;
    unitTaxAmount: string;
    taxPolicy: Record<string, unknown>;
    currency: string;
  },
): Promise<PackageEntitlementRow> {
  const inserted = await one<PackageEntitlementRow>(
    em,
    `insert into "package_entitlement" (
       "tenant_id", "property_id", "folio_id", "code", "account_code",
       "quantity_total", "unit_net_amount", "unit_tax_amount", "tax_policy", "currency"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.code,
      input.accountCode,
      input.quantityTotal,
      input.unitNetAmount,
      input.unitTaxAmount,
      JSON.stringify(input.taxPolicy ?? {}),
      input.currency,
    ],
  );
  if (!inserted) throw new Error('entitlement insert returned no row');
  return inserted;
}

export async function findEntitlement(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  entitlementId: string,
): Promise<PackageEntitlementRow | null> {
  return one<PackageEntitlementRow>(
    em,
    `select * from "package_entitlement"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [entitlementId, tenantId, propertyId],
  );
}

export async function listEntitlementsForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<PackageEntitlementRow[]> {
  return rows<PackageEntitlementRow>(
    em,
    `select * from "package_entitlement"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function updateEntitlementState(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  entitlementId: string,
  state: string,
): Promise<void> {
  await em.execute(
    `update "package_entitlement"
        set "state" = ?, "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [state, entitlementId, tenantId, propertyId] as never[],
  );
}

export async function sumConsumedQuantity(
  em: EntityManager,
  entitlementId: string,
): Promise<number> {
  const result = await one<{ total: number }>(
    em,
    `select coalesce(sum("quantity"), 0)::int as "total"
       from "package_consumption" where "entitlement_id" = ?`,
    [entitlementId],
  );
  return result?.total ?? 0;
}

export async function insertConsumption(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    entitlementId: string;
    quantity: number;
    sourceKind: string;
    sourceRef: string;
    chargeId: string;
  },
): Promise<PackageConsumptionRow> {
  const inserted = await one<PackageConsumptionRow>(
    em,
    `insert into "package_consumption" (
       "tenant_id", "property_id", "entitlement_id", "quantity",
       "source_kind", "source_ref", "charge_id"
     ) values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.entitlementId,
      input.quantity,
      input.sourceKind,
      input.sourceRef,
      input.chargeId,
    ],
  );
  if (!inserted) throw new Error('consumption insert returned no row');
  return inserted;
}

export async function listConsumptions(
  em: EntityManager,
  entitlementId: string,
): Promise<PackageConsumptionRow[]> {
  return rows<PackageConsumptionRow>(
    em,
    `select * from "package_consumption"
      where "entitlement_id" = ? order by "consumed_at", "id"`,
    [entitlementId],
  );
}

export async function insertDeposit(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioId: string;
    kind: string;
    method: string;
    currency: string;
    amount: string;
    externalReference: string;
    evidenceRef: string | null;
    sourceRef: string;
    journalId: string;
    correlationId: string | null;
  },
): Promise<FolioDepositRow> {
  const inserted = await one<FolioDepositRow>(
    em,
    `insert into "folio_deposit" (
       "tenant_id", "property_id", "folio_id", "kind", "method", "currency",
       "amount", "external_reference", "evidence_ref", "source_ref",
       "journal_id", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.folioId,
      input.kind,
      input.method,
      input.currency,
      input.amount,
      input.externalReference,
      input.evidenceRef,
      input.sourceRef,
      input.journalId,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('deposit insert returned no row');
  return inserted;
}

export async function findDeposit(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  depositId: string,
): Promise<FolioDepositRow | null> {
  return one<FolioDepositRow>(
    em,
    `select * from "folio_deposit"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [depositId, tenantId, propertyId],
  );
}

export async function listDepositsForFolio(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<FolioDepositRow[]> {
  return rows<FolioDepositRow>(
    em,
    `select * from "folio_deposit"
      where "tenant_id" = ? and "property_id" = ? and "folio_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, folioId],
  );
}

export async function findDepositBySource(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  sourceRef: string,
): Promise<FolioDepositRow | null> {
  return one<FolioDepositRow>(
    em,
    `select * from "folio_deposit"
      where "tenant_id" = ? and "property_id" = ? and "source_ref" = ?`,
    [tenantId, propertyId, sourceRef],
  );
}

export async function listDepositApplications(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  depositId: string,
): Promise<DepositApplicationRow[]> {
  return rows<DepositApplicationRow>(
    em,
    `select * from "deposit_application"
      where "tenant_id" = ? and "property_id" = ? and "deposit_id" = ?
      order by "created_at", "id"`,
    [tenantId, propertyId, depositId],
  );
}

export async function sumDepositApplications(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  depositId: string,
): Promise<{ applied: string; released: string }> {
  const result = await one<{ applied: string; released: string }>(
    em,
    `select
       coalesce(sum("amount") filter (where "kind" = 'APPLY'), 0)::text as "applied",
       coalesce(sum("amount") filter (where "kind" = 'RELEASE'), 0)::text as "released"
     from "deposit_application"
     where "tenant_id" = ? and "property_id" = ? and "deposit_id" = ?`,
    [tenantId, propertyId, depositId],
  );
  return result ?? { applied: '0', released: '0' };
}

export async function sumAppliedToCharge(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  chargeId: string,
): Promise<string> {
  const result = await one<{ total: string }>(
    em,
    `select coalesce(sum("amount"), 0)::text as "total"
       from "deposit_application"
      where "tenant_id" = ? and "property_id" = ? and "charge_id" = ?
        and "kind" = 'APPLY'`,
    [tenantId, propertyId, chargeId],
  );
  return result?.total ?? '0';
}

export async function insertDepositApplication(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    depositId: string;
    chargeId: string | null;
    kind: string;
    amount: string;
    reason: string;
    journalId: string;
    correlationId: string | null;
  },
): Promise<DepositApplicationRow> {
  const inserted = await one<DepositApplicationRow>(
    em,
    `insert into "deposit_application" (
       "tenant_id", "property_id", "deposit_id", "charge_id", "kind",
       "amount", "reason", "journal_id", "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.depositId,
      input.chargeId,
      input.kind,
      input.amount,
      input.reason,
      input.journalId,
      input.correlationId,
    ],
  );
  if (!inserted) throw new Error('deposit application returned no row');
  return inserted;
}

export function folioView(row: FolioRow) {
  return {
    id: row.id,
    reservation_id: row.reservation_id,
    kind: row.kind,
    payer_label: row.payer_label,
    currency: row.currency,
    state: row.state,
    version: row.version,
  };
}

export function chargeView(row: FolioChargeRow) {
  return {
    id: row.id,
    folio_id: row.folio_id,
    business_date: row.business_date,
    currency: row.currency,
    kind: row.kind,
    account_code: row.account_code,
    net_amount: normalizeMoney(row.net_amount),
    tax_amount: normalizeMoney(row.tax_amount),
    tax_policy: row.tax_policy,
    policy_snapshot_id: row.policy_snapshot_id,
    source_kind: row.source_kind,
    source_ref: row.source_ref,
    period_start: row.period_start,
    period_end: row.period_end,
    journal_id: row.journal_id,
    posted_at: row.posted_at,
  };
}

export async function findChargeBySource(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    sourceKind: string;
    sourceRef: string;
  },
): Promise<FolioChargeRow | null> {
  return one<FolioChargeRow>(
    em,
    `select * from "folio_charge"
      where "tenant_id" = ? and "property_id" = ? and "source_kind" = ?
        and "source_ref" = ?`,
    [input.tenantId, input.propertyId, input.sourceKind, input.sourceRef],
  );
}

export async function findConsumption(
  em: EntityManager,
  entitlementId: string,
  sourceKind: string,
  sourceRef: string,
): Promise<PackageConsumptionRow | null> {
  return one<PackageConsumptionRow>(
    em,
    `select * from "package_consumption"
      where "entitlement_id" = ? and "source_kind" = ? and "source_ref" = ?`,
    [entitlementId, sourceKind, sourceRef],
  );
}
