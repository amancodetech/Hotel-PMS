import { describe, expect, test } from '@jest/globals';
import {
  ProviderRegistry,
  assertActivationAllowed,
  assertPushCapability,
  certaintyRank,
  classifyHttpStatus,
  classifyTransportFailure,
  decideRevisionApplication,
  evaluateActivationGate,
  findChannelProfile,
  isProviderAccepted,
  isSuccess,
  isUnknown,
  parseChannelRevisionEnvelope,
  channelProfiles,
} from '../../packages/backend/dist/modules/distribution/index.js';
import {
  capabilityCodes,
  channelCatalog,
} from '../../packages/contracts/dist/distribution.js';

const connectionId = '11111111-2222-4333-8444-555555555555';

function envelope(overrides = {}) {
  return {
    schema_version: 1,
    provider_key: 'simulator',
    environment: 'test',
    connection_id: connectionId,
    channel_key: 'tiket-com',
    external_booking_id: 'SYNTH-0001',
    provider_booking_id: 'PB-1',
    provider_revision_id: 'REV-1',
    revision_type: 'new',
    source_sequence: '1',
    source_time: '2026-09-13T00:00:00Z',
    received_at: '2026-09-13T00:00:01Z',
    items: [
      {
        item_ref: 'ITEM-1',
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
    amount_total: '1250000.50',
    currency: 'IDR',
    commission_amount: null,
    tax_amount: null,
    net_amount: null,
    meal_plan_ref: null,
    occupancy: 2,
    unmapped_fields: [],
    payload_hash: 'a'.repeat(64),
    payload_safe_ref: null,
    sanitized: true,
    ...overrides,
  };
}

const allowed = {
  allowedProviderKeys: new Set(['simulator']),
  allowedChannelKeys: new Set(channelCatalog.map((entry) => entry.key)),
};

describe('P02-01 provider-neutral contract validation', () => {
  test('accepts a sanitized provider-neutral envelope', () => {
    const parsed = parseChannelRevisionEnvelope(envelope(), allowed);
    expect(parsed.provider_revision_id).toBe('REV-1');
    expect(parsed.items).toHaveLength(1);
  });
  test('rejects an unknown provider without echoing payload values', () => {
    try {
      parseChannelRevisionEnvelope(
        envelope({ provider_key: 'mystery-provider' }),
        allowed,
      );
      throw new Error('unexpected success');
    } catch (error) {
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(error.details)).not.toContain('mystery-provider');
    }
  });
  test('rejects an unknown channel', () => {
    expect(() =>
      parseChannelRevisionEnvelope(envelope({ channel_key: 'unknown-ota' }), {
        ...allowed,
        allowedChannelKeys: new Set(),
      }),
    ).toThrow('Unknown channel');
  });
  test('rejects wrong schema version, malformed fields and extra fields', () => {
    const bad = [
      envelope({ schema_version: 2 }),
      envelope({ payload_hash: 'short' }),
      envelope({ received_at: 'not-a-time' }),
      envelope({ source_sequence: 'seq-1' }),
      envelope({ currency: 'EUR' }),
      envelope({ items: [] }),
      envelope({ card_number: '4111111111111111' }),
      envelope({
        items: [
          {
            item_ref: null,
            item_ref_stable: false,
            external_room_ref: 'ROOM-1',
            external_rate_ref: 'RATE-1',
            occupancy: 1,
            meal_plan_ref: null,
            arrival: '2026-10-03',
            departure: '2026-10-01',
            amount: null,
            currency: null,
          },
        ],
      }),
    ];
    for (const input of bad)
      expect(() => parseChannelRevisionEnvelope(input, allowed)).toThrow(
        'Invalid distribution payload',
      );
  });
  test('keeps UNKNOWN and partial distinct from success', () => {
    expect(isSuccess('UNKNOWN')).toBe(false);
    expect(isSuccess('PARTIAL')).toBe(false);
    expect(isSuccess('NOT_SENT')).toBe(false);
    expect(isSuccess('REJECTED')).toBe(false);
    expect(isSuccess('PROVIDER_ACCEPTED')).toBe(true);
    expect(isProviderAccepted('UNKNOWN')).toBe(false);
    expect(isUnknown('UNKNOWN')).toBe(true);
    expect(certaintyRank('CHANNEL_VERIFIED')).toBeGreaterThan(
      certaintyRank('PROVIDER_ACCEPTED'),
    );
    expect(certaintyRank('UNKNOWN')).toBeGreaterThan(certaintyRank('NOT_SENT'));
  });
  test('classifies transport failures without claiming acceptance', () => {
    expect(classifyHttpStatus(500)).toMatchObject({
      code: 'PROVIDER_ERROR',
      certainty: 'UNKNOWN',
      retryable: true,
    });
    expect(classifyHttpStatus(429)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(classifyHttpStatus(422)).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    });
    expect(classifyTransportFailure('BEFORE_SEND').certainty).toBe('NOT_SENT');
    expect(classifyTransportFailure('AFTER_SEND').certainty).toBe('UNKNOWN');
  });
});

