import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';

export interface ChannelRevisionRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  property_id: string;
  channel_key: string;
  provider_key: string;
  environment: string;
  provider_revision_id: string;
  external_booking_id: string;
  revision_type: string;
  payload_safe: Record<string, unknown>;
  source_sequence: string | null;
  processing_state: string;
  safe_error_code: string | null;
  reservation_ref: string | null;
  applied_at: string | null;
}

export async function findChannelRevision(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  revisionId: string,
): Promise<ChannelRevisionRow | null> {
  return one<ChannelRevisionRow>(
    em,
    `select r."id", r."tenant_id", r."connection_id", r."property_id",
            r."channel_key", r."provider_key", r."environment",
            r."provider_revision_id", r."external_booking_id",
            r."revision_type", r."payload_safe", r."source_sequence",
            r."processing_state", r."safe_error_code", r."reservation_ref",
            r."applied_at"::text as "applied_at"
       from "distribution_inbox_revision" r
      where r."id" = ? and r."tenant_id" = ? and r."property_id" = ?`,
    [revisionId, tenantId, propertyId],
  );
}

export async function findMaxAppliedSequence(
  em: EntityManager,
  connectionId: string,
): Promise<string | null> {
  const row = await one<{ max_sequence: string | null }>(
    em,
    `select max(case when "source_sequence" ~ '^[0-9]+$'
                     then "source_sequence"::numeric end)::text as "max_sequence"
       from "distribution_inbox_revision"
      where "connection_id" = ? and "processing_state" = 'APPLIED'
        and "reservation_ref" is not null
        and "source_sequence" is not null`,
    [connectionId],
  );
  return row?.max_sequence ?? null;
}

export async function markChannelRevision(
  em: EntityManager,
  input: {
    revisionId: string;
    reservationId: string | null;
    processingState: 'APPLIED' | 'EXCEPTION';
    safeErrorCode: string | null;
    exceptionId?: string | null;
  },
): Promise<void> {
  await em.execute(
    `update "distribution_inbox_revision"
        set "processing_state" = ?, "safe_error_code" = ?,
            "reservation_ref" = coalesce(?, "reservation_ref"),
            "exception_id" = coalesce(?, "exception_id"),
            "applied_at" = case when ? = 'APPLIED' then now() else "applied_at" end,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ?`,
    [
      input.processingState,
      input.safeErrorCode,
      input.reservationId,
      input.exceptionId ?? null,
      input.processingState,
      input.revisionId,
    ] as never[],
  );
}

export async function findReservationByExternalKey(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId: string,
  externalKey: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        and "channel_connection_id" = ? and "external_booking_key" = ?`,
    [tenantId, propertyId, connectionId, externalKey],
  );
}

export type ExternalKeyResolution =
  | { kind: 'linked'; reservationId: string }
  | { kind: 'adopt'; reservationId: string }
  | { kind: 'ambiguous'; candidateCount: number }
  | { kind: 'none' };

/**
 * Cutover resolution for an external booking key: a booking imported before the
 * channel feed opened is stored without a connection, so a later revision for
 * the same key would otherwise create a second reservation (AT-I09). Adoption
 * is only allowed for exactly one unlinked candidate; several candidates fail
 * closed and need manual matching.
 */
export async function resolveReservationForExternalKey(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId: string,
  externalKey: string,
): Promise<ExternalKeyResolution> {
  const linked = await one<{ id: string }>(
    em,
    `select "id" from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        and "channel_connection_id" = ? and "external_booking_key" = ?
      for update`,
    [tenantId, propertyId, connectionId, externalKey],
  );
  if (linked) return { kind: 'linked', reservationId: linked.id };
  const unlinked = await rows<{ id: string }>(
    em,
    `select "id" from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        and "channel_connection_id" is null and "external_booking_key" = ?
      order by "created_at", "id"
      for update`,
    [tenantId, propertyId, externalKey],
  );
  if (unlinked.length > 1)
    return { kind: 'ambiguous', candidateCount: unlinked.length };
  if (unlinked.length === 1)
    return { kind: 'adopt', reservationId: unlinked[0]!.id };
  return { kind: 'none' };
}

export async function attachReservationConnection(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    connectionId: string;
  },
): Promise<boolean> {
  const attached = await one<{ id: string }>(
    em,
    `update "reservation"
        set "channel_connection_id" = ?, "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "channel_connection_id" is null
      returning "id"`,
    [input.connectionId, input.reservationId, input.tenantId, input.propertyId],
  );
  return attached !== null;
}
