import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from './sql.js';
import type { DeadLetterRow } from './types.js';

export interface NewDeadLetter {
  tenantId: string;
  propertyId: string;
  connectionId: string;
  outboxId: string | null;
  eventType: string;
  payloadSafe: unknown;
  safeErrorCode: string | null;
  attempts: number;
  reason: string;
}

export async function insertDeadLetter(
  em: EntityManager,
  input: NewDeadLetter,
): Promise<DeadLetterRow> {
  const row = await one<DeadLetterRow>(
    em,
    `insert into "distribution_dead_letter"
       ("id", "tenant_id", "property_id", "connection_id", "outbox_id", "event_type",
        "payload_safe", "safe_error_code", "attempts", "reason")
     values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.outboxId,
      input.eventType,
      toJson(input.payloadSafe),
      input.safeErrorCode,
      input.attempts,
      input.reason,
    ],
  );
  if (!row) throw new Error('Dead letter insert returned no row');
  return row;
}

export async function findDeadLetter(
  em: EntityManager,
  id: string,
): Promise<DeadLetterRow | null> {
  return one<DeadLetterRow>(
    em,
    `select * from "distribution_dead_letter" where "id" = ?`,
    [id],
  );
}

export async function listDeadLetters(
  em: EntityManager,
): Promise<DeadLetterRow[]> {
  return rows<DeadLetterRow>(
    em,
    `select * from "distribution_dead_letter" order by "created_at" asc`,
  );
}

export async function markDeadLetterReprocessed(
  em: EntityManager,
  id: string,
  input: { by: string; reason: string },
): Promise<DeadLetterRow | null> {
  return one<DeadLetterRow>(
    em,
    `update "distribution_dead_letter"
     set "reprocessed_at" = now(), "reprocessed_by" = ?, "reprocess_reason" = ?
     where "id" = ?
     returning *`,
    [input.by, input.reason, id],
  );
}
