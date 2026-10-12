import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';

export interface ConnectionSyncSummary {
  pending: number;
  lease_failed: number;
  failed: number;
  unknown: number;
  partial: number;
  accepted: number;
  verified: number;
  provider_accepted_version: number | null;
  channel_verified_version: number | null;
  observed_at: string | null;
}

export async function summarizeConnectionOutbox(
  em: EntityManager,
  connectionId: string,
): Promise<ConnectionSyncSummary> {
  const row = await one<{
    pending: number;
    lease_failed: number;
    failed: number;
    unknown: number;
    partial: number;
    accepted: number;
    verified: number;
    provider_accepted_version: number | null;
    channel_verified_version: number | null;
    observed_at: string | null;
  }>(
    em,
    `select
       count(*) filter (where "status" in ('PENDING', 'RETRY_SCHEDULED', 'LEASED'))::int as "pending",
       count(*) filter (where "status" = 'DEAD_LETTER')::int as "failed",
       0 as "lease_failed",
       count(*) filter (where "status" = 'UNKNOWN')::int as "unknown",
       count(*) filter (where "status" = 'PARTIAL')::int as "partial",
       count(*) filter (where "status" in ('SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED'))::int as "accepted",
       count(*) filter (where "status" = 'CHANNEL_VERIFIED')::int as "verified",
       max("inventory_version") filter (where "status" in ('SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED'))::int as "provider_accepted_version",
       max("inventory_version") filter (where "status" = 'CHANNEL_VERIFIED')::int as "channel_verified_version",
       max("updated_at") filter (where "status" in ('SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED', 'UNKNOWN', 'PARTIAL', 'DEAD_LETTER'))::text as "observed_at"
     from "distribution_outbox_event"
     where "connection_id" = ?`,
    [connectionId],
  );
  if (!row) throw new Error('Outbox summary returned no row');
  return row;
}

export interface ExposureSyncRow {
  event_type: string;
  status: string;
  certainty: string | null;
  inventory_version: number;
  updated_at: string;
}

export async function listExposureEvents(
  em: EntityManager,
  connectionId: string,
  exposureId: string,
): Promise<ExposureSyncRow[]> {
  return rows<ExposureSyncRow>(
    em,
    `select "event_type", "status", "certainty", "inventory_version", "updated_at"::text
       from "distribution_outbox_event"
      where "connection_id" = ? and "aggregate_type" = 'Exposure'
        and "aggregate_id" = ?
      order by "created_at"`,
    [connectionId, exposureId],
  );
}

export async function listSyncAttempts(
  em: EntityManager,
  connectionId: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    event_type: string;
    status: string;
    attempt_count: number;
    certainty: string | null;
    last_safe_error_code: string | null;
    updated_at: string;
  }>
> {
  return rows(
    em,
    `select "id", "event_type", "status", "attempt_count", "certainty",
            "last_safe_error_code", "updated_at"::text
       from "distribution_outbox_event"
      where "connection_id" = ?
      order by "updated_at" desc
      limit ?`,
    [connectionId, limit],
  );
}
