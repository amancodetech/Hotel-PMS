import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from './sql.js';
import type { ExceptionRow } from './types.js';

export interface NewException {
  tenantId: string;
  propertyId: string;
  connectionId: string | null;
  inboxRevisionId: string | null;
  outboxId: string | null;
  type: string;
  detailsSafe: unknown;
}

export async function openException(
  em: EntityManager,
  input: NewException,
): Promise<ExceptionRow> {
  const row = await one<ExceptionRow>(
    em,
    `insert into "distribution_exception_case"
       ("id", "tenant_id", "property_id", "connection_id", "inbox_revision_id", "outbox_id", "type", "details_safe")
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.inboxRevisionId,
      input.outboxId,
      input.type,
      toJson(input.detailsSafe),
    ],
  );
  if (!row) throw new Error('Exception insert returned no row');
  return row;
}

export async function resolveException(
  em: EntityManager,
  id: string,
  resolution: string,
  owner: string | null,
): Promise<ExceptionRow | null> {
  return one<ExceptionRow>(
    em,
    `update "distribution_exception_case"
     set "state" = 'RESOLVED', "resolution" = ?, "owner" = coalesce(?, "owner"),
         "version" = "version" + 1, "updated_at" = now()
     where "id" = ?
     returning *`,
    [resolution, owner, id],
  );
}

export async function findLatestExceptionForInbox(
  em: EntityManager,
  inboxRevisionId: string,
  type: string,
): Promise<ExceptionRow | null> {
  return one<ExceptionRow>(
    em,
    `select * from "distribution_exception_case"
     where "inbox_revision_id" = ? and "type" = ?
     order by "created_at" desc
     limit 1`,
    [inboxRevisionId, type],
  );
}

export async function listOpenExceptions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ExceptionRow[]> {
  return rows<ExceptionRow>(
    em,
    `select * from "distribution_exception_case"
     where "tenant_id" = ? and "property_id" = ? and "state" in ('OPEN', 'IN_PROGRESS')
     order by "created_at" asc`,
    [tenantId, propertyId],
  );
}
