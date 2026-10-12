import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const evidenceDir =
  process.env.P13_EVIDENCE_DIR ?? '.local/verification/P13-06';
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const logPath = `${evidenceDir}/monitor-snapshot.log`;
rmSync(logPath, { force: true });
const jsonPath = `${evidenceDir}/monitor-snapshot.json`;
const log = (line) => {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(logPath, `${stamped}\n`, { mode: 0o600 });
};

const client = new Client({ connectionString: url });
await client.connect();
try {
  const outbox = await client.query(`
    select "connection_id",
           count(*) filter (where "status" in ('PENDING','RETRY_SCHEDULED','LEASED'))::int as "pending",
           count(*) filter (where "status" = 'UNKNOWN')::int as "unknown",
           count(*) filter (where "status" = 'DEAD_LETTER')::int as "dead_letter",
           min("created_at") filter (where "status" in ('PENDING','RETRY_SCHEDULED','LEASED')) as "oldest_pending_at",
           extract(epoch from (now() - min("created_at") filter (where "status" in ('PENDING','RETRY_SCHEDULED','LEASED'))))::int as "oldest_pending_seconds"
      from "distribution_outbox_event"
     group by "connection_id"`);
  const inbox = await client.query(`
    select "connection_id",
           count(*) filter (where "processing_state" not in ('APPLIED','DUPLICATE','IGNORED_STALE'))::int as "unprocessed",
           min("received_at") filter (where "processing_state" not in ('APPLIED','DUPLICATE','IGNORED_STALE')) as "oldest_unprocessed_at"
      from "distribution_inbox_revision"
     group by "connection_id"`);
  const exceptions = await client.query(`
    select "connection_id", count(*)::int as "open"
      from "distribution_exception_case"
     where "state" in ('OPEN','IN_PROGRESS')
     group by "connection_id"`);
  const attempts = await client.query(`
    select o."connection_id",
           count(*) filter (where a."status" = 'FAILED')::int as "failed",
           count(*) filter (where a."certainty" = 'UNKNOWN')::int as "unknown"
      from "distribution_sync_attempt" a
      join "distribution_outbox_event" o on o."id" = a."outbox_id"
     group by o."connection_id"`);
  const freeze = await client.query(`
    select count(*)::int as "active_platform_stops"
      from "sale_restriction"
     where "platform_stop" and "state" = 'ACTIVE'`);

  const byConnection = new Map();
  const merge = (rows, apply) => {
    for (const row of rows) {
      const entry = byConnection.get(row.connection_id) ?? {
        connection_id: row.connection_id,
      };
      apply(entry, row);
      byConnection.set(row.connection_id, entry);
    }
  };
  merge(outbox.rows, (entry, row) =>
    Object.assign(entry, {
      outbox_pending: row.pending,
      outbox_unknown: row.unknown,
      outbox_dead_letter: row.dead_letter,
      oldest_pending_seconds: row.oldest_pending_seconds,
    }),
  );
  merge(inbox.rows, (entry, row) =>
    Object.assign(entry, {
      inbox_unprocessed: row.unprocessed,
      oldest_unprocessed_at: row.oldest_unprocessed_at,
    }),
  );
  merge(exceptions.rows, (entry, row) =>
    Object.assign(entry, { open_exceptions: row.open }),
  );
  merge(attempts.rows, (entry, row) =>
    Object.assign(entry, {
      attempts_failed: row.failed,
      attempts_unknown: row.unknown,
    }),
  );

  const snapshot = {
    generated_at: new Date().toISOString(),
    boundary:
      'Read-only local snapshot over synthetic data. No live channel evidence is implied.',
    active_platform_stops: freeze.rows[0].active_platform_stops,
    connections: [...byConnection.values()].sort((a, b) =>
      a.connection_id.localeCompare(b.connection_id),
    ),
  };
  writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
  log(
    `connections=${snapshot.connections.length} active_platform_stops=${snapshot.active_platform_stops}`,
  );
  for (const entry of snapshot.connections)
    log(
      `${entry.connection_id} pending=${entry.outbox_pending ?? 0} unknown=${entry.outbox_unknown ?? 0} ` +
        `dead=${entry.outbox_dead_letter ?? 0} oldest_pending_s=${entry.oldest_pending_seconds ?? 0} ` +
        `inbox_unprocessed=${entry.inbox_unprocessed ?? 0} exceptions=${entry.open_exceptions ?? 0} ` +
        `attempts_failed=${entry.attempts_failed ?? 0} attempts_unknown=${entry.attempts_unknown ?? 0}`,
    );
  log(`snapshot written to ${jsonPath}`);
} finally {
  await client.end();
}
