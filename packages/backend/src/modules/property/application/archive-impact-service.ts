import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { one } from '../../../persistence/sql.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { PropertyError } from '../domain/errors.js';
import { assertPropertyConfigurable } from '../domain/lifecycle.js';
import { findLocation } from '../persistence/location-repository.js';
import { findResource } from '../persistence/resource-repository.js';
import { lockProperty } from '../persistence/property-repository.js';
import { authorize, type ServiceContext } from './context.js';

export type ArchiveBlocker =
  | 'LOCATION_CHILDREN'
  | 'LOCATION_RESOURCES'
  | 'RESOURCE_CHILDREN'
  | 'LIVE_COMMITMENTS'
  | 'OPEN_STAYS'
  | 'CHANNEL_EXPOSURES'
  | 'ALREADY_ARCHIVED';

export interface ArchiveImpact {
  entity_kind: 'LOCATION' | 'RESOURCE';
  entity_id: string;
  version: number;
  status: string;
  eligible: boolean;
  blockers: ArchiveBlocker[];
  counts: {
    children: number;
    resources: number;
    products: number;
    compositions: number;
    pool_memberships: number;
    allocations: number;
    live_commitments: number;
    stays: number;
    open_stays: number;
    exposures: number;
    channel_exposures: number;
  };
}

/** Counts only: no guest names, booking IDs or financial rows leave this read.
 * The caller holds the property lock, also used by all related API writers.
 */
export async function locationArchiveImpact(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  locationId: string,
): Promise<ArchiveImpact> {
  const location = await findLocation(em, tenantId, propertyId, locationId);
  if (!location) throw new PropertyError('NOT_FOUND');
  const counts = await one<{ children: number; resources: number }>(
    em,
    `select
      (select count(*)::int from location where tenant_id=? and property_id=? and parent_id=?) as children,
      (select count(*)::int from resource where tenant_id=? and property_id=? and location_id=?) as resources`,
    [tenantId, propertyId, locationId, tenantId, propertyId, locationId],
  );
  const blockers: ArchiveBlocker[] = [];
  if (counts!.children) blockers.push('LOCATION_CHILDREN');
  if (counts!.resources) blockers.push('LOCATION_RESOURCES');
  if (location.status !== 'ACTIVE') blockers.push('ALREADY_ARCHIVED');
  return {
    entity_kind: 'LOCATION',
    entity_id: location.id,
    version: Number(location.version),
    status: location.status,
    eligible: blockers.length === 0,
    blockers,
    counts: {
      ...counts!,
      products: 0,
      compositions: 0,
      pool_memberships: 0,
      allocations: 0,
      live_commitments: 0,
      stays: 0,
      open_stays: 0,
      exposures: 0,
      channel_exposures: 0,
    },
  };
}

export async function resourceArchiveImpact(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
  today: string,
): Promise<ArchiveImpact> {
  const resource = await findResource(em, tenantId, propertyId, resourceId);
  if (!resource) throw new PropertyError('NOT_FOUND');
  const counts = await one<ArchiveImpact['counts']>(
    em,
    `with target as (select ?::uuid as tenant_id, ?::uuid as property_id, ?::uuid as id),
      allocations as (
        select a.*, c.state as commitment_state, c.expires_at from plan_allocation a
        join commitment c on c.id=a.commitment_id and c.tenant_id=a.tenant_id and c.property_id=a.property_id
        join target t on t.tenant_id=a.tenant_id and t.property_id=a.property_id and t.id=a.resource_id
      ), assignments as (
        select a.* from room_assignment a join target t
          on t.tenant_id=a.tenant_id and t.property_id=a.property_id and t.id=a.resource_id
      ), quotas as (
        select a.*, e.state as exposure_state from exposure_allocation a
        join exposure e on e.id=a.exposure_id and e.tenant_id=a.tenant_id and e.property_id=a.property_id
        join target t on t.tenant_id=a.tenant_id and t.property_id=a.property_id and t.id=a.resource_id
      ) select
        (select count(*)::int from resource r join target t on t.tenant_id=r.tenant_id and t.property_id=r.property_id and t.id=r.parent_resource_id) as children,
        0::int as resources,
        (select count(distinct c.product_id)::int from product_resource_candidate c join target t on t.tenant_id=c.tenant_id and t.property_id=c.property_id and t.id=c.resource_id) as products,
        (select count(*)::int from composition_leaf l join target t on t.tenant_id=l.tenant_id and t.property_id=l.property_id and t.id=l.resource_id) as compositions,
        (select count(*)::int from pool_member m join target t on t.tenant_id=m.tenant_id and t.property_id=m.property_id and t.id=m.resource_id) as pool_memberships,
        (select count(*)::int from allocations) as allocations,
        (select count(distinct commitment_id)::int from allocations where state='ACTIVE' and commitment_state='ACTIVE' and (expires_at is null or expires_at>now()) and end_date>?::date) as live_commitments,
        (select count(*)::int from assignments) as stays,
        (select count(*)::int from assignments where state='ACTIVE' or (state='PLANNED' and end_date>?::date)) as open_stays,
        (select count(distinct exposure_id)::int from quotas) as exposures,
        (select count(distinct exposure_id)::int from quotas where state='RESERVED' or exposure_state not in ('DRAFT','RELEASED')) as channel_exposures`,
    [tenantId, propertyId, resourceId, today, today],
  );
  const blockers: ArchiveBlocker[] = [];
  if (counts!.children) blockers.push('RESOURCE_CHILDREN');
  if (counts!.live_commitments) blockers.push('LIVE_COMMITMENTS');
  if (counts!.open_stays) blockers.push('OPEN_STAYS');
  if (counts!.channel_exposures) blockers.push('CHANNEL_EXPOSURES');
  if (resource.state === 'RETIRED') blockers.push('ALREADY_ARCHIVED');
  return {
    entity_kind: 'RESOURCE',
    entity_id: resource.id,
    version: Number(resource.version),
    status: resource.state,
    eligible: blockers.length === 0,
    blockers,
    counts: counts!,
  };
}

export async function previewArchiveImpact(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  kind: 'LOCATION' | 'RESOURCE',
  id: string,
): Promise<ArchiveImpact> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      return kind === 'LOCATION'
        ? locationArchiveImpact(em, context.tenantId, propertyId, id)
        : resourceArchiveImpact(
            em,
            context.tenantId,
            propertyId,
            id,
            businessToday(property.timezone),
          );
    },
  );
}
