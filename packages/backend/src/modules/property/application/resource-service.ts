import {
  searchResourcePage,
  type ResourceSearchOptions,
} from './resource-search.js';
import {
  assertActiveLocation,
  assertLocationMove,
} from './location-tree-service.js';
import {
  locationArchiveImpact,
  resourceArchiveImpact,
} from './archive-impact-service.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  assertCapacity,
  assertCode,
  assertLocationTransition,
  assertName,
  assertPropertyConfigurable,
  assertResourceMutable,
  assertResourceTransition,
  isLocationStatus,
  isResourceKind,
  isResourceState,
  type LocationStatus,
  type ResourceKind,
  type ResourceState,
} from '../domain/lifecycle.js';
import {
  findLocation,
  insertLocation,
  listLocations,
  updateLocation,
} from '../persistence/location-repository.js';
import {
  findResource,
  lockResource,
  listChildResources,
  insertResource,
  listResources,
  updateResource,
  updateResourceMaintenance,
} from '../persistence/resource-repository.js';
import {
  bumpPropertyInventoryVersion,
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type {
  LocationRow,
  ResourceRow,
  LocationKind,
  UnitDetails,
} from '../persistence/types.js';

export interface LocationInput {
  parent_id?: string | null;
  kind?: LocationKind | null;
  display_order?: number;
  code: string;
  name: string;
}

export interface LocationPatch {
  parent_id?: string | null;
  kind?: LocationKind | null;
  display_order?: number;
  version: number;
  name?: string;
  status?: LocationStatus;
}

export async function readLocations(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<LocationRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return listLocations(em, context.tenantId, propertyId);
    },
  );
}

export async function createLocation(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: LocationInput,
  idempotencyKey?: string,
): Promise<LocationRow> {
  const code = assertCode(input.code);
  const name = assertName(input.name);
  const treeMode =
    input.parent_id !== undefined ||
    input.kind !== undefined ||
    input.display_order !== undefined;
  const key = treeMode ? requireIdempotencyKey(idempotencyKey) : null;
  const requestHash = hashRequest({
    propertyId,
    code,
    name,
    parent_id: input.parent_id ?? null,
    kind: input.kind ?? null,
    display_order: input.display_order ?? 0,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const replay = await checkIdempotency(
        em,
        context,
        'CreateTreeLocation',
        key,
        requestHash,
        propertyId,
      );
      if (replay) return replay.location as unknown as LocationRow;
      await assertLocationMove(
        em,
        context.tenantId,
        propertyId,
        null,
        input.parent_id ?? null,
      );
      const location = await translatePropertyWrite(() =>
        insertLocation(em, {
          tenantId: context.tenantId,
          propertyId,
          code,
          name,
          parent_id: input.parent_id,
          kind: input.kind,
          display_order: input.display_order,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'location.created',
        resourceType: 'Location',
        resourceId: location.id,
        outcome: 'SUCCESS',
        afterSafe: {
          code: location.code,
          name: location.name,
          status: location.status,
        },
        correlationId: context.correlationId,
      });
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CreateTreeLocation',
        key,
        requestHash,
        response: { location },
        resourceId: location.id,
      });
      return location;
    },
  );
}

