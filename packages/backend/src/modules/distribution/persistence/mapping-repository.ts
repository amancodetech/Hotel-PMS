import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from './sql.js';
import type { MappingRow } from './types.js';

export interface NewMapping {
  connectionId: string;
  channelKey: string;
  externalRoomRef: string;
  externalRateRef: string;
  occupancy: number;
  mealPlanRef: string | null;
  internalProductRef: string | null;
  internalRateRef: string | null;
  effectiveAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  mappingVersion: number;
}

export async function upsertMapping(
  em: EntityManager,
  input: NewMapping,
): Promise<MappingRow> {
  const row = await one<MappingRow>(
    em,
    `insert into "distribution_mapping_version"
       ("id", "connection_id", "channel_key", "external_room_ref", "external_rate_ref",
        "occupancy", "meal_plan_ref", "internal_product_ref", "internal_rate_ref",
        "effective_at", "status", "mapping_version")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict ("connection_id", "channel_key", "external_room_ref", "external_rate_ref", "occupancy", "effective_at")
     do update set "status" = excluded."status",
                  "meal_plan_ref" = excluded."meal_plan_ref",
                  "internal_product_ref" = excluded."internal_product_ref",
                  "internal_rate_ref" = excluded."internal_rate_ref",
                  "mapping_version" = excluded."mapping_version",
                  "updated_at" = now()
     returning *`,
    [
      randomUUID(),
      input.connectionId,
      input.channelKey,
      input.externalRoomRef,
      input.externalRateRef,
      input.occupancy,
      input.mealPlanRef,
      input.internalProductRef,
      input.internalRateRef,
      input.effectiveAt,
      input.status,
      input.mappingVersion,
    ],
  );
  if (!row) throw new Error('Mapping upsert returned no row');
  return row;
}

export async function listActiveMappings(
  em: EntityManager,
  connectionId: string,
  channelKey: string,
): Promise<MappingRow[]> {
  return rows<MappingRow>(
    em,
    `select * from "distribution_mapping_version"
     where "connection_id" = ? and "channel_key" = ? and "status" = 'ACTIVE'
     order by "effective_at" desc`,
    [connectionId, channelKey],
  );
}

export async function listMappingsForConnection(
  em: EntityManager,
  connectionId: string,
): Promise<MappingRow[]> {
  return rows<MappingRow>(
    em,
    `select * from "distribution_mapping_version"
      where "connection_id" = ?
      order by "effective_at" desc, "created_at" desc`,
    [connectionId],
  );
}

export async function findMappingForItem(
  em: EntityManager,
  connectionId: string,
  channelKey: string,
  externalRoomRef: string,
  externalRateRef: string,
  occupancy: number,
): Promise<MappingRow | null> {
  return one<MappingRow>(
    em,
    `select * from "distribution_mapping_version"
     where "connection_id" = ? and "channel_key" = ?
       and "external_room_ref" = ? and "external_rate_ref" = ?
       and "occupancy" = ? and "status" = 'ACTIVE'
     order by "effective_at" desc
     limit 1`,
    [connectionId, channelKey, externalRoomRef, externalRateRef, occupancy],
  );
}
