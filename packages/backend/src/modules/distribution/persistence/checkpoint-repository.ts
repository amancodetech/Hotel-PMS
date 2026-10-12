import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from './sql.js';
import type { CheckpointRow } from './types.js';

export async function getCheckpoint(
  em: EntityManager,
  connectionId: string,
  stream: string,
): Promise<CheckpointRow | null> {
  return one<CheckpointRow>(
    em,
    `select * from "distribution_sync_checkpoint"
     where "connection_id" = ? and "stream" = ?`,
    [connectionId, stream],
  );
}

export async function setCheckpoint(
  em: EntityManager,
  input: {
    connectionId: string;
    stream: string;
    cursor: string | null;
    pulledAt: string;
  },
): Promise<CheckpointRow> {
  const row = await one<CheckpointRow>(
    em,
    `insert into "distribution_sync_checkpoint"
       ("id", "connection_id", "stream", "cursor", "last_pull_at")
     values (?, ?, ?, ?, ?)
     on conflict ("connection_id", "stream")
     do update set "cursor" = excluded."cursor",
                   "last_pull_at" = excluded."last_pull_at",
                   "version" = "distribution_sync_checkpoint"."version" + 1,
                   "updated_at" = now()
     returning *`,
    [
      randomUUID(),
      input.connectionId,
      input.stream,
      input.cursor,
      input.pulledAt,
    ],
  );
  if (!row) throw new Error('Checkpoint upsert returned no row');
  return row;
}
