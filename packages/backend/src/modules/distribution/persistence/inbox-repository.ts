import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from './sql.js';
import type { InboxRow } from './types.js';

export interface NewInboxRevision {
  connectionId: string;
  channelKey: string;
  providerKey: string;
  environment: string;
  providerRevisionId: string;
  externalBookingId: string;
  revisionType: string;
  payloadHash: string;
  payloadSafe: unknown;
  sourceSequence: string | null;
  sourceTime: string | null;
  receivedAt: string;
}

export async function insertInboxRevision(
  em: EntityManager,
  input: NewInboxRevision,
): Promise<{ row: InboxRow; inserted: boolean }> {
  const inserted = await one<InboxRow>(
    em,
    `insert into "distribution_inbox_revision"
       ("id", "connection_id", "property_id", "channel_key", "provider_key",
        "environment", "provider_revision_id", "external_booking_id",
        "revision_type", "payload_hash", "payload_safe", "source_sequence",
        "source_time", "received_at")
     values (?, ?, (select "property_id" from "distribution_connection" where "id" = ?),
             ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
     on conflict ("connection_id", "provider_revision_id") do nothing
     returning *`,
    [
      randomUUID(),
      input.connectionId,
      input.connectionId,
      input.channelKey,
      input.providerKey,
      input.environment,
      input.providerRevisionId,
      input.externalBookingId,
      input.revisionType,
      input.payloadHash,
      toJson(input.payloadSafe),
      input.sourceSequence,
      input.sourceTime,
      input.receivedAt,
    ],
  );
  if (inserted) return { row: inserted, inserted: true };
  const existing = await findInboxRevisionForUpdate(
    em,
    input.connectionId,
    input.providerRevisionId,
  );
  if (!existing) throw new Error('Inbox conflict without an existing row');
  return { row: existing, inserted: false };
}

export async function findInboxRevision(
  em: EntityManager,
  connectionId: string,
  providerRevisionId: string,
): Promise<InboxRow | null> {
  return one<InboxRow>(
    em,
    `select * from "distribution_inbox_revision"
     where "connection_id" = ? and "provider_revision_id" = ?`,
    [connectionId, providerRevisionId],
  );
}

export async function findInboxRevisionForUpdate(
  em: EntityManager,
  connectionId: string,
  providerRevisionId: string,
): Promise<InboxRow | null> {
  return one<InboxRow>(
    em,
    `select * from "distribution_inbox_revision"
     where "connection_id" = ? and "provider_revision_id" = ?
     for update`,
    [connectionId, providerRevisionId],
  );
}

export async function findInboxRevisionByIdForUpdate(
  em: EntityManager,
  id: string,
): Promise<InboxRow | null> {
  return one<InboxRow>(
    em,
    `select * from "distribution_inbox_revision" where "id" = ? for update`,
    [id],
  );
}

export interface InboxPatch {
  processingState?:
    | 'RECEIVED'
    | 'APPLIED'
    | 'DUPLICATE'
    | 'IGNORED_STALE'
    | 'EXCEPTION'
    | 'UNKNOWN';
  safeErrorCode?: string | null;
  externalBookingRef?: string | null;
  exceptionId?: string | null;
  appliedAt?: string | null;
  ackState?: 'PENDING' | 'SENT' | 'UNKNOWN' | 'FAILED' | 'NOT_REQUIRED';
  ackProviderRequestId?: string | null;
  ackExceptionId?: string | null;
  incrementAckAttempts?: boolean;
  lastAttemptAt?: string | null;
}

