import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { PropertyError } from '../../property/domain/errors.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import { enqueueOutbox } from '../../distribution/persistence/outbox-repository.js';
import {
  assertReservationAriPolicy,
  deriveReservationAriCells,
} from '../domain/reservation-ari-policy.js';
import type { ReservationAriPolicy, ReservationAriFact } from '../domain/reservation-ari-policy.js';
import {
  countActiveCompositions,
  listCandidateResources,
  listCompositionCoverage,
  listSearchResources,
} from '../persistence/availability-repository.js';
import { listOccupancyConflicts } from '../persistence/guarantee-repository.js';

export interface ReservationAriMutation {
  tenantId: string;
  propertyId: string;
  reservationId: string;
  reservationVersion: number;
  inventoryVersion: number;
  operation: 'CONFIRM' | 'MODIFY' | 'CANCEL';
  affected: readonly { productId: string | null; arrival: string; departure: string }[];
}

export type ReservationAriTransactionHook = (
  em: EntityManager,
  mutation: ReservationAriMutation,
) => Promise<void>;

function drift(): never {
  throw new PropertyError('STALE_VERSION', { reason: 'reservation_ari_binding_drift' });
}

/** Caller owns the existing reservation transaction and property lock. */
export function createReservationAriLocalHook(input: ReservationAriPolicy): ReservationAriTransactionHook {
  assertReservationAriPolicy(input);
  // Snapshot the supplied pins so subsequent caller mutation cannot widen scope.
  const policy: ReservationAriPolicy = structuredClone(input);
  return async (em, mutation) => {
    if (mutation.tenantId !== policy.tenantId || mutation.propertyId !== policy.propertyId) return;
    const selectedProducts = new Set([policy.whole, ...policy.parts].map((binding) => binding.productId));
    if (!mutation.affected.some((period) => period.productId !== null &&
      selectedProducts.has(period.productId) && period.arrival < policy.departure && period.departure > policy.date)) return;
    const database = await one<{ name: string }>(em, 'select current_database() as name');
    if (database?.name !== policy.databaseName) drift();
    const property = await one<{ status: string; inventory_version: number }>(em,
      'select status, inventory_version from property where tenant_id=? and id=? for update',
      [policy.tenantId, policy.propertyId]);
    if (!property || property.inventory_version !== mutation.inventoryVersion) drift();
    const connection = await one<{ channel_key: string }>(em,
      `select channel_key from distribution_connection
       where id=? and tenant_id=? and property_id=? and version=?
         and status=? and external_property_id=? for share`,
      [policy.connectionId, policy.tenantId, policy.propertyId,
        policy.connectionVersion, policy.connectionStatus, policy.externalPropertyId]);
    if (!connection) drift();
    const facts: ReservationAriFact[] = [];
    for (const binding of [policy.whole, ...policy.parts]) {
      const mapping = await one<{ id: string }>(em,
        `select id from distribution_mapping_version where id=? and connection_id=?
          and channel_key=? and internal_product_ref=? and mapping_version=?
          and status=? and external_room_ref=? and external_rate_ref=? for share`,
        [binding.mappingId, policy.connectionId, connection.channel_key, binding.productId,
          binding.mappingVersion, binding.mappingStatus, binding.externalRoomRef, binding.externalRateRef]);
      if (!mapping) drift();
      const product = await findProduct(em, policy.tenantId, policy.propertyId, binding.productId);
      if (!product) drift();
      const compositionCount = await countActiveCompositions(em, policy.tenantId, policy.propertyId, binding.productId);
      const coverage = compositionCount > 0
        ? await listCompositionCoverage(em, policy.tenantId, policy.propertyId, binding.productId, policy.date, policy.departure)
        : await listCandidateResources(em, policy.tenantId, policy.propertyId, binding.productId, policy.date, policy.departure);
      const actualIds = [...new Set(coverage.map((row) => row.resource_id))].sort();
      if (actualIds.join(',') !== [...binding.resourceIds].sort().join(',') ||
          (binding.productId === policy.whole.productId && (compositionCount !== 1 ||
            coverage.some((row) => !('version_id' in row) || row.version_id !== policy.compositionVersionId))) ||
          (binding.productId !== policy.whole.productId && compositionCount !== 0)) drift();
      // Every pin is a physical atom. Candidate links alone can otherwise point to a container.
      const children = await rows(em,
        `select id from resource where tenant_id=? and property_id=?
         and parent_resource_id=any(string_to_array(?, ',')::uuid[])`,
        [policy.tenantId, policy.propertyId, actualIds.join(',')]);
      if (children.length > 0) drift();
      const resources = await listSearchResources(em, policy.tenantId, policy.propertyId, actualIds);
      const reasons = new Set<string>();
      if (property.status !== 'ACTIVE') reasons.add('PROPERTY_NOT_ACTIVE');
      if (product.status !== 'ACTIVE') reasons.add('PRODUCT_NOT_ACTIVE');
      if (resources.length !== actualIds.length) reasons.add('CANONICAL_EVIDENCE_UNKNOWN');
      if (resources.some((resource) => resource.state !== 'ACTIVE' || resource.maintenance_state !== 'NONE'))
        reasons.add('RESOURCE_NOT_READY');
      const conflicts = await listOccupancyConflicts(em, {
        tenantId: policy.tenantId, propertyId: policy.propertyId,
        resourceIds: actualIds, arrival: policy.date, departure: policy.departure,
      });
      for (const conflict of conflicts)
        reasons.add(conflict.kind === 'EXPOSURE' ? 'EXPOSURE_PROTECTED' : conflict.kind === 'BLOCK' ? 'BLOCKED' : 'COMMITTED');
      // Also protect unresolved exposure headers even if their allocation rows are absent/released.
      // All four overlapping representations are checked across ALL connections (D-20).
      const exposures = await rows(em,
        `select id from exposure where tenant_id=? and property_id=?
         and state not in ('DRAFT', 'RELEASED')
         and daterange(start_date,end_date,'[)') && daterange(?::date,?::date,'[)')
         and (product_id=any(string_to_array(?, ',')::uuid[]) or exists (
           select 1 from exposure_allocation a where a.exposure_id=exposure.id
           and a.tenant_id=exposure.tenant_id and a.property_id=exposure.property_id
           and a.resource_id=any(string_to_array(?, ',')::uuid[])))`,
        [policy.tenantId, policy.propertyId, policy.date, policy.departure,
          [policy.whole, ...policy.parts].map((entry) => entry.productId).join(','), actualIds.join(',')]);
      if (exposures.length > 0) reasons.add('EXPOSURE_PROTECTED');
      // A stop on either representation protects intersecting atoms, including another connection.
      const related = [policy.whole, ...policy.parts].filter((entry) => entry.resourceIds.some((id) => actualIds.includes(id)));
      const restrictions = await rows(em,
        `select id from sale_restriction where tenant_id=? and property_id=?
         and product_id=any(string_to_array(?, ',')::uuid[]) and state='ACTIVE'
         and daterange(start_date,end_date,'[)') && daterange(?::date,?::date,'[)')`,
        [policy.tenantId, policy.propertyId, related.map((entry) => entry.productId).join(','), policy.date, policy.departure]);
      if (restrictions.length > 0) reasons.add('STOP_SELL_RETAINED');
      facts.push({ productId: binding.productId, reasonCodes: [...reasons] });
    }
    // Always recompute the ENTIRE finite night, covering both old and new modify periods.
    const canonical = deriveReservationAriCells(policy, facts, mutation.inventoryVersion);
    const queued = await enqueueOutbox(em, {
      tenantId: policy.tenantId, propertyId: policy.propertyId, connectionId: policy.connectionId,
      channelKey: connection.channel_key, aggregateType: 'ReservationAriLocal',
      aggregateId: mutation.reservationId, eventType: 'ReservationAriLocalSnapshot',
      eventVersion: mutation.reservationVersion, inventoryVersion: mutation.inventoryVersion,
      payloadSafe: { schema_version: 1, local_only: true, mode: policy.mode,
        operation: mutation.operation, canonical_ari: canonical },
    });
    // CANCELLED parks local evidence. It does not describe reservation or provider state.
    await em.execute(`update distribution_outbox_event set status='CANCELLED',
      last_safe_error_code='LOCAL_EVIDENCE_ONLY' where id=? and status='PENDING'`, [queued.row.id] as never[]);
  };
}
