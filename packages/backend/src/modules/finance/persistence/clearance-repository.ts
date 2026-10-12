import type { EntityManager } from '@mikro-orm/postgresql';
import { parseDecimal } from '../../inventory/domain/pricing.js';
import { one, rows } from '../../../persistence/sql.js';

export interface ReservationClearanceRow {
  id: string;
  state: string;
  version: number;
  source: string;
  channel_connection_id: string | null;
  external_booking_key: string | null;
  financial_clearance_state: string;
  financial_cleared_at: Date | null;
  financial_clearance_basis: string | null;
  financial_clearance_reference: string | null;
  financial_clearance_payer_folio_id: string | null;
}

export interface ExternalBookingRefRow {
  id: string;
  connection_id: string;
  channel_key: string;
  external_booking_id: string;
  provider_booking_id: string | null;
  state: string;
}

export interface ExternalSettlementRow {
  id: string;
  folio_id: string;
  folio_reservation_id: string | null;
  folio_kind: string;
  folio_payer_label: string;
  method: string;
  currency: string;
  amount: string;
  gross_amount: string | null;
  commission_amount: string | null;
  business_date: string;
  external_reference: string;
  evidence_ref: string | null;
  source_ref: string;
  state: string;
  journal_id: string | null;
  reconciliation_reference: string | null;
  reservation_id: string | null;
  reservation_state: string | null;
  reservation_source: string | null;
  channel_connection_id: string | null;
  external_booking_key: string | null;
  external_booking_id: string | null;
  external_channel_key: string | null;
  external_provider_booking_id: string | null;
  external_booking_state: string | null;
}