export async function updateLocationById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  locationId: string,
  patch: LocationPatch,
): Promise<LocationRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.status !== undefined && !isLocationStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findLocation(
        em,
        context.tenantId,
        propertyId,
        locationId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      if (patch.status !== undefined)
        assertLocationTransition(current.status, patch.status);
      if (current.version !== patch.version)
        throw new PropertyError('STALE_VERSION');
      if (patch.status === 'INACTIVE' && current.status === 'ACTIVE') {
        const impact = await locationArchiveImpact(
          em,
          context.tenantId,
          propertyId,
          locationId,
        );
        if (!impact.eligible)
          throw new PropertyError('LOCATION_IN_USE', {
            blockers: impact.blockers,
            counts: impact.counts,
          });
      }
      if (patch.parent_id !== undefined)
        await assertLocationMove(
          em,
          context.tenantId,
          propertyId,
          locationId,
          patch.parent_id,
        );
      const updated = await translatePropertyWrite(() =>
        updateLocation(em, {
          tenantId: context.tenantId,
          propertyId,
          locationId,
          version: patch.version,
          name,
          status: patch.status,
          parent_id: patch.parent_id,
          kind: patch.kind,
          display_order: patch.display_order,
        }),
      );
      if (!updated) throw new PropertyError('STALE_VERSION');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'location.updated',
        resourceType: 'Location',
        resourceId: locationId,
        outcome: 'SUCCESS',
        beforeSafe: {
          name: current.name,
          status: current.status,
          parent_id: current.parent_id,
          kind: current.kind,
          display_order: current.display_order,
        },
        afterSafe: {
          name: updated.name,
          status: updated.status,
          parent_id: updated.parent_id,
          kind: updated.kind,
          display_order: updated.display_order,
        },
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export interface ResourceInput {
  parentResourceId?: string | null;
  display_label?: string | null;
  unit_details?: UnitDetails;
  code: string;
  type: ResourceKind;
  capacity: number;
  locationId: string | null;
}

export interface ResourcePatch {
  display_label?: string | null;
  unit_details?: UnitDetails;
  version: number;
  capacity?: number;
  locationId?: string | null;
  state?: ResourceState;
}

export interface ResourcePage {
  items: ResourceRow[];
  next_cursor: string | null;
}

export async function readResources(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  options: ResourceSearchOptions & { limit?: number; cursor?: string | null },
): Promise<ResourcePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      if (
        options.q !== undefined ||
        options.sort !== undefined ||
        options.type !== undefined ||
        options.min_capacity !== undefined ||
        options.bedrooms_count !== undefined ||
        options.bathrooms_count !== undefined ||
        options.cursor?.startsWith('v2.')
      )
        return searchResourcePage(em, context.tenantId, propertyId, {
          ...options,
          limit,
        });
      const items = await listResources(em, context.tenantId, propertyId, {
        limit,
        cursor: options.cursor ?? null,
      });
      const last = items.at(-1);
      const next_cursor =
        items.length === limit && last ? `${last.created_at}|${last.id}` : null;
      return { items, next_cursor };
    },
  );
}

async function assertLocationInProperty(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  locationId: string,
): Promise<void> {
  await assertActiveLocation(em, context.tenantId, propertyId, locationId);
}

function resourceAudit(resource: ResourceRow): Record<string, unknown> {
  return {
    code: resource.code,
    type: resource.resource_type,
    capacity: resource.capacity,
    location_id: resource.location_id,
    parent_resource_id: resource.parent_resource_id,
    display_label: resource.display_label,
    unit_details: resource.unit_details,
    state: resource.state,
    version: resource.version,
  };
}

export async function createResource(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ResourceInput,
  idempotencyKey?: string,
): Promise<ResourceRow> {
  const code = assertCode(input.code, 80);
  if (!isResourceKind(input.type))
    throw new PropertyError('INVALID_REQUEST', { field: 'type' });
  assertCapacity(input.capacity);
  const parentId = input.parentResourceId ?? null;
  const key = parentId ? requireIdempotencyKey(idempotencyKey) : null;
  const requestHash = hashRequest({
    propertyId,
    code,
    type: input.type,
    capacity: input.capacity,
    location_id: input.locationId,
    parent_resource_id: parentId,
    display_label: input.display_label ?? null,
    unit_details: input.unit_details ?? {},
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      if (parentId) {
        const replay = await checkIdempotency(
          em,
          context,
          'CreateResourceChild',
          key,
          requestHash,
          propertyId,
        );
        if (replay) return replay.resource as unknown as ResourceRow;
        if (input.type !== 'ROOM')
          throw new PropertyError('INVALID_REQUEST', { field: 'type' });
        const parent = await lockResource(
          em,
          context.tenantId,
          propertyId,
          parentId,
        );
        if (!parent) throw new PropertyError('NOT_FOUND');
        if (parent.state !== 'ACTIVE')
          throw new PropertyError('INVALID_STATE_TRANSITION');
        if (parent.resource_type !== 'VILLA')
          throw new PropertyError('INVALID_REQUEST', {
            field: 'parent_resource_id',
          });
        const children = await listChildResources(
          em,
          context.tenantId,
          propertyId,
          parent.id,
        );
        if (!children.some((child) => child.resource_type === 'ROOM'))
          throw new PropertyError('INVENTORY_TRANSFORMATION_REQUIRED', {
            resource_id: parent.id,
          });
      }
      if (input.locationId)
        await assertLocationInProperty(
          em,
          context,
          propertyId,
          input.locationId,
        );
      const resource = await translatePropertyWrite(() =>
        insertResource(em, {
          tenantId: context.tenantId,
          propertyId,
          code,
          resourceType: input.type,
          capacity: input.capacity,
          locationId: input.locationId,
          parentResourceId: parentId,
          display_label: input.display_label,
          unit_details: input.unit_details,
        }),
      );
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'resource.created',
        resourceType: 'Resource',
        resourceId: resource.id,
        outcome: 'SUCCESS',
        afterSafe: resourceAudit(resource),
        correlationId: context.correlationId,
      });
      if (parentId)
        await storeIdempotency(em, context, {
          propertyId,
          operation: 'CreateResourceChild',
          key,
          requestHash,
          response: { resource },
          resourceId: resource.id,
        });
      return resource;
    },
  );
}

