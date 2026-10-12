import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from '../../../persistence/sql.js';

export interface IdempotencyRow {
  id: string;
  tenant_id: string;
  property_id: string | null;
  operation: string;
  key: string;
  request_hash: string;
  response_safe: Record<string, unknown>;
  resource_id: string | null;
  created_at: string;
}

export async function insertIdempotencyKey(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string | null;
    operation: string;
    key: string;
    requestHash: string;
    responseSafe: Record<string, unknown>;
    resourceId: string | null;
  },
): Promise<{ row: IdempotencyRow; inserted: boolean }> {
  const inserted = await one<IdempotencyRow>(
    em,
    `insert into "api_idempotency" (
        "id", "tenant_id", "property_id", "operation", "key",
        "request_hash", "response_safe", "resource_id"
     ) values (?, ?, ?, ?, ?, ?, ?::jsonb, ?)
     on conflict on constraint "api_idempotency_unique" do nothing
     returning *`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.operation,
      input.key,
      input.requestHash,
      JSON.stringify(input.responseSafe),
      input.resourceId,
    ],
  );
  if (inserted) return { row: inserted, inserted: true };
  const existing = await findIdempotencyKey(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    operation: input.operation,
    key: input.key,
  });
  if (!existing) throw new Error('idempotency key missing after conflict');
  return { row: existing, inserted: false };
}

export async function findIdempotencyKey(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string | null;
    operation: string;
    key: string;
  },
): Promise<IdempotencyRow | null> {
  return one<IdempotencyRow>(
    em,
    `select * from "api_idempotency"
      where "tenant_id" = ? and "operation" = ? and "key" = ?
        and "property_id" is not distinct from ?`,
    [input.tenantId, input.operation, input.key, input.propertyId],
  );
}
