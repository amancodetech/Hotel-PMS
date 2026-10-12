import type {
  CommitmentRow,
  ExposureAllocationRow,
  ExposureRow,
  InventoryBlockRow,
  InventoryDisruptionRow,
  NightlyPriceRow,
  PlanAllocationRow,
  PriceQuoteRow,
  RatePlanRow,
} from '@hotel/backend';

export function ratePlanDto(row: RatePlanRow) {
  return {
    id: row.id,
    version: row.version,
    code: row.code,
    name: row.name,
    product_id: row.product_id,
    currency: row.currency,
    occupancy_basis: row.occupancy_basis,
    meal_plan: row.meal_plan,
    inclusions: row.inclusions,
    cancellation_policy: row.cancellation_policy,
    free_policy: row.free_policy,
    status: row.status,
    policy_version: row.policy_version,
  };
}

function canonicalAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export function nightlyPriceDto(row: NightlyPriceRow) {
  return {
    id: row.id,
    version: row.version,
    rate_plan_id: row.rate_plan_id,
    policy_version_id: row.policy_version_id,
    date: row.stay_date,
    occupancy: row.occupancy,
    money: {
      amount: canonicalAmount(row.amount),
      currency: row.currency,
    },
  };
}

export function priceQuoteDto(row: PriceQuoteRow) {
  return {
    id: row.id,
    product_id: row.product_id,
    rate_plan_id: row.rate_plan_id,
    policy_version_id: row.policy_version_id,
    currency: row.currency,
    start_date: row.start_date,
    end_date: row.end_date,
    quantity: row.quantity,
    adults: row.adults,
    child_ages: row.child_ages,
    total_money: {
      amount: canonicalAmount(row.total_amount),
      currency: row.currency,
    },
    cells: row.cells,
    inventory_version: row.inventory_version,
    expires_at: row.expires_at,
  };
}

export function allocationDto(row: PlanAllocationRow) {
  return {
    id: row.id,
    resource_id: row.resource_id,
    start_date: row.start_date,
    end_date: row.end_date,
    state: row.state,
  };
}

export function holdDto(row: CommitmentRow, allocations: PlanAllocationRow[]) {
  return {
    id: row.id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    state: row.state,
    expires_at: row.expires_at,
    inventory_version: row.inventory_version,
    version: row.version,
    allocations: allocations.map(allocationDto),
  };
}

export function blockDto(row: InventoryBlockRow, resourceIds: string[]) {
  return {
    id: row.id,
    mode: row.mode,
    reason: row.reason,
    state: row.state,
    start_date: row.start_date,
    end_date: row.end_date,
    resource_ids: resourceIds,
    version: row.version,
  };
}

export function disruptionDto(row: InventoryDisruptionRow) {
  return {
    id: row.id,
    block_id: row.block_id,
    allocation_id: row.allocation_id,
    resource_id: row.resource_id,
    start_date: row.start_date,
    end_date: row.end_date,
    state: row.state,
    note: row.note,
  };
}

export function exposureAllocationDto(row: ExposureAllocationRow) {
  return {
    id: row.id,
    resource_id: row.resource_id,
    start_date: row.start_date,
    end_date: row.end_date,
    state: row.state,
  };
}

export function exposureDto(
  row: ExposureRow & { allocations?: ExposureAllocationRow[] },
) {
  return {
    id: row.id,
    connection_id: row.connection_id,
    product_id: row.product_id,
    start_date: row.start_date,
    end_date: row.end_date,
    mode: row.mode,
    state: row.state,
    epoch: row.epoch,
    inventory_version: row.inventory_version,
    preview_version: row.preview_version,
    cutoff: row.cutoff,
    version: row.version,
    allocations: (row.allocations ?? []).map(exposureAllocationDto),
  };
}
