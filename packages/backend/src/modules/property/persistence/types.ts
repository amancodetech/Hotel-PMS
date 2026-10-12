import type {
  CompositionStatus,
  Currency,
  HousekeepingState,
  LocationStatus,
  MaintenanceState,
  MealPlan,
  PoolStatus,
  ProductStatus,
  PropertyGroupStatus,
  PropertyStatus,
  ResourceKind,
  ResourceState,
  Timezone,
} from '../domain/lifecycle.js';
import type { VersionedSetupInput } from '../domain/setup-v2.js';

export interface PropertyGroupRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  status: PropertyGroupStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyLimitsProfileRow {
  id: string;
  code: string;
  max_resources: number;
  max_composition_depth: number;
  max_leaves_per_product: number;
  max_items_per_request: number;
  horizon_nights: number;
  max_stay_nights: number;
  search_budget_ms: number;
  lock_wait_ms: number;
  retry_limit: number;
  version: number;
}

export interface PropertyRow {
  id: string;
  tenant_id: string;
  group_id: string | null;
  code: string;
  name: string;
  timezone: Timezone;
  base_currency: Currency;
  status: PropertyStatus;
  limits_profile_id: string;
  inventory_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyViewRow extends PropertyRow {
  limits_profile_code: string;
}

export type LocationKind =
  'ZONE' | 'BUILDING' | 'WING' | 'FLOOR' | 'CLUSTER' | 'SERVICE_AREA';
export interface UnitDetails {
  bedrooms_count?: number;
  bathrooms_count?: number;
  notes?: string;
}

export interface LocationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  code: string;
  name: string;
  parent_id: string | null;
  kind: LocationKind | null;
  display_order: number;
  status: LocationStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ResourceTypeRow {
  code: ResourceKind;
  name_key: string;
  sort_order: number;
}

export interface ResourceRow {
  id: string;
  tenant_id: string;
  property_id: string;
  code: string;
  resource_type: ResourceKind;
  capacity: number;
  location_id: string | null;
  parent_resource_id: string | null;
  display_label: string | null;
  unit_details: UnitDetails;
  state: ResourceState;
  housekeeping_state: HousekeepingState;
  maintenance_state: MaintenanceState;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryPoolRow {
  id: string;
  tenant_id: string;
  property_id: string;
  code: string;
  name: string;
  resource_type: ResourceKind;
  status: PoolStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PoolMemberRow {
  pool_id: string;
  tenant_id: string;
  property_id: string;
  resource_type: ResourceKind;
  resource_id: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductRow {
  id: string;
  tenant_id: string;
  property_id: string;
  code: string;
  name: string;
  kind: ResourceKind;
  occupancy_adults_min: number;
  occupancy_adults_max: number;
  occupancy_children_max: number;
  meal_plan: MealPlan;
  sharing_scope: 'MIXED' | 'FEMALE' | 'MALE' | null;
  setup_unit_code: string | null;
  pool_id: string | null;
  status: ProductStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProductCandidateRow {
  product_id: string;
  tenant_id: string;
  property_id: string;
  resource_type: ResourceKind;
  resource_id: string;
  created_at: string;
}

export interface CompositionVersionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  product_id: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  status: CompositionStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CompositionEdgeRow {
  id: string;
  version_id: string;
  tenant_id: string;
  property_id: string;
  position: number;
  child_kind: 'RESOURCE' | 'COMPOSITION';
  resource_id: string | null;
  child_version_id: string | null;
  created_at: string;
}

export interface CompositionLeafRow {
  version_id: string;
  tenant_id: string;
  property_id: string;
  resource_id: string;
  depth: number;
  created_at: string;
}

export interface CompositionWindowRow {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  status: CompositionStatus;
}

export interface ResourceAllocationRow {
  commitment_id: string;
  source_kind: 'HOLD' | 'ITEM' | 'GROUP';
  resource_id: string;
  resource_code: string;
  start_date: string;
  end_date: string;
  product_id: string | null;
  expires_at: string | null;
}

export interface ResourceBlockRow {
  block_id: string;
  resource_id: string;
  resource_code: string;
  mode: string;
  start_date: string;
  end_date: string;
}

export interface SetupChangeEventRow {
  id: string;
  property_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  before_safe: Record<string, unknown> | null;
  after_safe: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface CompositionSummaryRow {
  product_id: string;
  product_code: string;
  product_name: string;
  status: string;
  active_versions: number;
  leaf_count: number;
  effective_from: string | null;
  effective_to: string | null;
}

export interface SharedResourceRow {
  resource_id: string;
  resource_code: string;
  product_count: number;
  product_codes: string;
}

export interface CommitmentCoverageGapRow {
  commitment_id: string;
  source_kind: string;
  resource_id: string;
  resource_code: string;
  product_id: string;
  product_code: string;
  start_date: string;
  end_date: string;
}

export interface PropertySetupDraftRow {
  id: string;
  tenant_id: string;
  property_id: string;
  revision: number;
  input: VersionedSetupInput;
  completed: boolean;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertySetupLimitsRow {
  max_resources: number;
  max_setup_units_inline: number;
  horizon_nights: number;
  inventory_version: number;
}
