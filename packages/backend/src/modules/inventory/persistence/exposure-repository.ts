import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';

export type ExposureState =
  | 'DRAFT'
  | 'RESERVED'
  | 'PUBLISHING'
  | 'ACTIVE'
  | 'WITHDRAWING'
  | 'RECONCILING'
  | 'RELEASED'
  | 'UNKNOWN';

export interface ExposureRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string;
  product_id: string;
  start_date: string;
  end_date: string;
  mode: 'WHOLE' | 'PARTS';
  state: ExposureState;
  epoch: number;
  inventory_version: number;
  preview_version: number;
  cutoff: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ExposureAllocationRow {
  id: string;
  exposure_id: string;
  tenant_id: string;
  property_id: string;
  resource_id: string;
  start_date: string;
  end_date: string;
  state: 'RESERVED' | 'RELEASED';
  created_at: string;
  updated_at: string;
}

export interface SaleRestrictionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string;
  product_id: string;
  start_date: string;
  end_date: string;
  reason: string;
  state: 'ACTIVE' | 'OPENED';
  opened_at: string | null;
  opened_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ExposurePreviewRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string;
  product_id: string;
  start_date: string;
  end_date: string;
  mode: 'WHOLE' | 'PARTS';
  resource_ids: string[];
  inventory_version: number;
  preview_version: number;
  allowed: boolean;
  reason_codes: string[];
  expires_at: string;
  created_at: string;
}

export async function insertExposure(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
    productId: string;
    startDate: string;
    endDate: string;
    mode: 'WHOLE' | 'PARTS';
    state: ExposureState;
    inventoryVersion: number;
    previewVersion: number;
    cutoff: string | null;
  },
): Promise<ExposureRow> {
  const row = await one<ExposureRow>(
    em,
    `insert into "exposure"
       ("id", "tenant_id", "property_id", "connection_id", "product_id",
        "start_date", "end_date", "mode", "state", "inventory_version",
        "preview_version", "cutoff")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.productId,
      input.startDate,
      input.endDate,
      input.mode,
      input.state,
      input.inventoryVersion,
      input.previewVersion,
      input.cutoff,
    ],
  );
  if (!row) throw new Error('Exposure insert returned no row');
  return row;
}

export async function findExposure(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  exposureId: string,
): Promise<ExposureRow | null> {
  return one<ExposureRow>(
    em,
    `select * from "exposure"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [exposureId, tenantId, propertyId],
  );
}

export async function listExposures(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId?: string,
): Promise<ExposureRow[]> {
  return rows<ExposureRow>(
    em,
    `select * from "exposure"
      where "tenant_id" = ? and "property_id" = ?
        and (?::uuid is null or "connection_id" = ?::uuid)
      order by "start_date", "created_at"`,
    [
      tenantId,
      propertyId,
      connectionId ?? null,
      connectionId ?? null,
    ] as never[],
  );
}

export async function listExposureAllocations(
  em: EntityManager,
  exposureId: string,
): Promise<ExposureAllocationRow[]> {
  return rows<ExposureAllocationRow>(
    em,
    `select * from "exposure_allocation"
      where "exposure_id" = ?
      order by "resource_id"`,
    [exposureId],
  );
}

export async function insertExposureAllocation(
  em: EntityManager,
  input: {
    exposureId: string;
    tenantId: string;
    propertyId: string;
    resourceId: string;
    startDate: string;
    endDate: string;
  },
): Promise<ExposureAllocationRow> {
  const row = await one<ExposureAllocationRow>(
    em,
    `insert into "exposure_allocation"
       ("id", "exposure_id", "tenant_id", "property_id", "resource_id",
        "start_date", "end_date")
     values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.exposureId,
      input.tenantId,
      input.propertyId,
      input.resourceId,
      input.startDate,
      input.endDate,
    ],
  );
  if (!row) throw new Error('Exposure allocation insert returned no row');
  return row;
}

export async function updateExposureState(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    exposureId: string;
    state: ExposureState;
    cutoff?: string | null;
  },
): Promise<ExposureRow | null> {
  const hasCutoff = input.cutoff !== undefined;
  return one<ExposureRow>(
    em,
    `update "exposure"
        set "state" = ?,
            "cutoff" = case when ? then ?::timestamptz else "cutoff" end,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.state,
      hasCutoff,
      hasCutoff ? input.cutoff : null,
      input.exposureId,
      input.tenantId,
      input.propertyId,
    ] as never[],
  );
}

