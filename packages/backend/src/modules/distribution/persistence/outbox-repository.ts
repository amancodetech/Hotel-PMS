import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from './sql.js';
import type { OutboxRow } from './types.js';

export interface NewOutboxEvent {
  tenantId: string;
  propertyId: string;
  connectionId: string;
  channelKey: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  inventoryVersion: number;
  payloadSafe: unknown;
  nextAttemptAt?: string | null;
}

export async function enqueueOutbox(
  em: EntityManager,
  input: NewOutboxEvent,
): Promise<{ row: OutboxRow; inserted: boolean }> {
  const inserted = await one<OutboxRow>(
    em,
    `insert into "distribution_outbox_event"
       ("id", "tenant_id", "property_id", "connection_id", "channel_key",
        "aggregate_type", "aggregate_id", "event_type", "event_version",
        "inventory_version", "payload_safe", "next_attempt_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, coalesce(?::timestamptz, now()))
     on conflict ("connection_id", "aggregate_type", "aggregate_id", "event_type", "event_version")
     do nothing
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.channelKey,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.eventVersion,
      input.inventoryVersion,
      toJson(input.payloadSafe),
      input.nextAttemptAt ?? null,
    ],
  );
  if (inserted) return { row: inserted, inserted: true };
  const existing = await one<OutboxRow>(
    em,
    `select * from "distribution_outbox_event"
     where "connection_id" = ? and "aggregate_type" = ? and "aggregate_id" = ?
       and "event_type" = ? and "event_version" = ?`,
    [
      input.connectionId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.eventVersion,
    ],
  );
  if (!existing) throw new Error('Outbox conflict without an existing row');
  return { row: existing, inserted: false };
}

export interface LeaseInput {
  connectionId?: string;
  owner: string;
  limit: number;
  now: string;
  leaseMs: number;
}

export interface OutboxFence {
  owner: string;
  token: string;
}

export async function leaseDueOutbox(
  em: EntityManager,
  input: LeaseInput,
): Promise<OutboxRow[]> {
  const leaseExpiresAt = new Date(
    Date.parse(input.now) + input.leaseMs,
  ).toISOString();
  return rows<OutboxRow>(
    em,
    `with due as (
       select "id" from "distribution_outbox_event"
       where "status" in ('PENDING', 'RETRY_SCHEDULED', 'LEASED')
         ${input.connectionId ? 'and "connection_id" = ?' : ''}
         and "next_attempt_at" <= ?
         and ("lease_expires_at" is null or "lease_expires_at" <= ?)
       order by "next_attempt_at" asc, "created_at" asc
       limit ?
       for update skip locked
     )
     update "distribution_outbox_event" o
     set "status" = 'LEASED',
         "lease_owner" = ?,
         "lease_token" = gen_random_uuid(),
         "lease_expires_at" = ?,
         "updated_at" = now()
     from due
     where o."id" = due."id"
     returning o.*`,
    [
      ...(input.connectionId ? [input.connectionId] : []),
      input.now,
      input.now,
      input.limit,
      input.owner,
      leaseExpiresAt,
    ],
  );
}

export async function renewOutboxLease(
  em: EntityManager,
  input: OutboxFence & { id: string; now: string; leaseMs: number },
): Promise<OutboxRow | null> {
  const leaseExpiresAt = new Date(
    Date.parse(input.now) + input.leaseMs,
  ).toISOString();
  return one<OutboxRow>(
    em,
    `update "distribution_outbox_event"
     set "lease_expires_at" = ?, "updated_at" = now()
     where "id" = ? and "lease_owner" = ? and "lease_token" = ?
       and "status" = 'LEASED'
     returning *`,
    [leaseExpiresAt, input.id, input.owner, input.token],
  );
}

export interface OutboxResultPatch {
  status:
    | 'SENT'
    | 'ACKNOWLEDGED'
    | 'CHANNEL_VERIFIED'
    | 'PARTIAL'
    | 'UNKNOWN'
    | 'RETRY_SCHEDULED'
    | 'DEAD_LETTER'
    | 'CANCELLED'
    | 'SUPERSEDED';
  certainty?: string | null;
  safeErrorCode?: string | null;
  providerRequestId?: string | null;
  providerTaskId?: string | null;
  nextAttemptAt?: string | null;
  clearLease?: boolean;
}

export interface OutboxUpdateOptions {
  fence?: OutboxFence;
  requireStatus?: string;
}

export async function updateOutboxResult(
  em: EntityManager,
  id: string,
  patch: OutboxResultPatch,
  options: OutboxUpdateOptions = {},
): Promise<OutboxRow | null> {
  const setParams: unknown[] = [
    patch.status,
    patch.certainty ?? null,
    Object.hasOwn(patch, 'safeErrorCode'),
    patch.safeErrorCode ?? null,
    patch.providerRequestId ?? null,
    patch.providerTaskId ?? null,
    patch.nextAttemptAt ?? null,
    patch.clearLease === true,
    patch.clearLease === true,
    patch.clearLease === true,
  ];
  const conditions = ['"id" = ?'];
  const conditionParams: unknown[] = [id];
  if (options.fence) {
    conditions.push(
      '"lease_owner" = ?',
      '"lease_token" = ?',
      `"status" = 'LEASED'`,
    );
    conditionParams.push(options.fence.owner, options.fence.token);
  }
  if (options.requireStatus) {
    conditions.push('"status" = ?');
    conditionParams.push(options.requireStatus);
  }
  return one<OutboxRow>(
    em,
    `update "distribution_outbox_event"
     set "status" = ?,
         "certainty" = coalesce(?, "certainty"),
         "last_safe_error_code" = case when ? then ? else "last_safe_error_code" end,
         "provider_request_id" = coalesce(?, "provider_request_id"),
         "provider_task_id" = coalesce(?, "provider_task_id"),
         "next_attempt_at" = coalesce(?, "next_attempt_at"),
         "lease_owner" = case when ? then null else "lease_owner" end,
         "lease_token" = case when ? then null else "lease_token" end,
         "lease_expires_at" = case when ? then null else "lease_expires_at" end,
         "updated_at" = now()
     where ${conditions.join(' and ')}
     returning *`,
    [...setParams, ...conditionParams],
  );
}

export async function incrementOutboxAttempt(
  em: EntityManager,
  id: string,
  fence?: OutboxFence,
): Promise<OutboxRow | null> {
  const conditions = ['"id" = ?'];
  const params: unknown[] = [id];
  if (fence) {
    conditions.push(
      '"lease_owner" = ?',
      '"lease_token" = ?',
      `"status" = 'LEASED'`,
    );
    params.push(fence.owner, fence.token);
  }
  return one<OutboxRow>(
    em,
    `update "distribution_outbox_event"
     set "attempt_count" = "attempt_count" + 1, "updated_at" = now()
     where ${conditions.join(' and ')}
     returning *`,
    params,
  );
}

export async function findOutbox(
  em: EntityManager,
  id: string,
): Promise<OutboxRow | null> {
  return one<OutboxRow>(
    em,
    `select * from "distribution_outbox_event" where "id" = ?`,
    [id],
  );
}
