import { capabilityCodes, channelCatalog } from '@hotel/contracts';
import type {
  CapabilityEvidence,
  ChannelProfile,
  MappingSnapshot,
} from '@hotel/contracts';
import type {
  SimulatorRevisionSeed,
  SimulatorScenarioOptions,
} from './engine.js';

export const syntheticSixthChannelKey = 'test-sixth-channel';

export const simulatorAdapterVersion = 'simulator-1.0.0';

export function simulatorTestEvidence(): CapabilityEvidence[] {
  return capabilityCodes.map((code) => ({
    capability_code: code,
    status: 'TESTED',
    authorization_status: 'AUTHORIZED',
    evidence_ref: 'tests/distribution/simulator',
    checked_at: '2026-09-13T00:00:00Z',
    test_run_id: 'P02-02-simulator',
    limitations: [
      'Synthetic simulator evidence; never upgrades a real channel',
    ],
    owner: 'implementer',
    recheck_trigger: null,
  }));
}

export function simulatorTestProfile(
  channelKey: string,
  environment = 'simulator',
): ChannelProfile {
  return {
    channel_key: channelKey,
    provider_key: 'simulator',
    adapter_version: simulatorAdapterVersion,
    environment,
    capabilities: simulatorTestEvidence(),
    mapping_traits: ['synthetic'],
  };
}

export const syntheticSixthChannelProfile = simulatorTestProfile(
  syntheticSixthChannelKey,
);

export function realChannelKeys(): string[] {
  return channelCatalog.map((entry) => entry.key);
}

export function mappingFixture(
  channelKey: string,
  connectionId: string,
): MappingSnapshot {
  return {
    connection_id: connectionId,
    channel_key: channelKey,
    mapping_version: 1,
    entries: [
      {
        external_room_ref: 'ROOM-1',
        external_rate_ref: 'RATE-1',
        occupancy: 2,
        internal_product_ref: null,
        internal_rate_ref: null,
        effective_at: '2026-09-13T00:00:00Z',
        status: 'DRAFT',
      },
    ],
  };
}

export function lifecycleSeeds(channelKey: string): SimulatorRevisionSeed[] {
  return [
    {
      provider_revision_id: `${channelKey}-R1`,
      revision_type: 'new',
      external_booking_id: `SYNTH-${channelKey}-1`,
      provider_booking_id: `PB-${channelKey}-1`,
      source_sequence: '1',
      source_time: '2026-09-13T00:00:00Z',
      items: [
        {
          arrival: '2026-10-01',
          departure: '2026-10-03',
          amount: '1250000.50',
          currency: 'IDR',
        },
      ],
      amount_total: '1250000.50',
      currency: 'IDR',
    },
    {
      provider_revision_id: `${channelKey}-R2`,
      revision_type: 'modified',
      external_booking_id: `SYNTH-${channelKey}-1`,
      provider_booking_id: `PB-${channelKey}-1`,
      source_sequence: '2',
      source_time: '2026-09-13T01:00:00Z',
      items: [
        {
          arrival: '2026-10-02',
          departure: '2026-10-04',
          amount: '1350000.00',
          currency: 'IDR',
        },
      ],
      amount_total: '1350000.00',
      currency: 'IDR',
    },
    {
      provider_revision_id: `${channelKey}-R3`,
      revision_type: 'cancelled',
      external_booking_id: `SYNTH-${channelKey}-1`,
      provider_booking_id: `PB-${channelKey}-1`,
      source_sequence: '3',
      source_time: '2026-09-13T02:00:00Z',
      items: [],
    },
  ];
}

export function lifecycleScenario(
  channelKey: string,
  overrides: Partial<SimulatorScenarioOptions> = {},
): SimulatorScenarioOptions {
  return {
    seed: `P02-02-${channelKey}`,
    revisions: lifecycleSeeds(channelKey),
    mappings: null,
    ...overrides,
  };
}

export function fiveChannelScenarios(): SimulatorScenarioOptions[] {
  return realChannelKeys().map((channelKey) =>
    lifecycleScenario(channelKey, { mappings: null }),
  );
}

export function missingMappingScenario(
  channelKey: string,
): SimulatorScenarioOptions {
  return lifecycleScenario(channelKey, { mappings: null });
}
