import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from './sql.js';
import type { DedupRow } from './types.js';

export type DedupOutcome =
  | { kind: 'new'; row: DedupRow }
  | { kind: 'duplicate'; row: DedupRow }
  | { kind: 'conflict'; row: DedupRow };

export interface DedupInput {
  scope: string;
  key: string;
  payloadHash: string | null;
  inboxRevisionId: string | null;
}

export async function registerDedup(
  em: EntityManager,
  input: DedupInput,
): Promise<DedupOutcome> {
  const inserted = await one<DedupRow>(
    em,
    `insert into "distribution_dedup_key"
       ("id", "scope", "dedup_key", "payload_hash", "inbox_revision_id")
     values (?, ?, ?, ?, ?)
     on conflict ("scope", "dedup_key") do nothing
     returning *`,
    [
      randomUUID(),
      input.scope,
      input.key,
      input.payloadHash,
      input.inboxRevisionId,
    ],
  );
  if (inserted) return { kind: 'new', row: inserted };
  const existing = await one<DedupRow>(
    em,
    `select * from "distribution_dedup_key"
     where "scope" = ? and "dedup_key" = ?
     for update`,
    [input.scope, input.key],
  );
  if (!existing) throw new Error('Dedup conflict without an existing row');
  return {
    kind:
      existing.payload_hash === input.payloadHash ? 'duplicate' : 'conflict',
    row: existing,
  };
}
