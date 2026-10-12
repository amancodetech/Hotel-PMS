export interface ConnectionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  provider_key: string;
  environment: string;
  channel_key: string;
  external_property_id: string | null;
  secret_ref: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MappingRow {
  id: string;
  connection_id: string;
  channel_key: string;
  external_room_ref: string;
  external_rate_ref: string;
  occupancy: number;
  meal_plan_ref: string | null;
  internal_product_ref: string | null;
  internal_rate_ref: string | null;
  effective_at: string;
  status: string;
  mapping_version: number;
  created_at: string;
  updated_at: string;
}

export interface ExternalBookingRow {
  id: string;
  connection_id: string;
  channel_key: string;
  external_booking_id: string;
  provider_booking_id: string | null;
  state: string;
  latest_revision_id: string | null;
  latest_payload_hash: string | null;
  source_sequence: string | null;
  source_time: string | null;
  reservation_ref: string | null;
  exception_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InboxRow {
  id: string;
  connection_id: string;
  channel_key: string;
  provider_key: string;
  environment: string;
  provider_revision_id: string;
  external_booking_id: string;
  revision_type: string;
  payload_hash: string;
  payload_safe: unknown;
  source_sequence: string | null;
  source_time: string | null;
  received_at: string;
  processing_state: string;
  safe_error_code: string | null;
  external_booking_ref: string | null;
  exception_id: string | null;
  ack_state: string;
  ack_attempt_count: number;
  ack_provider_request_id: string | null;
  ack_lease_owner: string | null;
  ack_lease_token: string | null;
  ack_lease_expires_at: string | null;
  ack_next_attempt_at: string | null;
  ack_exception_id: string | null;
  applied_at: string | null;
  last_attempt_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string;
  channel_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  inventory_version: number;
  payload_safe: unknown;
  status: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  last_safe_error_code: string | null;
  provider_request_id: string | null;
  provider_task_id: string | null;
  certainty: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  outbox_id: string;
  attempt_no: number;
  status: string;
  certainty: string | null;
  http_status: number | null;
  provider_request_id: string | null;
  provider_task_id: string | null;
  safe_error_code: string | null;
  retry_after_ms: number | null;
  started_at: string;
  finished_at: string | null;
  response_safe: unknown;
  created_at: string;
}

export interface DedupRow {
  id: string;
  scope: string;
  dedup_key: string;
  payload_hash: string | null;
  inbox_revision_id: string | null;
  created_at: string;
}

export interface CheckpointRow {
  id: string;
  connection_id: string;
  stream: string;
  cursor: string | null;
  last_pull_at: string | null;
  version: number;
  updated_at: string;
}

export interface ExceptionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string | null;
  inbox_revision_id: string | null;
  outbox_id: string | null;
  type: string;
  state: string;
  owner: string | null;
  resolution: string | null;
  details_safe: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DeadLetterRow {
  id: string;
  tenant_id: string;
  property_id: string;
  connection_id: string;
  outbox_id: string | null;
  event_type: string;
  payload_safe: unknown;
  safe_error_code: string | null;
  attempts: number;
  reason: string;
  reprocessed_at: string | null;
  reprocessed_by: string | null;
  reprocess_reason: string | null;
  created_at: string;
}
