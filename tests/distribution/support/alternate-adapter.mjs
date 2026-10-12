import { createHash } from 'node:crypto';
import { capabilityCodes } from '../../../packages/contracts/dist/distribution.js';

export const alternateProviderKey = 'test-alternate';
export const alternateAdapterVersion = 'test-alt-1.0.0';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function alternateProfile(channelKey = 'test-sixth-channel') {
  return {
    channel_key: channelKey,
    provider_key: alternateProviderKey,
    adapter_version: alternateAdapterVersion,
    environment: 'test',
    mapping_traits: ['alternate-adapter'],
    capabilities: capabilityCodes.map((code) => ({
      capability_code: code,
      status: 'TESTED',
      authorization_status: 'AUTHORIZED',
      evidence_ref: 'tests/distribution/support/alternate-adapter',
      checked_at: '2026-09-13T00:00:00Z',
      test_run_id: 'P02-06-alternate',
      limitations: [],
      owner: 'implementer',
      recheck_trigger: null,
    })),
  };
}

function envelope(context, suffix, type) {
  const payload = {
    provider_revision_id: `ALT-${suffix}`,
    revision_type: type,
    external_booking_id: 'ALT-BOOKING-1',
    channel_key: context.channel_key,
    items:
      type === 'cancelled'
        ? []
        : [
            {
              item_ref: 'ALT-ITEM-1',
              item_ref_stable: true,
              external_room_ref: 'ROOM-1',
              external_rate_ref: 'RATE-1',
              occupancy: 2,
              meal_plan_ref: null,
              arrival: '2026-10-01',
              departure: '2026-10-03',
              amount: '1250000.50',
              currency: 'IDR',
            },
          ],
  };
  return {
    schema_version: 1,
    provider_key: alternateProviderKey,
    environment: context.environment,
    connection_id: context.connection_id,
    channel_key: context.channel_key,
    external_booking_id: 'ALT-BOOKING-1',
    provider_booking_id: 'ALT-PB-1',
    provider_revision_id: `ALT-${suffix}`,
    revision_type: type,
    source_sequence: suffix === 'R1' ? '1' : suffix === 'R2' ? '2' : '3',
    source_time: '2026-09-13T00:00:00Z',
    received_at: '2026-09-13T00:00:01Z',
    items: payload.items,
    amount_total: type === 'cancelled' ? null : '1250000.50',
    currency: type === 'cancelled' ? null : 'IDR',
    commission_amount: null,
    tax_amount: null,
    net_amount: null,
    meal_plan_ref: null,
    occupancy: type === 'cancelled' ? null : 2,
    unmapped_fields: [],
    payload_hash: hash(payload),
    payload_safe_ref: `safe:alternate:${suffix}`,
    sanitized: true,
  };
}

export class AlternateAdapter {
  provider_key = alternateProviderKey;
  adapter_version = alternateAdapterVersion;
  acked = [];

  async inspectCapabilities(context) {
    return alternateProfile(context.channel_key).capabilities;
  }

  async inspectMappings(context) {
    return {
      connection_id: context.connection_id,
      channel_key: context.channel_key,
      mapping_version: 1,
      entries: [
        {
          external_room_ref: 'ROOM-1',
          external_rate_ref: 'RATE-1',
          occupancy: 2,
          internal_product_ref: null,
          internal_rate_ref: null,
          effective_at: '2026-09-13T00:00:00Z',
          status: 'ACTIVE',
        },
      ],
    };
  }

  async pullRevisions(context, cursor, limit) {
    const revisions = [
      envelope(context, 'R1', 'new'),
      envelope(context, 'R2', 'modified'),
      envelope(context, 'R3', 'cancelled'),
    ];
    if (cursor === null)
      return {
        revisions: revisions.slice(0, Math.min(limit, 2)),
        next_cursor: limit >= 3 ? null : 'alternate:2',
      };
    if (cursor === 'alternate:2')
      return { revisions: revisions.slice(2), next_cursor: null };
    throw new Error('alternate invalid cursor');
  }

  async acknowledgeRevision(_context, providerRevisionId) {
    this.acked.push(providerRevisionId);
    return {
      certainty: 'PROVIDER_ACCEPTED',
      provider_request_id: `alt-ack-${this.acked.length}`,
      observed_at: '2026-09-13T00:00:01Z',
      safe_error_code: null,
      retry_after_ms: null,
    };
  }

  async pushAvailability(context, snapshot) {
    void context;
    return {
      schema_version: 1,
      provider_request_id: 'alt-push-1',
      provider_task_id: null,
      observed_at: '2026-09-13T00:00:01Z',
      certainty: 'PROVIDER_ACCEPTED',
      safe_error_code: null,
      retry_after_ms: null,
      warnings: [],
      cell_results: snapshot.cells.map((cell) => ({
        cell_key: `${cell.product_ref}:${cell.date}`,
        status: 'ACCEPTED',
        safe_error_code: null,
      })),
    };
  }

  async pushRestrictions(context, snapshot) {
    return this.pushAvailability(context, {
      cells: snapshot.cells.map((cell) => ({
        product_ref: cell.rate_ref,
        date: cell.date,
      })),
    });
  }

  async readProviderState(context, scope) {
    return {
      schema_version: 1,
      provider_request_id: null,
      provider_task_id: null,
      observed_at: '2026-09-13T00:00:01Z',
      certainty: 'UNKNOWN',
      safe_error_code: 'UNKNOWN',
      retry_after_ms: null,
      warnings: ['READBACK_UNAVAILABLE'],
      cell_results: scope.product_refs.map((ref) => ({
        cell_key: ref,
        status: 'UNKNOWN',
        safe_error_code: 'UNKNOWN',
      })),
    };
  }

  async readChannelEvidence(context, scope) {
    return this.readProviderState(context, scope);
  }
}