describe('P02-01 provider registry', () => {
  const adapter = {
    provider_key: 'simulator',
    adapter_version: '0.1.0',
  };
  test('rejects unknown providers and duplicates', () => {
    const registry = new ProviderRegistry([adapter]);
    expect(() => registry.resolve('unknown')).toThrow('Unknown provider');
    expect(() => new ProviderRegistry([adapter, { ...adapter }])).toThrow(
      'Duplicate adapter',
    );
    expect(registry.has('simulator')).toBe(true);
  });
  test('rejects adapter version mismatch for a connection context', () => {
    const registry = new ProviderRegistry([adapter]);
    expect(() =>
      registry.resolveForContext({
        connection_id: connectionId,
        tenant_id: connectionId,
        property_id: connectionId,
        provider_key: 'simulator',
        environment: 'test',
        channel_key: 'tiket-com',
        secret_ref: 'secret:sim',
        external_property_id: null,
        adapter_version: '9.9.9',
      }),
    ).toThrow('Adapter version mismatch');
  });
});

describe('P02-01 capability matrix gates D-20 claims', () => {
  test('all five real channels stay UNKNOWN and blocked', () => {
    expect(channelProfiles).toHaveLength(5);
    expect(new Set(channelProfiles.map((p) => p.channel_key))).toEqual(
      new Set(channelCatalog.map((entry) => entry.key)),
    );
    for (const profile of channelProfiles) {
      expect(profile.capabilities).toHaveLength(capabilityCodes.length);
      expect(
        profile.capabilities.every(
          (evidence) =>
            evidence.status === 'UNKNOWN' || evidence.status === 'UNSUPPORTED',
        ),
      ).toBe(true);
      const gate = evaluateActivationGate(profile);
      expect(gate.allowed).toBe(false);
      expect(gate.blockers).toContain('d20_exclusive_quota');
      expect(gate.blockers).toContain('d20_withdraw_evidence');
      expect(() => assertActivationAllowed(profile)).toThrow(
        'Connection activation is blocked',
      );
      expect(() =>
        assertPushCapability(profile, 'absolute_availability'),
      ).toThrow('Capability is not available');
    }
  });
  test('a fully tested synthetic profile can pass the gate without catalog changes', () => {
    const profile = {
      channel_key: 'test-sixth-channel',
      provider_key: 'simulator',
      adapter_version: 'test',
      environment: 'test',
      mapping_traits: [],
      capabilities: capabilityCodes.map((code) => ({
        capability_code: code,
        status: 'TESTED',
        authorization_status: 'AUTHORIZED',
        evidence_ref: 'tests/distribution',
        checked_at: '2026-09-13T00:00:00Z',
        test_run_id: 'P02-01-synthetic',
        limitations: [],
        owner: 'implementer',
        recheck_trigger: null,
      })),
    };
    expect(evaluateActivationGate(profile).allowed).toBe(true);
    expect(() => assertActivationAllowed(profile)).not.toThrow();
    expect(() => assertPushCapability(profile, 'rates')).not.toThrow();
    expect(findChannelProfile('test-sixth-channel')).toBeUndefined();
  });
});

describe('P02-01 revision ordering decisions', () => {
  const state = (overrides) => ({
    provider_revision_id: 'REV-1',
    payload_hash: 'a'.repeat(64),
    state: 'ACTIVE',
    source_sequence: '2',
    source_time: '2026-09-13T00:00:00Z',
    ...overrides,
  });
  const incoming = (overrides) => ({
    provider_revision_id: 'REV-2',
    payload_hash: 'b'.repeat(64),
    revision_type: 'modified',
    source_sequence: '3',
    source_time: '2026-09-13T01:00:00Z',
    ...overrides,
  });
  test('same revision and hash is a duplicate', () =>
    expect(
      decideRevisionApplication(
        state(),
        incoming({
          provider_revision_id: 'REV-1',
          payload_hash: 'a'.repeat(64),
        }),
      ),
    ).toEqual({ action: 'duplicate' }));
  test('same revision with different hash needs reconciliation', () =>
    expect(
      decideRevisionApplication(
        state(),
        incoming({
          provider_revision_id: 'REV-1',
          payload_hash: 'c'.repeat(64),
        }),
      ),
    ).toEqual({ action: 'reconcile', reason: 'HASH_CONFLICT' }));
  test('older sequence is stale, newer applies', () => {
    expect(
      decideRevisionApplication(state(), incoming({ source_sequence: '1' })),
    ).toEqual({ action: 'stale', reason: 'SEQUENCE_NOT_NEWER' });
    expect(decideRevisionApplication(state(), incoming())).toEqual({
      action: 'apply',
    });
  });
  test('an older modification does not revive a cancelled booking', () => {
    expect(
      decideRevisionApplication(
        state({ state: 'CANCELLED' }),
        incoming({
          source_sequence: null,
          source_time: '2026-09-12T23:00:00Z',
        }),
      ),
    ).toEqual({ action: 'stale', reason: 'OLDER_REVISION' });
    expect(
      decideRevisionApplication(
        state({ state: 'CANCELLED' }),
        incoming({ source_sequence: null, source_time: null }),
      ),
    ).toEqual({ action: 'reconcile', reason: 'AMBIGUOUS_REORDER' });
    expect(
      decideRevisionApplication(
        state({ state: 'CANCELLED' }),
        incoming({
          revision_type: 'cancelled',
          source_sequence: null,
          source_time: null,
        }),
      ),
    ).toEqual({ action: 'stale', reason: 'CANCELLED_TERMINAL' });
  });
});