export async function setResourceMaintenanceState(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  resourceId: string,
  input: { version: number; state: 'NONE' | 'OOO' | 'OOS'; reason: string },
): Promise<ResourceRow> {
  if (input.state !== 'NONE' && input.state !== 'OOO' && input.state !== 'OOS')
    throw new PropertyError('INVALID_REQUEST', { field: 'maintenance_state' });
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1000)
    throw new PropertyError('INVALID_REQUEST', { field: 'reason' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      if (input.state !== 'NONE')
        await authorize(em, context, 'maintenance.emergency', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findResource(
        em,
        context.tenantId,
        propertyId,
        resourceId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      assertResourceMutable(current.state);
      if (current.maintenance_state === input.state) return current;
      const updated = await translatePropertyWrite(() =>
        updateResourceMaintenance(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceId,
          version: input.version,
          maintenanceState: input.state,
        }),
      );
      if (!updated) throw new PropertyError('STALE_VERSION');
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'resource.maintenance_changed',
        resourceType: 'Resource',
        resourceId,
        outcome: 'SUCCESS',
        beforeSafe: { maintenance_state: current.maintenance_state },
        afterSafe: { maintenance_state: updated.maintenance_state, reason },
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function updateResourceById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  resourceId: string,
  patch: ResourcePatch,
): Promise<ResourceRow> {
  if (patch.capacity !== undefined) assertCapacity(patch.capacity);
  if (patch.state !== undefined && !isResourceState(patch.state))
    throw new PropertyError('INVALID_REQUEST', { field: 'state' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findResource(
        em,
        context.tenantId,
        propertyId,
        resourceId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      assertResourceMutable(current.state);
      if (patch.state !== undefined)
        assertResourceTransition(current.state, patch.state);
      if (current.version !== patch.version)
        throw new PropertyError('STALE_VERSION');
      if (
        patch.state !== undefined &&
        patch.state !== 'ACTIVE' &&
        patch.state !== current.state
      ) {
        const impact = await resourceArchiveImpact(
          em,
          context.tenantId,
          propertyId,
          resourceId,
          businessToday(property.timezone),
        );
        if (!impact.eligible)
          throw new PropertyError('RESOURCE_IN_USE', {
            blockers: impact.blockers,
            counts: impact.counts,
          });
      }
      if (patch.locationId !== undefined && patch.locationId !== null)
        await assertLocationInProperty(
          em,
          context,
          propertyId,
          patch.locationId,
        );
      const updated = await translatePropertyWrite(() =>
        updateResource(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceId,
          version: patch.version,
          capacity: patch.capacity,
          locationId: patch.locationId,
          state: patch.state,
          display_label: patch.display_label,
          unit_details: patch.unit_details,
        }),
      );
      if (!updated) throw new PropertyError('STALE_VERSION');
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'resource.updated',
        resourceType: 'Resource',
        resourceId,
        outcome: 'SUCCESS',
        beforeSafe: resourceAudit(current),
        afterSafe: resourceAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}
