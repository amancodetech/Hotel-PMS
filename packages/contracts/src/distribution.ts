export const DISTRIBUTION_SCHEMA_VERSION = 1 as const;

export const certaintyLevels = [
  'NOT_SENT',
  'PROVIDER_ACCEPTED',
  'CHANNEL_VERIFIED',
  'PARTIAL',
  'UNKNOWN',
  'REJECTED',
] as const;
export type Certainty = (typeof certaintyLevels)[number];

export const revisionTypes = ['new', 'modified', 'cancelled'] as const;
export type RevisionType = (typeof revisionTypes)[number];

export const safeErrorCodes = [
  'VALIDATION_FAILED',
  'AUTH_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'UNSUPPORTED',
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'UNKNOWN',
] as const;
export type SafeErrorCode = (typeof safeErrorCodes)[number];

export const capabilityCodes = [
  'inbound_new',
  'inbound_modified',
  'inbound_cancelled',
  'mapping',
  'absolute_availability',
  'rates',
  'stop_sell_open',
  'recovery',
  'historical_import',
  'd20_exclusive_quota',
  'd20_withdraw_evidence',
  'readback',
  'messaging',
] as const;
export type CapabilityCode = (typeof capabilityCodes)[number];

export const capabilityStatuses = [
  'DOCUMENTED',
  'TESTED',
  'UNSUPPORTED',
  'UNKNOWN',
] as const;
export type CapabilityStatus = (typeof capabilityStatuses)[number];

export const authorizationStatuses = [
  'AUTHORIZED',
  'NOT_AUTHORIZED',
  'UNKNOWN',
] as const;
export type AuthorizationStatus = (typeof authorizationStatuses)[number];

export const capabilityRequiredForD20: readonly CapabilityCode[] = [
  'd20_exclusive_quota',
  'd20_withdraw_evidence',
];

export const capabilitiesRequiredForActivation: readonly CapabilityCode[] = [
  'inbound_new',
  'inbound_modified',
  'inbound_cancelled',
  'mapping',
  'absolute_availability',
  'rates',
  'stop_sell_open',
  'recovery',
  'd20_exclusive_quota',
  'd20_withdraw_evidence',
];

export interface ChannelCatalogEntry {
  key: string;
  display_name: string;
  required_for_launch: boolean;
}

export const channelCatalog: readonly ChannelCatalogEntry[] = [
  { key: 'tiket-com', display_name: 'tiket.com', required_for_launch: true },
  {
    key: 'booking-com',
    display_name: 'Booking.com',
    required_for_launch: true,
  },
  { key: 'agoda', display_name: 'Agoda', required_for_launch: true },
  { key: 'traveloka', display_name: 'Traveloka', required_for_launch: true },
  { key: 'trip-com', display_name: 'Trip.com', required_for_launch: true },
] as const;

export const productionProviderKeys: readonly string[] = [
  'channex',
  'simulator',
] as const;

export const distributionEventTypes = [
  'AvailabilitySnapshot',
  'RestrictionSnapshot',
  'DistributionSyncRequested',
] as const;
export type DistributionEventType = (typeof distributionEventTypes)[number];

export interface ConnectionContext {
  connection_id: string;
  tenant_id: string;
  property_id: string;
  provider_key: string;
  environment: string;
  channel_key: string;
  secret_ref: string;
  external_property_id: string | null;
  adapter_version: string;
}

export interface RevisionItem {
  item_ref: string | null;
  item_ref_stable: boolean;
  external_room_ref: string | null;
  external_rate_ref: string | null;
  occupancy: number;
  meal_plan_ref: string | null;
  arrival: string;
  departure: string;
  amount: string | null;
  currency: string | null;
}

export interface ChannelRevisionEnvelope {
  schema_version: typeof DISTRIBUTION_SCHEMA_VERSION;
  provider_key: string;
  environment: string;
  connection_id: string;
  channel_key: string;
  external_booking_id: string;
  provider_booking_id: string | null;
  provider_revision_id: string;
  revision_type: RevisionType;
  source_sequence: string | null;
  source_time: string | null;
  received_at: string;
  items: RevisionItem[];
  amount_total: string | null;
  currency: string | null;
  commission_amount: string | null;
  tax_amount: string | null;
  net_amount: string | null;
  meal_plan_ref: string | null;
  occupancy: number | null;
  unmapped_fields: string[];
  payload_hash: string;
  payload_safe_ref: string | null;
  sanitized: true;
}

