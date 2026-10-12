import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from './sql.js';
import type { ExternalBookingRow } from './types.js';

export interface ExternalBookingUpdate {
  connectionId: string;
  channelKey: string;
  externalBookingId: string;
  providerBookingId: string | null;
  state: 'ACTIVE' | 'CANCELLED' | 'EXCEPTION';
  latestRevisionId: string | null;
  latestPayloadHash: string | null;
  sourceSequence: string | null;
  sourceTime: string | null;
  exceptionId: string | null;
}

export async function findExternalBookingForUpdate(
  em: EntityManager,
  connectionId: string,
  externalBookingId: string,
): Promise<ExternalBookingRow | null> {
  return one<ExternalBookingRow>(
    em,
    `select * from "distribution_external_booking"
     where "connection_id" = ? and "external_booking_id" = ?
     for update`,
    [connectionId, externalBookingId],
  );
}

export async function upsertExternalBooking(
  em: EntityManager,
  input: ExternalBookingUpdate,
): Promise<ExternalBookingRow> {
  const row = await one<ExternalBookingRow>(
    em,
    `insert into "distribution_external_booking"
       ("id", "connection_id", "property_id", "channel_key", "external_booking_id",
        "provider_booking_id", "state", "latest_revision_id", "latest_payload_hash",
        "source_sequence", "source_time", "exception_id")
     values (?, ?, (select "property_id" from "distribution_connection" where "id" = ?),
             ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict ("connection_id", "external_booking_id")
     do update set "channel_key" = excluded."channel_key",
                   "provider_booking_id" = excluded."provider_booking_id",
                   "state" = excluded."state",
                   "latest_revision_id" = excluded."latest_revision_id",
                   "latest_payload_hash" = excluded."latest_payload_hash",
                   "source_sequence" = excluded."source_sequence",
                   "source_time" = excluded."source_time",
                   "exception_id" = excluded."exception_id",
                   "version" = "distribution_external_booking"."version" + 1,
                   "updated_at" = now()
     returning *`,
    [
      randomUUID(),
      input.connectionId,
      input.connectionId,
      input.channelKey,
      input.externalBookingId,
      input.providerBookingId,
      input.state,
      input.latestRevisionId,
      input.latestPayloadHash,
      input.sourceSequence,
      input.sourceTime,
      input.exceptionId,
    ],
  );
  if (!row) throw new Error('External booking upsert returned no row');
  return row;
}