export async function updateInboxRevision(
  em: EntityManager,
  id: string,
  patch: InboxPatch,
): Promise<InboxRow> {
  const row = await one<InboxRow>(
    em,
    `update "distribution_inbox_revision"
     set "processing_state" = coalesce(?, "processing_state"),
         "safe_error_code" = case when ? then ? else "safe_error_code" end,
         "external_booking_ref" = coalesce(?, "external_booking_ref"),
         "exception_id" = coalesce(?, "exception_id"),
         "applied_at" = coalesce(?, "applied_at"),
         "ack_state" = coalesce(?, "ack_state"),
         "ack_provider_request_id" = case when ? then ? else "ack_provider_request_id" end,
         "ack_exception_id" = coalesce(?, "ack_exception_id"),
         "ack_attempt_count" = "ack_attempt_count" + case when ? then 1 else 0 end,
         "last_attempt_at" = coalesce(?, "last_attempt_at"),
         "version" = "version" + 1,
         "updated_at" = now()
     where "id" = ?
     returning *`,
    [
      patch.processingState ?? null,
      Object.hasOwn(patch, 'safeErrorCode'),
      patch.safeErrorCode ?? null,
      patch.externalBookingRef ?? null,
      patch.exceptionId ?? null,
      patch.appliedAt ?? null,
      patch.ackState ?? null,
      Object.hasOwn(patch, 'ackProviderRequestId'),
      patch.ackProviderRequestId ?? null,
      patch.ackExceptionId ?? null,
      patch.incrementAckAttempts === true,
      patch.lastAttemptAt ?? null,
      id,
    ],
  );
  if (!row) throw new Error('Inbox update returned no row');
  return row;
}

export interface AckClaimInput {
  connectionId?: string;
  owner: string;
  limit: number;
  maxAttempts: number;
  now: string;
  leaseMs: number;
}

export async function claimPendingAck(
  em: EntityManager,
  input: AckClaimInput,
): Promise<InboxRow[]> {
  const leaseExpiresAt = new Date(
    Date.parse(input.now) + input.leaseMs,
  ).toISOString();
  return rows<InboxRow>(
    em,
    `with due as (
       select "id" from "distribution_inbox_revision"
       where "ack_state" in ('PENDING', 'UNKNOWN')
         ${input.connectionId ? 'and "connection_id" = ?' : ''}
         and "ack_attempt_count" < ?
         and ("ack_next_attempt_at" is null or "ack_next_attempt_at" <= ?)
         and ("ack_lease_expires_at" is null or "ack_lease_expires_at" <= ?)
       order by "ack_next_attempt_at" asc nulls first, "created_at" asc
       limit ?
       for update skip locked
     )
     update "distribution_inbox_revision" i
     set "ack_lease_owner" = ?,
         "ack_lease_token" = gen_random_uuid(),
         "ack_lease_expires_at" = ?,
         "ack_attempt_count" = "ack_attempt_count" + 1,
         "last_attempt_at" = ?,
         "version" = "version" + 1,
         "updated_at" = now()
     from due
     where i."id" = due."id"
     returning i.*`,
    [
      ...(input.connectionId ? [input.connectionId] : []),
      input.maxAttempts,
      input.now,
      input.now,
      input.limit,
      input.owner,
      leaseExpiresAt,
      input.now,
    ],
  );
}

export interface AckSweepInput {
  connectionId?: string;
  maxAttempts: number;
  now: string;
  limit: number;
}

export async function sweepExhaustedAcks(
  em: EntityManager,
  input: AckSweepInput,
): Promise<InboxRow[]> {
  return rows<InboxRow>(
    em,
    `with due as (
       select "id" from "distribution_inbox_revision"
       where "ack_state" in ('PENDING', 'UNKNOWN')
         ${input.connectionId ? 'and "connection_id" = ?' : ''}
         and "ack_attempt_count" >= ?
         and "ack_lease_expires_at" is not null
         and "ack_lease_expires_at" <= ?
       order by "created_at" asc
       limit ?
       for update skip locked
     )
     update "distribution_inbox_revision" i
     set "ack_state" = 'UNKNOWN',
         "ack_lease_owner" = null,
         "ack_lease_token" = null,
         "ack_lease_expires_at" = null,
         "ack_next_attempt_at" = null,
         "version" = "version" + 1,
         "updated_at" = now()
     from due
     where i."id" = due."id"
     returning i.*`,
    [
      ...(input.connectionId ? [input.connectionId] : []),
      input.maxAttempts,
      input.now,
      input.limit,
    ],
  );
}