export interface AvailabilityCell {
  product_ref: string;
  date: string;
  available: number;
  inventory_version: number;
}

export interface AvailabilitySnapshot {
  schema_version: typeof DISTRIBUTION_SCHEMA_VERSION;
  connection_id: string;
  channel_key: string;
  inventory_version: number;
  cells: AvailabilityCell[];
}

export interface RestrictionCell {
  rate_ref: string;
  date: string;
  price: string | null;
  currency: string | null;
  min_stay: number | null;
  max_stay: number | null;
  stop_sell: boolean | null;
  closed_to_arrival: boolean | null;
  closed_to_departure: boolean | null;
  inventory_version: number;
}

export interface RestrictionSnapshot {
  schema_version: typeof DISTRIBUTION_SCHEMA_VERSION;
  connection_id: string;
  channel_key: string;
  inventory_version: number;
  cells: RestrictionCell[];
}

export type CellStatus = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'PARTIAL';

export interface CellResult {
  cell_key: string;
  status: CellStatus;
  safe_error_code: SafeErrorCode | null;
}

export interface PushResultEnvelope {
  schema_version: typeof DISTRIBUTION_SCHEMA_VERSION;
  provider_request_id: string | null;
  provider_task_id: string | null;
  observed_at: string;
  certainty: Certainty;
  safe_error_code: SafeErrorCode | null;
  retry_after_ms: number | null;
  warnings: string[];
  cell_results: CellResult[];
}

export interface MappingSnapshotEntry {
  external_room_ref: string;
  external_rate_ref: string;
  occupancy: number;
  internal_product_ref: string | null;
  internal_rate_ref: string | null;
  effective_at: string;
  status: 'ACTIVE' | 'DRAFT' | 'RETIRED';
}

export interface MappingSnapshot {
  connection_id: string;
  channel_key: string;
  mapping_version: number;
  entries: MappingSnapshotEntry[];
}

export interface CapabilityEvidence {
  capability_code: CapabilityCode;
  status: CapabilityStatus;
  authorization_status: AuthorizationStatus;
  evidence_ref: string | null;
  checked_at: string | null;
  test_run_id: string | null;
  limitations: string[];
  owner: string | null;
  recheck_trigger: string | null;
}

export interface ChannelProfile {
  channel_key: string;
  provider_key: string;
  adapter_version: string;
  environment: string;
  capabilities: CapabilityEvidence[];
  mapping_traits: string[];
}

export interface AdapterRequestMeta {
  deadline_ms: number;
  correlation_id: string;
}

export interface PullPage {
  revisions: ChannelRevisionEnvelope[];
  next_cursor: string | null;
}

export interface AcknowledgeResult {
  certainty: Certainty;
  provider_request_id: string | null;
  observed_at: string;
  safe_error_code: SafeErrorCode | null;
  retry_after_ms: number | null;
}

export interface ProviderStateScope {
  product_refs: string[];
  rate_refs: string[];
  date_from: string;
  date_to: string;
}

export interface ChannelAdapter {
  readonly provider_key: string;
  readonly adapter_version: string;
  inspectCapabilities(
    context: ConnectionContext,
    meta: AdapterRequestMeta,
  ): Promise<CapabilityEvidence[]>;
  inspectMappings(
    context: ConnectionContext,
    meta: AdapterRequestMeta,
  ): Promise<MappingSnapshot>;
  pullRevisions(
    context: ConnectionContext,
    cursor: string | null,
    limit: number,
    meta: AdapterRequestMeta,
  ): Promise<PullPage>;
  acknowledgeRevision(
    context: ConnectionContext,
    providerRevisionId: string,
    meta: AdapterRequestMeta,
  ): Promise<AcknowledgeResult>;
  pushAvailability(
    context: ConnectionContext,
    snapshot: AvailabilitySnapshot,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope>;
  pushRestrictions(
    context: ConnectionContext,
    snapshot: RestrictionSnapshot,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope>;
  readProviderState(
    context: ConnectionContext,
    scope: ProviderStateScope,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope>;
  readChannelEvidence(
    context: ConnectionContext,
    scope: ProviderStateScope,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope>;
}
