import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from './sql.js';
import type { ConnectionRow } from './types.js';

export interface NewConnection {
  id?: string;
  tenantId: string;
  propertyId: string;
  providerKey: string;
  environment: string;
  channelKey: string;
  externalPropertyId: string | null;
  secretRef: string;
}

export async function insertConnection(
  em: EntityManager,
  input: NewConnection,
): Promise<ConnectionRow> {
  const row = await one<ConnectionRow>(
    em,
    `insert into "distribution_connection"
       ("id", "tenant_id", "property_id", "provider_key", "environment", "channel_key", "external_property_id", "secret_ref")
     values (?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.providerKey,
      input.environment,
      input.channelKey,
      input.externalPropertyId,
      input.secretRef,
    ],
  );
  if (!row) throw new Error('Connection insert returned no row');
  return row;
}

export async function findConnection(
  em: EntityManager,
  id: string,
): Promise<ConnectionRow | null> {
  return one<ConnectionRow>(
    em,
    `select * from "distribution_connection" where "id" = ?`,
    [id],
  );
}

export async function findConnectionForUpdate(
  em: EntityManager,
  id: string,
): Promise<ConnectionRow | null> {
  return one<ConnectionRow>(
    em,
    `select * from "distribution_connection" where "id" = ? for update`,
    [id],
  );
}

export async function listConnections(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ConnectionRow[]> {
  return rows<ConnectionRow>(
    em,
    `select * from "distribution_connection"
     where "tenant_id" = ? and "property_id" = ?
     order by "created_at" asc`,
    [tenantId, propertyId],
  );
}
