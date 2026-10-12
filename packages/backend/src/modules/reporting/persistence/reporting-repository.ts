import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';

export interface PropertyReportScope {
  id: string;
  code: string;
  name: string;
  timezone: string;
  base_currency: string;
}

export interface CountByKey {
  key: string;
  count: number;
}

export interface MaintenanceNightRow {
  night: string;
  resource_type: string;
  impact: 'OOO' | 'OOS';
  nights: number;
}

export interface ResourceNightClassRow {
  resource_type: string;
  class: 'PAID' | 'OWNER' | 'COMPLIMENTARY';
  nights: number;
}

export interface DisplayNightRow {
  product_kind: string;
  nights: number;
}

export interface ItemRow {
  id: string;
  reservation_id: string;
  product_kind: string;
  state: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  quantity: number;
  owner_stay: boolean;
  total_amount: string | null;
}

export async function findReportPropertyScope(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertyReportScope | null> {
  return one<PropertyReportScope>(
    em,
    `select "id", "code", "name", "timezone", "base_currency"
       from "property" where "id" = ? and "tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function listActiveResourceCounts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<Array<{ key: string; count: number }>> {
  return rows(
    em,
    `select "resource_type" as "key", count(*)::int as "count"
       from "resource"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'ACTIVE'
      group by "resource_type"
      order by "resource_type"`,
    [tenantId, propertyId],
  );
}

export interface ResourceStateCountRow {
  resource_type: string;
  key: string;
  count: number;
}

export async function listMaintenanceStateCounts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ResourceStateCountRow[]> {
  return rows(
    em,
    `select "resource_type", "maintenance_state" as "key", count(*)::int as "count"
       from "resource"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'ACTIVE'
      group by "resource_type", "maintenance_state"
      order by "resource_type", "maintenance_state"`,
    [tenantId, propertyId],
  );
}

export async function listHousekeepingStateCounts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ResourceStateCountRow[]> {
  return rows(
    em,
    `select "resource_type", "housekeeping_state" as "key", count(*)::int as "count"
       from "resource"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'ACTIVE'
      group by "resource_type", "housekeeping_state"
      order by "resource_type", "housekeeping_state"`,
    [tenantId, propertyId],
  );
}

export interface StayRevenueAttributionRow {
  resource_type: string;
  total: string;
  charges: number;
}

export interface StayRevenueAttributionResult {
  attributed: StayRevenueAttributionRow[];
  /** Posted REVENUE_ROOM charges in the period, attributed or not. */
  charges_total: string;
  charges_count: number;
}

/**
 * Attributes posted REVENUE_ROOM charges to resource types without inventing
 * an allocation:
 * - `STAY_NIGHT` charges carry the item id in `source_ref` (`itemId:date`), so
 *   they are attributed to the resource type(s) that item occupied that night.
 * - Other room charges are attributed to the resource types of the folio
 *   reservation's active items covering the charge business date.
 * A charge whose candidates span more than one resource type is left
 * unallocated and reported as such; a charge whose item has no assignment in
 * the period is unallocated too.
 */
export async function listStayRevenueAttribution(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<StayRevenueAttributionResult> {
  const attribution = await rows<StayRevenueAttributionRow>(
    em,
    `with charges as (
       select c."id",
              c."net_amount",
              c."business_date",
              c."source_kind",
              c."source_ref",
              f."reservation_id"
         from "folio_charge" c
         left join "folio" f
           on f."id" = c."folio_id"
          and f."tenant_id" = c."tenant_id"
          and f."property_id" = c."property_id"
        where c."tenant_id" = ?
          and c."property_id" = ?
          and c."currency" = ?
          and c."account_code" = 'REVENUE_ROOM'
          and c."business_date" >= ?::date
          and c."business_date" < ?::date
     ),
     candidates as (
       select c."id" as "charge_id", c."net_amount", r."resource_type", 1 as "priority"
         from charges c
         join "room_assignment" a
           on a."item_id" = case
                when c."source_kind" = 'STAY_NIGHT'
                 and c."source_ref" ~ '^[0-9a-fA-F-]{36}:'
                then split_part(c."source_ref", ':', 1)::uuid
              end
          and a."tenant_id" = ?
          and a."property_id" = ?
          and a."state" in ('ACTIVE', 'COMPLETED')
          and a."start_date" <= c."business_date"
          and a."end_date" > c."business_date"
         join "resource" r on r."id" = a."resource_id"
        where c."source_kind" = 'STAY_NIGHT'
       union all
       select c."id", c."net_amount", r."resource_type", 2
         from charges c
         join "reservation_item" i
           on i."reservation_id" = c."reservation_id"
          and i."tenant_id" = ?
          and i."property_id" = ?
          and i."state" in ('CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT', 'COMPLETED')
          and i."arrival" <= c."business_date"
          and i."departure" > c."business_date"
         join "room_assignment" a
           on a."item_id" = i."id"
          and a."state" in ('ACTIVE', 'COMPLETED')
          and a."start_date" <= c."business_date"
          and a."end_date" > c."business_date"
         join "resource" r on r."id" = a."resource_id"
        where c."source_kind" <> 'STAY_NIGHT'
          and c."reservation_id" is not null
     ),
     chosen as (
       select "charge_id", "net_amount", "resource_type",
              rank() over (
                partition by "charge_id" order by "priority"
              ) as "rank"
         from candidates
     ),
     single_type as (
       select "charge_id", "net_amount", min("resource_type") as "resource_type"
         from chosen
        where "rank" = 1
        group by "charge_id", "net_amount"
       having count(distinct "resource_type") = 1
     )
     select "resource_type",
            coalesce(sum("net_amount"), 0)::text as "total",
            count(*)::int as "charges"
       from single_type
      group by "resource_type"
      order by "resource_type"`,
    [
      tenantId,
      propertyId,
      currency,
      from,
      to,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
    ],
  );
  const summary = await one<{ charges_total: string; charges_count: number }>(
    em,
    `select coalesce(sum("net_amount"), 0)::text as "charges_total",
            count(*)::int as "charges_count"
       from "folio_charge"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "account_code" = 'REVENUE_ROOM'
        and "business_date" >= ?::date
        and "business_date" < ?::date`,
    [tenantId, propertyId, currency, from, to],
  );
  return {
    attributed: attribution,
    charges_total: summary?.charges_total ?? '0',
    charges_count: summary?.charges_count ?? 0,
  };
}

/**
 * Resource-nights unavailable for new stays because of open OOO/OOS work
 * orders over the period. Multiple orders on the same resource/night count
 * once, and OOO wins over OOS.
 */
export async function listMaintenanceResourceNights(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<MaintenanceNightRow[]> {
  return rows(
    em,
    `with covered as (
       select w."resource_id",
              d."night"::date as "night",
              w."impact",
              row_number() over (
                partition by w."resource_id", d."night"
                order by case w."impact" when 'OOO' then 2 else 1 end desc
              ) as "rank"
         from "ops_work_order" w
         cross join lateral generate_series(
           greatest(w."period_start", ?::date),
           least(w."period_end" - 1, ?::date - 1),
           interval '1 day'
         ) as d("night")
        where w."tenant_id" = ?
          and w."property_id" = ?
          and w."status" <> 'CLOSED'
          and w."impact" in ('OOO', 'OOS')
          and w."period_start" is not null
          and w."period_end" is not null
          and w."period_start" < ?::date
          and w."period_end" > ?::date
     )
     select c."night"::text as "night", r."resource_type", c."impact",
            count(*)::int as "nights"
       from covered c
       join "resource" r on r."id" = c."resource_id"
      where c."rank" = 1
      group by c."night", r."resource_type", c."impact"
      order by c."night", r."resource_type"`,
    [from, to, tenantId, propertyId, to, from],
  );
}

const resourceNightClassSql = `
  select r."resource_type",
         case
           when i."owner_stay" then 'OWNER'
           when q."total_amount" is not null and q."total_amount"::numeric = 0
             then 'COMPLIMENTARY'
           else 'PAID'
         end as "class",
         sum(
           least(a."end_date", ?::date) - greatest(a."start_date", ?::date)
         )::int as "nights"
    from "room_assignment" a
    join "resource" r on r."id" = a."resource_id"
    join "reservation_item" i on i."id" = a."item_id"
    left join "price_quote" q on q."id" = i."price_snapshot_id"
   where a."tenant_id" = ?
     and a."property_id" = ?
     and a."state" in ('ACTIVE', 'COMPLETED')
     and a."checked_in_at" is not null
     and a."start_date" < ?::date
     and a."end_date" > ?::date
   group by r."resource_type", "class"
   order by r."resource_type", "class"
`;

export async function listOccupiedResourceNights(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<ResourceNightClassRow[]> {
  return rows(em, resourceNightClassSql, [
    to,
    from,
    tenantId,
    propertyId,
    to,
    from,
  ]);
}

const reservedNightClassSql = `
  select r."resource_type",
         case
           when i."owner_stay" then 'OWNER'
           when q."total_amount" is not null and q."total_amount"::numeric = 0
             then 'COMPLIMENTARY'
           else 'PAID'
         end as "class",
         sum(
           least(a."end_date", ?::date) - greatest(a."start_date", ?::date)
         )::int as "nights"
    from "plan_allocation" a
    join "commitment" c on c."id" = a."commitment_id"
    join "resource" r on r."id" = a."resource_id"
    left join "reservation_item" i
      on c."source_kind" = 'ITEM' and i."id" = c."source_id"
    left join "price_quote" q on q."id" = i."price_snapshot_id"
   where a."tenant_id" = ?
     and a."property_id" = ?
     and a."state" = 'ACTIVE'
     and c."state" in ('ACTIVE', 'CONVERTED')
     and a."start_date" < ?::date
     and a."end_date" > ?::date
   group by r."resource_type", "class"
   order by r."resource_type", "class"
`;

export async function listReservedResourceNights(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<ResourceNightClassRow[]> {
  return rows(em, reservedNightClassSql, [
    to,
    from,
    tenantId,
    propertyId,
    to,
    from,
  ]);
}

export async function listDisplayNights(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<DisplayNightRow[]> {
  return rows(
    em,
    `select coalesce(p."kind", 'UNLINKED') as "product_kind",
            sum(
              least(i."departure", ?::date) - greatest(i."arrival", ?::date)
            )::int as "nights"
       from "reservation_item" i
       left join "product" p on p."id" = i."product_id"
      where i."tenant_id" = ?
        and i."property_id" = ?
        and i."state" in ('CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT', 'COMPLETED')
        and i."arrival" < ?::date
        and i."departure" > ?::date
      group by "product_kind"
      order by "product_kind"`,
    [to, from, tenantId, propertyId, to, from],
  );
}

export async function countPersons(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<Array<{ key: string; count: number }>> {
  return rows(
    em,
    `select coalesce(p."kind", 'UNLINKED') as "key",
            coalesce(sum(
              i."adults" + jsonb_array_length(
                case when jsonb_typeof(i."child_ages") = 'array'
                     then i."child_ages" else '[]'::jsonb end
              )
            ), 0)::int as "count"
       from "reservation_item" i
       left join "product" p on p."id" = i."product_id"
      where i."tenant_id" = ?
        and i."property_id" = ?
        and i."state" in ('CONFIRMED', 'IN_HOUSE', 'CHECKED_OUT', 'COMPLETED')
        and i."arrival" < ?::date
        and i."departure" > ?::date
      group by "key"
      order by "key"`,
    [tenantId, propertyId, to, from],
  );
}

export async function countItemsInState(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  field: 'arrival' | 'departure',
  from: string,
  to: string,
): Promise<Array<{ key: string; count: number }>> {
  const column = field === 'arrival' ? '"arrival"' : '"departure"';
  return rows(
    em,
    `select i."state" as "key", count(*)::int as "count"
       from "reservation_item" i
      where i."tenant_id" = ?
        and i."property_id" = ?
        and i.${column} >= ?::date
        and i.${column} < ?::date
      group by i."state"
      order by i."state"`,
    [tenantId, propertyId, from, to],
  );
}

export async function listItemsByDate(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  field: 'arrival' | 'departure',
  from: string,
  to: string,
): Promise<ItemRow[]> {
  const column = field === 'arrival' ? '"arrival"' : '"departure"';
  return rows<ItemRow>(
    em,
    `select i."id",
            i."reservation_id",
            coalesce(p."kind", 'UNLINKED') as "product_kind",
            i."state",
            i."arrival"::text as "arrival",
            i."departure"::text as "departure",
            i."adults",
            jsonb_array_length(
              case when jsonb_typeof(i."child_ages") = 'array'
                   then i."child_ages" else '[]'::jsonb end
            ) as "children",
            i."quantity",
            i."owner_stay",
            q."total_amount"::text as "total_amount"
       from "reservation_item" i
       left join "product" p on p."id" = i."product_id"
       left join "price_quote" q on q."id" = i."price_snapshot_id"
      where i."tenant_id" = ?
        and i."property_id" = ?
        and i.${column} >= ?::date
        and i.${column} < ?::date
      order by i.${column}, i."id"`,
    [tenantId, propertyId, from, to],
  );
}

export interface SnapshotRow {
  id: string;
  tenant_id: string;
  property_id: string;
  kind: string;
  reference_date: string;
  data: unknown;
  source_summary: unknown;
  captured_by_membership_id: string | null;
  captured_by_label: string | null;
  correlation_id: string | null;
  created_at: Date;
}

export async function findSnapshot(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  kind: string,
  referenceDate: string,
): Promise<SnapshotRow | null> {
  return one<SnapshotRow>(
    em,
    `select * from "report_snapshot"
      where "tenant_id" = ? and "property_id" = ? and "kind" = ?
        and "reference_date" = ?`,
    [tenantId, propertyId, kind, referenceDate],
  );
}

export async function insertSnapshot(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    kind: string;
    referenceDate: string;
    data: unknown;
    sourceSummary: unknown;
    capturedByMembershipId: string | null;
    capturedByLabel: string | null;
    correlationId: string | null;
  },
): Promise<SnapshotRow | null> {
  const inserted = await one<SnapshotRow>(
    em,
    `insert into "report_snapshot" (
       "tenant_id", "property_id", "kind", "reference_date", "data",
       "source_summary", "captured_by_membership_id", "captured_by_label",
       "correlation_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict on constraint "report_snapshot_reference_unique" do nothing
     returning *`,
    [
      input.tenantId,
      input.propertyId,
      input.kind,
      input.referenceDate,
      toJson(input.data),
      toJson(input.sourceSummary),
      input.capturedByMembershipId,
      input.capturedByLabel,
      input.correlationId,
    ],
  );
  // F-RVW11-02: null means a concurrent capture won the unique reference race.
  return inserted;
}

export async function listSnapshots(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  kind: string,
): Promise<SnapshotRow[]> {
  return rows<SnapshotRow>(
    em,
    `select * from "report_snapshot"
      where "tenant_id" = ? and "property_id" = ? and "kind" = ?
      order by "reference_date" desc`,
    [tenantId, propertyId, kind],
  );
}

export interface JournalAccountTotalRow {
  account_code: string;
  total: string;
}

/**
 * Net posted subledger movement per account for one currency over the
 * `business_date` period. Reversal entries are opposite lines, so the net
 * naturally includes corrections without rewriting the original journal.
 */
export async function listJournalAccountTotals(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<JournalAccountTotalRow[]> {
  return rows<JournalAccountTotalRow>(
    em,
    `select l."account_code",
            coalesce(sum(l."credit" - l."debit"), 0)::text as "total"
       from "journal_line" l
       join "journal" j on j."id" = l."journal_id"
      where j."tenant_id" = ?
        and j."property_id" = ?
        and j."state" = 'POSTED'
        and j."currency" = ?
        and j."business_date" >= ?::date
        and j."business_date" < ?::date
      group by l."account_code"
      order by l."account_code"`,
    [tenantId, propertyId, currency, from, to],
  );
}

export interface JournalCutoffRow {
  business_date: string;
  state: string;
}

export async function findReportActiveBusinessDay(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<JournalCutoffRow | null> {
  return one<JournalCutoffRow>(
    em,
    `select "business_date"::text as "business_date", "state"
       from "business_day"
      where "tenant_id" = ? and "property_id" = ?
        and "state" in (
          'OPEN', 'AUDIT_PREPARING', 'AUDIT_VALIDATION', 'CLOSING'
        )
      order by "business_date" desc
      limit 1`,
    [tenantId, propertyId],
  );
}

export async function findLatestClosedBusinessDay(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<JournalCutoffRow | null> {
  return one<JournalCutoffRow>(
    em,
    `select "business_date"::text as "business_date", "state"
       from "business_day"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'CLOSED'
      order by "business_date" desc
      limit 1`,
    [tenantId, propertyId],
  );
}

export interface ChargeTotalRow {
  account_code: string;
  net_total: string;
  tax_total: string;
}

/**
 * Posted folio charges by account and business date. This is the
 * charge-level cross-check of the posted journal; corrections that only
 * touch the journal remain visible as an explicit delta.
 */
export async function listChargeTotalsByAccount(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<ChargeTotalRow[]> {
  return rows<ChargeTotalRow>(
    em,
    `select "account_code",
            coalesce(sum("net_amount"), 0)::text as "net_total",
            coalesce(sum("tax_amount"), 0)::text as "tax_total"
       from "folio_charge"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "business_date" >= ?::date
        and "business_date" < ?::date
      group by "account_code"
      order by "account_code"`,
    [tenantId, propertyId, currency, from, to],
  );
}

export async function sumChargeTax(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<string> {
  const row = await one<{ tax_total: string }>(
    em,
    `select coalesce(sum("tax_amount"), 0)::text as "tax_total"
       from "folio_charge"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "business_date" >= ?::date
        and "business_date" < ?::date`,
    [tenantId, propertyId, currency, from, to],
  );
  return row?.tax_total ?? '0';
}

export interface PaymentTotalRow {
  method: string;
  state: string;
  total: string;
  gross_total: string | null;
  commission_total: string | null;
}

export async function listPaymentTotals(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<PaymentTotalRow[]> {
  return rows<PaymentTotalRow>(
    em,
    `select "method", "state",
            coalesce(sum("amount"), 0)::text as "total",
            coalesce(sum("gross_amount"), 0)::text as "gross_total",
            coalesce(sum("commission_amount"), 0)::text as "commission_total"
       from "folio_payment"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "business_date" >= ?::date
        and "business_date" < ?::date
      group by "method", "state"
      order by "method", "state"`,
    [tenantId, propertyId, currency, from, to],
  );
}

export async function listRefundTotals(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
  timezone: string,
): Promise<Array<{ state: string; total: string }>> {
  // F-RVW11-03: V1 has no business_date on folio_refund, so the period is the
  // property-local calendar day derived from created_at, never UTC.
  return rows(
    em,
    `select "state", coalesce(sum("amount"), 0)::text as "total"
       from "folio_refund"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "created_at" >= (?::date::timestamp at time zone ?)
        and "created_at" < (?::date::timestamp at time zone ?)
      group by "state"
      order by "state"`,
    [tenantId, propertyId, currency, from, timezone, to, timezone],
  );
}

export async function listCashierVariances(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
  timezone: string,
): Promise<Array<{ state: string; sessions: number; variance: string }>> {
  // F-RVW11-03: same property-local day window as listRefundTotals above.
  return rows(
    em,
    `select "state", count(*)::int as "sessions",
            coalesce(sum("variance"), 0)::text as "variance"
       from "cashier_session"
      where "tenant_id" = ?
        and "property_id" = ?
        and "currency" = ?
        and "created_at" >= (?::date::timestamp at time zone ?)
        and "created_at" < (?::date::timestamp at time zone ?)
      group by "state"
      order by "state"`,
    [tenantId, propertyId, currency, from, timezone, to, timezone],
  );
}

export interface ChannelPerformanceRow {
  channel_key: string;
  gross_total: string;
  commission_total: string;
  net_total: string;
  external_bookings: number;
  cancelled_bookings: number;
}

/**
 * Channel performance per connection key: gross, commission and net stay
 * separate (F-08) and cancellations are counted from external bookings.
 */
export async function listChannelPerformance(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  currency: string,
  from: string,
  to: string,
): Promise<ChannelPerformanceRow[]> {
  return rows<ChannelPerformanceRow>(
    em,
    `with bookings as (
       select coalesce(b."channel_key", 'UNLINKED') as "channel_key",
              b."external_booking_id",
              r."state" as "reservation_state"
         from "distribution_external_booking" b
         left join "reservation" r on r."id" = b."reservation_ref"
        where b."tenant_id" = ? and b."property_id" = ?
     ),
     payments as (
       select p."external_reference",
              sum(p."gross_amount") as "gross",
              sum(p."commission_amount") as "commission",
              sum(p."amount") as "net"
         from "folio_payment" p
        where p."tenant_id" = ?
          and p."property_id" = ?
          and p."method" = 'OTA_SETTLEMENT'
          and p."state" = 'SUCCEEDED'
          and p."currency" = ?
          and p."business_date" >= ?::date
          and p."business_date" < ?::date
        group by p."external_reference"
     )
     select bk."channel_key",
            coalesce(sum(pm."gross"), 0)::text as "gross_total",
            coalesce(sum(pm."commission"), 0)::text as "commission_total",
            coalesce(sum(pm."net"), 0)::text as "net_total",
            count(*)::int as "external_bookings",
            count(*) filter (where bk."reservation_state" = 'CANCELLED')::int
              as "cancelled_bookings"
       from bookings bk
       left join payments pm
         on pm."external_reference" = bk."external_booking_id"
      group by bk."channel_key"
      order by bk."channel_key"`,
    [tenantId, propertyId, tenantId, propertyId, currency, from, to],
  );
}

export async function listTenantProperties(
  em: EntityManager,
  tenantId: string,
): Promise<PropertyReportScope[]> {
  return rows<PropertyReportScope>(
    em,
    `select "id", "code", "name", "timezone", "base_currency"
       from "property" where "tenant_id" = ? order by "code"`,
    [tenantId],
  );
}

export async function findPropertyInTenant(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "property" where "id" = ? and "tenant_id" = ?`,
    [propertyId, tenantId],
  );
}