export async function findReservationClearance(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationId: string,
): Promise<ReservationClearanceRow | null> {
  return one<ReservationClearanceRow>(
    em,
    `select "id", "state", "version", "source", "channel_connection_id",
            "external_booking_key", "financial_clearance_state",
            "financial_cleared_at", "financial_clearance_basis",
            "financial_clearance_reference", "financial_clearance_payer_folio_id"
       from "reservation"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [reservationId, tenantId, propertyId],
  );
}

/**
 * Signed effect on FOLIO_GUEST of the written corrections that belong to this
 * folio: the reversal/adjustment journals pointing at its charge journals plus
 * the credit notes issued against its invoices. A full reversal flips the
 * original posting (negative of the charge total); an adjustment applies its
 * declared direction; a credit note credits the guest exactly as its posted
 * journal does, so the subledger balance can never diverge from the ledger.
 * The original charge row is never edited (F-05).
 */
export async function sumFolioAdjustments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  folioId: string,
): Promise<bigint> {
  const row = await one<{ total: string }>(
    em,
    `select coalesce(sum(entry."amount"), 0)::text as "total"
       from (
         select case when l."debit" > 0 then l."debit" else -l."credit" end as "amount"
           from "journal" j
           join "journal_line" l
             on l."journal_id" = j."id" and l."account_code" = 'FOLIO_GUEST'
           join "folio_charge" c on c."journal_id" = j."adjusts_journal_id"
          where j."tenant_id" = ? and j."property_id" = ?
            and c."tenant_id" = ? and c."property_id" = ? and c."folio_id" = ?
         union all
         select case when l."debit" > 0 then l."debit" else -l."credit" end as "amount"
           from "journal" j
           join "journal_line" l
             on l."journal_id" = j."id" and l."account_code" = 'FOLIO_GUEST'
           join "folio_credit_note" cn on cn."journal_id" = j."id"
           join "folio_invoice" i
             on i."id" = cn."invoice_id" and i."tenant_id" = cn."tenant_id"
            and i."property_id" = cn."property_id"
          where j."tenant_id" = ? and j."property_id" = ?
            and cn."tenant_id" = ? and cn."property_id" = ? and i."folio_id" = ?
       ) entry`,
    [
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      folioId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      folioId,
    ] as never[],
  );
  return parseDecimal(row?.total ?? '0', 'adjustments_total', {
    allowNegative: true,
  });
}

/**
 * Moves a PENDING reservation to CLEARED only with evidence: a basis, the
 * clearing timestamp and — for a liability transfer — the COMPANY payer folio
 * and the documented collection-plan reference. The version guard makes the
 * transition single-winner under the property lock.
 */
export async function markReservationClearance(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    version: number;
    basis: 'SETTLED' | 'TRANSFER_TO_PAYER';
    reference: string | null;
    payerFolioId: string | null;
  },
): Promise<ReservationClearanceRow | null> {
  return one<ReservationClearanceRow>(
    em,
    `update "reservation"
        set "financial_clearance_state" = 'CLEARED',
            "financial_cleared_at" = now(),
            "financial_clearance_basis" = ?,
            "financial_clearance_reference" = ?,
            "financial_clearance_payer_folio_id" = ?,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "version" = ? and "financial_clearance_state" = 'PENDING'
      returning "id", "state", "version", "source", "channel_connection_id",
                "external_booking_key", "financial_clearance_state",
                "financial_cleared_at", "financial_clearance_basis",
                "financial_clearance_reference", "financial_clearance_payer_folio_id"`,
    [
      input.basis,
      input.reference,
      input.payerFolioId,
      input.reservationId,
      input.tenantId,
      input.propertyId,
      input.version,
    ] as never[],
  );
}

/**
 * Any later financial posting on a folio reopens a CLEARED reservation: the
 * stored clearance is only a statement about the ledger at that moment.
 */
export async function invalidateClearanceForFolios(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    folioIds: readonly string[];
  },
): Promise<{ reservation_id: string }[]> {
  const folioIds = [...new Set(input.folioIds)].filter(Boolean);
  if (folioIds.length === 0) return [];
  return rows<{ reservation_id: string }>(
    em,
    `update "reservation" r
        set "financial_clearance_state" = 'PENDING',
            "financial_cleared_at" = null,
            "financial_clearance_basis" = null,
            "financial_clearance_reference" = null,
            "financial_clearance_payer_folio_id" = null,
            "version" = r."version" + 1, "updated_at" = now()
      where r."tenant_id" = ? and r."property_id" = ?
        and r."financial_clearance_state" = 'CLEARED'
        and r."id" in (
          select distinct f."reservation_id" from "folio" f
           where f."tenant_id" = ? and f."property_id" = ?
             and f."reservation_id" is not null
             and f."id" = any(string_to_array(?, ',')::uuid[])
        )
      returning r."id" as "reservation_id"`,
    [
      input.tenantId,
      input.propertyId,
      input.tenantId,
      input.propertyId,
      folioIds.join(','),
    ] as never[],
  );
}

export async function findExternalBookingForReservation(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationId: string,
): Promise<ExternalBookingRefRow | null> {
  return one<ExternalBookingRefRow>(
    em,
    `select "id", "connection_id", "channel_key", "external_booking_id",
            "provider_booking_id", "state"
       from "distribution_external_booking"
      where "tenant_id" = ? and "property_id" = ? and "reservation_ref" = ?
      order by "updated_at" desc, "id"
      limit 1`,
    [tenantId, propertyId, reservationId],
  );
}

export async function listExternalSettlementRows(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId?: string | null;
    state?: string | null;
  },
): Promise<ExternalSettlementRow[]> {
  const reservationId = input.reservationId ?? null;
  const state = input.state ?? null;
  return rows<ExternalSettlementRow>(
    em,
    `select p."id", p."folio_id", f."reservation_id" as "folio_reservation_id",
            f."kind" as "folio_kind", f."payer_label" as "folio_payer_label",
            p."method", p."currency", p."amount"::text as "amount",
            p."gross_amount"::text as "gross_amount",
            p."commission_amount"::text as "commission_amount",
            p."business_date"::text as "business_date",
            p."external_reference", p."evidence_ref", p."source_ref",
            p."state", p."journal_id", p."reconciliation_reference",
            r."id" as "reservation_id", r."state" as "reservation_state",
            r."source" as "reservation_source",
            r."channel_connection_id", r."external_booking_key",
            b."id" as "external_booking_id", b."channel_key" as "external_channel_key",
            b."provider_booking_id" as "external_provider_booking_id",
            b."state" as "external_booking_state"
       from "folio_payment" p
       join "folio" f
         on f."id" = p."folio_id" and f."tenant_id" = p."tenant_id"
        and f."property_id" = p."property_id"
       left join "reservation" r
         on r."id" = f."reservation_id" and r."tenant_id" = p."tenant_id"
        and r."property_id" = p."property_id"
       left join "distribution_external_booking" b
         on b."reservation_ref" = r."id" and b."tenant_id" = p."tenant_id"
        and b."property_id" = p."property_id"
      where p."tenant_id" = ? and p."property_id" = ?
        and p."method" = 'OTA_SETTLEMENT'
        and (?::uuid is null or f."reservation_id" = ?::uuid)
        and (?::text is null or p."state" = ?::text)
      order by p."created_at", p."id"`,
    [
      input.tenantId,
      input.propertyId,
      reservationId,
      reservationId,
      state,
      state,
    ] as never[],
  );
}
