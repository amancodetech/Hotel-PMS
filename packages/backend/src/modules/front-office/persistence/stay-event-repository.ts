import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from '../../../persistence/sql.js';

export type StayEventType =
  | 'STAY_CHECKED_IN'
  | 'STAY_MOVED'
  | 'STAY_EXTENDED'
  | 'STAY_SPLIT'
  | 'STAY_EARLY_DEPARTURE'
  | 'STAY_PARTIAL_DEPARTURE'
  | 'STAY_CHECKED_OUT';

export interface StayEventRow {
  id: string;
  tenant_id: string;
  property_id: string;
  reservation_id: string;
  item_id: string;
  segment_id: string | null;
  type: StayEventType;
  resource_id: string | null;
  payload: Record<string, unknown>;
  item_version: number;
  occurred_at: string;
}

const eventColumns = `"id", "tenant_id", "property_id", "reservation_id",
  "item_id", "segment_id", "type", "resource_id", "payload", "item_version",
  "occurred_at"`;

export async function findStayEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    type: StayEventType;
    itemVersion: number;
  },
): Promise<StayEventRow | null> {
  return one<StayEventRow>(
    em,
    `select ${eventColumns} from "stay_event"
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "type" = ? and "item_version" = ?`,
    [
      input.tenantId,
      input.propertyId,
      input.itemId,
      input.type,
      input.itemVersion,
    ],
  );
}

export async function insertStayEvent(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    reservationId: string;
    itemId: string;
    segmentId: string | null;
    type: StayEventType;
    resourceId: string | null;
    payload?: Record<string, unknown>;
    itemVersion: number;
  },
): Promise<{ inserted: boolean; row: StayEventRow }> {
  const insertedRow = await one<StayEventRow>(
    em,
    `insert into "stay_event" (
        "id", "tenant_id", "property_id", "reservation_id", "item_id",
        "segment_id", "type", "resource_id", "payload", "item_version"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
     on conflict ("tenant_id", "property_id", "item_id", "type", "item_version")
     do nothing
     returning ${eventColumns}`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.itemId,
      input.segmentId,
      input.type,
      input.resourceId,
      JSON.stringify(input.payload ?? {}),
      input.itemVersion,
    ],
  );
  if (insertedRow) return { inserted: true, row: insertedRow };
  const existing = await findStayEvent(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    itemId: input.itemId,
    type: input.type,
    itemVersion: input.itemVersion,
  });
  if (!existing) throw new Error('stay_event conflict without existing row');
  return { inserted: false, row: existing };
}
