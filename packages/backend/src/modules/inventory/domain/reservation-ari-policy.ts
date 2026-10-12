/** Finite local evidence policy. It does not authorize provider publication. */
export interface ReservationAriBinding {
  productId: string;
  resourceIds: readonly string[];
  mappingId: string;
  mappingVersion: number;
  mappingStatus: 'DRAFT' | 'ACTIVE';
  externalRoomRef: string;
  externalRateRef: string;
}

export interface ReservationAriPolicy {
  databaseName: string;
  tenantId: string;
  propertyId: string;
  connectionId: string;
  connectionVersion: number;
  connectionStatus: 'DRAFT' | 'ACTIVE';
  externalPropertyId: string;
  date: string;
  departure: string;
  mode: 'WHOLE' | 'PARTS';
  compositionVersionId: string;
  whole: ReservationAriBinding;
  parts: readonly ReservationAriBinding[];
}

export function assertReservationAriPolicy(policy: ReservationAriPolicy): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bindings = [policy.whole, ...policy.parts];
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !/^(hotel_test_[a-z0-9_]+|hotel_np_operational_trial_\d{8})$/.test(policy.databaseName) ||
    ![policy.tenantId, policy.propertyId, policy.connectionId, policy.compositionVersionId].every((id) => uuid.test(id)) ||
    !Number.isSafeInteger(policy.connectionVersion) || policy.connectionVersion < 1 ||
    !['DRAFT', 'ACTIVE'].includes(policy.connectionStatus) ||
    !policy.externalPropertyId ||
    !['WHOLE', 'PARTS'].includes(policy.mode) ||
    !date.test(policy.date) || !date.test(policy.departure) ||
    !Number.isFinite(Date.parse(`${policy.date}T00:00:00Z`)) ||
    new Date(Date.parse(`${policy.date}T00:00:00Z`)).toISOString().slice(0, 10) !== policy.date ||
    !Number.isFinite(Date.parse(`${policy.departure}T00:00:00Z`)) ||
    new Date(Date.parse(`${policy.departure}T00:00:00Z`)).toISOString().slice(0, 10) !== policy.departure ||
    Date.parse(`${policy.departure}T00:00:00Z`) - Date.parse(`${policy.date}T00:00:00Z`) !== 86_400_000 ||
    policy.parts.length !== 3 || policy.whole.resourceIds.length !== 3 ||
    new Set(bindings.map((binding) => binding.productId)).size !== 4 ||
    new Set(bindings.map((binding) => binding.mappingId)).size !== 4 ||
    new Set(bindings.map((binding) => binding.externalRoomRef)).size !== 4 ||
    bindings.some((binding) =>
      !uuid.test(binding.productId) || !uuid.test(binding.mappingId) ||
      !binding.resourceIds.every((id) => uuid.test(id)) ||
      !Number.isSafeInteger(binding.mappingVersion) || binding.mappingVersion < 1 ||
      !['DRAFT', 'ACTIVE'].includes(binding.mappingStatus) ||
      !binding.externalRoomRef || !binding.externalRateRef) ||
    policy.parts.some((binding) => binding.resourceIds.length !== 1) ||
    new Set(policy.parts.flatMap((binding) => [...binding.resourceIds])).size !== 3 ||
    [...policy.whole.resourceIds].sort().join(',') !== policy.parts.flatMap((binding) => [...binding.resourceIds]).sort().join(',')
  ) throw new Error('RESERVATION_ARI_POLICY_INVALID');
}

export interface ReservationAriFact {
  productId: string;
  /** null means canonical evidence was not established. */
  reasonCodes: readonly string[] | null;
}

export function deriveReservationAriCells(
  policy: ReservationAriPolicy,
  facts: readonly ReservationAriFact[],
  inventoryVersion: number,
) {
  assertReservationAriPolicy(policy);
  if (!Number.isSafeInteger(inventoryVersion) || inventoryVersion < 1)
    throw new Error('RESERVATION_ARI_VERSION_INVALID');
  return [policy.whole, ...policy.parts].map((binding) => {
    const matching = facts.filter((fact) => fact.productId === binding.productId);
    const reasons = new Set<string>();
    const selected = policy.mode === 'WHOLE'
      ? binding.productId === policy.whole.productId
      : binding.productId !== policy.whole.productId;
    if (!selected) reasons.add('MODE_DISABLED');
    if (matching.length !== 1 || matching[0].reasonCodes === null)
      reasons.add('CANONICAL_EVIDENCE_UNKNOWN');
    else for (const reason of matching[0].reasonCodes) reasons.add(reason);
    return {
      product_id: binding.productId,
      date: policy.date,
      available: reasons.size === 0 ? 1 : 0,
      stop_sell: reasons.size !== 0,
      inventory_version: inventoryVersion,
      reason_codes: [...reasons].sort(),
    };
  });
}