export async function releaseExposureAllocations(
  em: EntityManager,
  exposureId: string,
): Promise<number> {
  const released = await rows<{ id: string }>(
    em,
    `update "exposure_allocation"
        set "state" = 'RELEASED', "updated_at" = now()
      where "exposure_id" = ? and "state" = 'RESERVED'
      returning "id"`,
    [exposureId],
  );
  return released.length;
}

export async function insertExposurePreview(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
    productId: string;
    startDate: string;
    endDate: string;
    mode: 'WHOLE' | 'PARTS';
    resourceIds: string[];
    inventoryVersion: number;
    previewVersion: number;
    allowed: boolean;
    reasonCodes: string[];
    expiresAt: string;
  },
): Promise<ExposurePreviewRow> {
  const row = await one<ExposurePreviewRow>(
    em,
    `insert into "exposure_preview"
       ("id", "tenant_id", "property_id", "connection_id", "product_id",
        "start_date", "end_date", "mode", "resource_ids", "inventory_version",
        "preview_version", "allowed", "reason_codes", "expires_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.productId,
      input.startDate,
      input.endDate,
      input.mode,
      toJson(input.resourceIds),
      input.inventoryVersion,
      input.previewVersion,
      input.allowed,
      toJson(input.reasonCodes),
      input.expiresAt,
    ],
  );
  if (!row) throw new Error('Exposure preview insert returned no row');
  return row;
}

export async function findExposurePreview(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  previewId: string,
): Promise<ExposurePreviewRow | null> {
  return one<ExposurePreviewRow>(
    em,
    `select * from "exposure_preview"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [previewId, tenantId, propertyId],
  );
}

export async function nextPreviewVersion(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const row = await one<{ next: number }>(
    em,
    `select coalesce(max("preview_version"), 0) + 1 as "next"
       from "exposure_preview"
      where "tenant_id" = ? and "property_id" = ?`,
    [tenantId, propertyId],
  );
  return row?.next ?? 1;
}

export async function insertSaleRestriction(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
    productId: string;
    startDate: string;
    endDate: string;
    reason: string;
  },
): Promise<SaleRestrictionRow> {
  const row = await one<SaleRestrictionRow>(
    em,
    `insert into "sale_restriction"
       ("id", "tenant_id", "property_id", "connection_id", "product_id",
        "start_date", "end_date", "reason")
     values (?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.connectionId,
      input.productId,
      input.startDate,
      input.endDate,
      input.reason,
    ],
  );
  if (!row) throw new Error('Sale restriction insert returned no row');
  return row;
}

export async function findSaleRestriction(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  restrictionId: string,
): Promise<SaleRestrictionRow | null> {
  return one<SaleRestrictionRow>(
    em,
    `select * from "sale_restriction"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [restrictionId, tenantId, propertyId],
  );
}

export async function openSaleRestriction(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    restrictionId: string;
    openedBy: string;
  },
): Promise<SaleRestrictionRow | null> {
  return one<SaleRestrictionRow>(
    em,
    `update "sale_restriction"
        set "state" = 'OPENED', "opened_at" = now(), "opened_by" = ?,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'ACTIVE'
      returning *`,
    [input.openedBy, input.restrictionId, input.tenantId, input.propertyId],
  );
}

export async function listActiveRestrictions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId: string,
  productId: string,
): Promise<SaleRestrictionRow[]> {
  return rows<SaleRestrictionRow>(
    em,
    `select * from "sale_restriction"
      where "tenant_id" = ? and "property_id" = ?
        and "connection_id" = ? and "product_id" = ? and "state" = 'ACTIVE'
      order by "start_date"`,
    [tenantId, propertyId, connectionId, productId],
  );
}

export async function countPendingExposureEvents(
  em: EntityManager,
  connectionId: string,
  exposureId: string,
): Promise<{
  pending: number;
  accepted: number;
  unknown: number;
  failed: number;
}> {
  const row = await one<{
    pending: number;
    accepted: number;
    unknown: number;
    failed: number;
  }>(
    em,
    `select
       count(*) filter (where "status" in ('PENDING', 'RETRY_SCHEDULED', 'LEASED'))::int as "pending",
       count(*) filter (where "status" in ('SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED'))::int as "accepted",
       count(*) filter (where "status" = 'UNKNOWN')::int as "unknown",
       count(*) filter (where "status" = 'DEAD_LETTER')::int as "failed"
     from "distribution_outbox_event"
     where "connection_id" = ? and "aggregate_type" = 'Exposure'
       and "aggregate_id" = ?`,
    [connectionId, exposureId],
  );
  if (!row) throw new Error('Exposure event summary returned no row');
  return row;
}
