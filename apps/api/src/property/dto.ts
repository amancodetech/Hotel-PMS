import type {
  CapabilityRow,
  CommitmentCoverageGapRow,
  CompositionEdgeRow,
  CompositionLeafRow,
  CompositionLeafView,
  CompositionSummaryRow,
  CompositionVersionRow,
  CompositionWindowRow,
  ConnectionRow,
  InventoryPoolRow,
  LocationRow,
  MappingRow,
  MigrationCounts,
  PoolMemberRow,
  ProductCandidateRow,
  ProductRow,
  PropertyGroupRow,
  PropertyViewRow,
  ResourceAllocationRow,
  ResourceBlockRow,
  ResourceRow,
  ResourceTypeRow,
  SetupChangeEventRow,
  SharedResourceRow,
} from '@hotel/backend';

export function propertyGroupDto(row: PropertyGroupRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    status: row.status,
  };
}

export function propertyDto(row: PropertyViewRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    group_id: row.group_id,
    timezone: row.timezone,
    base_currency: row.base_currency,
    status: row.status,
    inventory_version: row.inventory_version,
    limits_profile_code: row.limits_profile_code,
  };
}

export function resourceTypeDto(row: ResourceTypeRow) {
  return {
    code: row.code,
    name_key: row.name_key,
  };
}

export function locationDto(row: LocationRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    status: row.status,
    parent_id: row.parent_id,
    kind: row.kind,
    display_order: row.display_order,
  };
}

export function resourceDto(row: ResourceRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    type: row.resource_type,
    capacity: row.capacity,
    state: row.state,
    housekeeping_state: row.housekeeping_state,
    maintenance_state: row.maintenance_state,
    location_id: row.location_id,
    parent_resource_id: row.parent_resource_id,
    display_label: row.display_label,
    unit_details: row.unit_details,
  };
}

export function productDto(row: ProductRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    kind: row.kind,
    occupancy_adults_min: row.occupancy_adults_min,
    occupancy_adults_max: row.occupancy_adults_max,
    occupancy_children_max: row.occupancy_children_max,
    meal_plan: row.meal_plan,
    sharing_scope: row.sharing_scope,
    pool_id: row.pool_id,
    status: row.status,
  };
}

export function productCandidateDto(row: ProductCandidateRow) {
  return {
    product_id: row.product_id,
    resource_id: row.resource_id,
    resource_type: row.resource_type,
    created_at: row.created_at,
  };
}

export function poolDto(row: InventoryPoolRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    resource_type: row.resource_type,
    status: row.status,
  };
}

export function poolMemberDto(row: PoolMemberRow) {
  return {
    pool_id: row.pool_id,
    resource_id: row.resource_id,
    resource_type: row.resource_type,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

export function compositionDto(row: CompositionVersionRow) {
  return {
    id: row.id,
    product_id: row.product_id,
    version_number: row.version_number,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    status: row.status,
    version: row.version,
  };
}

export function compositionEdgeDto(row: CompositionEdgeRow) {
  return {
    position: row.position,
    child_kind: row.child_kind,
    resource_id: row.resource_id,
    version_id: row.child_version_id,
  };
}

export function compositionLeafDto(row: CompositionLeafRow) {
  return {
    resource_id: row.resource_id,
    depth: row.depth,
  };
}

export function connectionDto(row: ConnectionRow) {
  return {
    id: row.id,
    provider_key: row.provider_key,
    environment: row.environment,
    channel_key: row.channel_key,
    external_property_id: row.external_property_id,
    status: row.status,
    secret_ref_set: row.secret_ref.length > 0,
    version: row.version,
  };
}

export function mappingDto(row: MappingRow) {
  return {
    id: row.id,
    channel_key: row.channel_key,
    external_room_ref: row.external_room_ref,
    external_rate_ref: row.external_rate_ref,
    occupancy: row.occupancy,
    meal_plan_ref: row.meal_plan_ref,
    internal_product_ref: row.internal_product_ref,
    internal_rate_ref: row.internal_rate_ref,
    effective_at: row.effective_at,
    status: row.status,
    mapping_version: row.mapping_version,
  };
}

export function capabilityDto(row: CapabilityRow) {
  return {
    channel_key: row.channel_key,
    capability_code: row.capability_code,
    status: row.status,
    authorization_status: row.authorization_status,
    adapter_version: row.adapter_version,
    checked_at: row.checked_at,
    limitations: row.limitations,
  };
}

export function compositionLeafViewDto(row: CompositionLeafView) {
  return {
    resource_id: row.resource_id,
    code: row.code,
    resource_type: row.resource_type,
  };
}

export function resourceAllocationDto(row: ResourceAllocationRow) {
  return {
    commitment_id: row.commitment_id,
    source_kind: row.source_kind,
    resource_id: row.resource_id,
    resource_code: row.resource_code,
    start_date: row.start_date,
    end_date: row.end_date,
    product_id: row.product_id,
    expires_at: row.expires_at,
  };
}

export function resourceBlockDto(row: ResourceBlockRow) {
  return {
    block_id: row.block_id,
    resource_id: row.resource_id,
    resource_code: row.resource_code,
    mode: row.mode,
    start_date: row.start_date,
    end_date: row.end_date,
  };
}

export function compositionWindowDto(row: CompositionWindowRow) {
  return {
    composition_id: row.id,
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name,
    version_number: row.version_number,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    status: row.status,
  };
}

export function setupChangeEventDto(row: SetupChangeEventRow) {
  return {
    id: row.id,
    property_id: row.property_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_label: row.actor_label,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    outcome: row.outcome,
    before_safe: row.before_safe,
    after_safe: row.after_safe,
    reason: row.reason,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
  };
}

export function compositionSummaryDto(row: CompositionSummaryRow) {
  return {
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name,
    status: row.status,
    active_versions: row.active_versions,
    leaf_count: row.leaf_count,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

export function sharedResourceDto(row: SharedResourceRow) {
  return {
    resource_id: row.resource_id,
    resource_code: row.resource_code,
    product_count: row.product_count,
    product_codes: row.product_codes,
  };
}

export function coverageGapDto(row: CommitmentCoverageGapRow) {
  return {
    commitment_id: row.commitment_id,
    source_kind: row.source_kind,
    resource_id: row.resource_id,
    resource_code: row.resource_code,
    product_id: row.product_id,
    product_code: row.product_code,
    start_date: row.start_date,
    end_date: row.end_date,
  };
}

export function migrationCountsDto(row: MigrationCounts) {
  return {
    resources: row.resources,
    future_commitments: row.future_commitments,
    active_compositions: row.active_compositions,
    product_active_versions: row.product_active_versions,
  };
}
