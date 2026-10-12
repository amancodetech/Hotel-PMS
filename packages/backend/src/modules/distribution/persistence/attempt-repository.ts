import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from './sql.js';
import type { AttemptRow } from './types.js';

export async function startAttempt(
  em: EntityManager,
  input: { outboxId: string; attemptNo: number; startedAt: string },
): Promise<AttemptRow> {
  const row = await one<AttemptRow>(
    em,
    `insert into "distribution_sync_attempt"
       ("id", "outbox_id", "attempt_no", "status", "started_at")
     values (?, ?, ?, 'STARTED', ?)
     returning *`,
    [randomUUID(), input.outboxId, input.attemptNo, input.startedAt],
  );
  if (!row) throw new Error('Attempt insert returned no row');
  return row;
}

export interface AttemptFinish {
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REJECTED';
  certainty: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  providerTaskId: string | null;
  safeErrorCode: string | null;
  retryAfterMs: number | null;
  finishedAt: string;
  responseSafe: unknown;
}

export async function finishAttempt(
  em: EntityManager,
  outboxId: string,
  attemptNo: number,
  patch: AttemptFinish,
): Promise<AttemptRow> {
  const row = await one<AttemptRow>(
    em,
    `update "distribution_sync_attempt"
     set "status" = ?,
         "certainty" = ?,
         "http_status" = ?,
         "provider_request_id" = ?,
         "provider_task_id" = ?,
         "safe_error_code" = ?,
         "retry_after_ms" = ?,
         "finished_at" = ?,
         "response_safe" = ?::jsonb
     where "outbox_id" = ? and "attempt_no" = ?
     returning *`,
    [
      patch.status,
      patch.certainty,
      patch.httpStatus,
      patch.providerRequestId,
      patch.providerTaskId,
      patch.safeErrorCode,
      patch.retryAfterMs,
      patch.finishedAt,
      toJson(patch.responseSafe),
      outboxId,
      attemptNo,
    ],
  );
  if (!row) throw new Error('Attempt update returned no row');
  return row;
}

export async function listAttempts(
  em: EntityManager,
  outboxId: string,
): Promise<AttemptRow[]> {
  return rows<AttemptRow>(
    em,
    `select * from "distribution_sync_attempt"
     where "outbox_id" = ?
     order by "attempt_no" asc`,
    [outboxId],
  );
}

export async function nextAttemptNumber(
  em: EntityManager,
  outboxId: string,
): Promise<number> {
  const result = await one<{ max: string | null }>(
    em,
    `select max("attempt_no")::text as max from "distribution_sync_attempt" where "outbox_id" = ?`,
    [outboxId],
  );
  return Number(result?.max ?? 0) + 1;
}