export interface AckLeaseRenewal {
  id: string;
  owner: string;
  token: string;
  now: string;
  leaseMs: number;
}

export async function renewAckLease(
  em: EntityManager,
  input: AckLeaseRenewal,
): Promise<InboxRow | null> {
  const leaseExpiresAt = new Date(
    Date.parse(input.now) + input.leaseMs,
  ).toISOString();
  return one<InboxRow>(
    em,
    `update "distribution_inbox_revision"
     set "ack_lease_expires_at" = ?,
         "version" = "version" + 1,
         "updated_at" = now()
     where "id" = ? and "ack_lease_owner" = ? and "ack_lease_token" = ?
       and "ack_state" in ('PENDING', 'UNKNOWN')
     returning *`,
    [leaseExpiresAt, input.id, input.owner, input.token],
  );
}

export interface LegacyAckSweepInput {
  connectionId?: string;
  maxAttempts: number;
  limit: number;
}

export interface LegacyAckRow extends InboxRow {
  tenant_id: string | null;
  property_id: string | null;
}

export async function listUnrecoveredExhaustedAcks(
  em: EntityManager,
  input: LegacyAckSweepInput,
): Promise<LegacyAckRow[]> {
  return rows<LegacyAckRow>(
    em,
    `select i.*, c."tenant_id" as "tenant_id", c."property_id" as "property_id"
     from "distribution_inbox_revision" i
     join "distribution_connection" c on c."id" = i."connection_id"
     where i."ack_state" in ('PENDING', 'UNKNOWN')
       ${input.connectionId ? 'and i."connection_id" = ?' : ''}
       and i."ack_attempt_count" >= ?
       and i."ack_lease_expires_at" is null
       and i."ack_exception_id" is null
     order by i."created_at" asc
     limit ?
     for update of i skip locked`,
    [
      ...(input.connectionId ? [input.connectionId] : []),
      input.maxAttempts,
      input.limit,
    ],
  );
}

export interface AckResultPatch {
  ackState: 'SENT' | 'UNKNOWN' | 'FAILED';
  ackProviderRequestId: string | null;
  ackNextAttemptAt: string | null;
}

export async function updateAckResult(
  em: EntityManager,
  id: string,
  token: string,
  patch: AckResultPatch,
): Promise<InboxRow | null> {
  return one<InboxRow>(
    em,
    `update "distribution_inbox_revision"
     set "ack_state" = ?,
         "ack_provider_request_id" = ?,
         "ack_next_attempt_at" = ?,
         "ack_lease_owner" = null,
         "ack_lease_token" = null,
         "ack_lease_expires_at" = null,
         "version" = "version" + 1,
         "updated_at" = now()
     where "id" = ? and "ack_lease_token" = ?
       and "ack_state" in ('PENDING', 'UNKNOWN')
     returning *`,
    [
      patch.ackState,
      patch.ackProviderRequestId,
      patch.ackNextAttemptAt,
      id,
      token,
    ],
  );
}

export async function requeueAckRevision(
  em: EntityManager,
  id: string,
): Promise<InboxRow | null> {
  return one<InboxRow>(
    em,
    `update "distribution_inbox_revision"
     set "ack_state" = 'PENDING',
         "ack_attempt_count" = 0,
         "ack_next_attempt_at" = null,
         "ack_lease_owner" = null,
         "ack_lease_token" = null,
         "ack_lease_expires_at" = null,
         "ack_exception_id" = null,
         "version" = "version" + 1,
         "updated_at" = now()
     where "id" = ? and "ack_state" in ('UNKNOWN', 'FAILED')
     returning *`,
    [id],
  );
}

export async function countInboxRevisions(em: EntityManager): Promise<number> {
  const result = await one<{ count: string }>(
    em,
    `select count(*)::text as count from "distribution_inbox_revision"`,
  );
  return Number(result?.count ?? 0);
}
