import { capabilityCodes } from '@hotel/contracts';
import type {
  CapabilityCode,
  CapabilityEvidence,
  ChannelProfile,
} from '@hotel/contracts';

const checkedAt = '2026-09-12';
const providerKey = 'channex';
const adapterVersion = '0.1.0';
const environment = 'live';

const defaultLimitations = [
  'No live provider authorization or test recorded for this capability',
];

function unknownCapabilities(
  evidenceRef: string,
  limitations: Partial<Record<CapabilityCode, string[]>> = {},
): CapabilityEvidence[] {
  return capabilityCodes.map((code) => ({
    capability_code: code,
    status: 'UNKNOWN',
    authorization_status: 'NOT_AUTHORIZED',
    evidence_ref: evidenceRef,
    checked_at: checkedAt,
    test_run_id: null,
    limitations: limitations[code] ?? defaultLimitations,
    owner: 'product-owner',
    recheck_trigger: 'EX-01 provider capability confirmation',
  }));
}

const d20Limitations: Partial<Record<CapabilityCode, string[]>> = {
  d20_exclusive_quota: [
    'EX-01: exclusivity of a D-20 quota per channel and product is not yet proven',
  ],
  d20_withdraw_evidence: [
    'EX-01: independent withdrawal evidence (readback or documented manual proof) is not yet confirmed',
  ],
  historical_import: [
    'Initial import scope and completeness per channel are not yet evidenced',
  ],
  messaging: ['Guest messaging capabilities are deferred to Phase 14'],
};

export const channelProfiles: readonly ChannelProfile[] = [
  {
    channel_key: 'tiket-com',
    provider_key: providerKey,
    adapter_version: adapterVersion,
    environment,
    capabilities: unknownCapabilities(
      'docs/22_connectivity_evidence.md#C07',
      d20Limitations,
    ),
    mapping_traits: [
      'Connection is requested through tiket support before room and rate mapping',
      'Modify, cancel, Stop Sell and recovery behavior must be tested per account',
    ],
  },
  {
    channel_key: 'booking-com',
    provider_key: providerKey,
    adapter_version: adapterVersion,
    environment,
    capabilities: unknownCapabilities(
      'docs/22_connectivity_evidence.md#C06',
      d20Limitations,
    ),
    mapping_traits: [
      'Derived rates and occupancy variations must be fully covered by mapping',
      'Future-booking import does not change Channex availability',
    ],
  },
  {
    channel_key: 'agoda',
    provider_key: providerKey,
    adapter_version: adapterVersion,
    environment,
    capabilities: unknownCapabilities(
      'docs/22_connectivity_evidence.md#C08',
      d20Limitations,
    ),
    mapping_traits: [
      'Multi-occupancy pricing must be mapped per occupancy, never copied silently',
      'Rate, currency and commission semantics are account specific',
    ],
  },
  {
    channel_key: 'traveloka',
    provider_key: providerKey,
    adapter_version: adapterVersion,
    environment,
    capabilities: unknownCapabilities(
      'docs/22_connectivity_evidence.md#C09',
      d20Limitations,
    ),
    mapping_traits: [
      'Property connection ID may differ from the public property ID',
      'Meal plans map at room level with RETAIL and derived rates',
    ],
  },
  {
    channel_key: 'trip-com',
    provider_key: providerKey,
    adapter_version: adapterVersion,
    environment,
    capabilities: unknownCapabilities(
      'docs/22_connectivity_evidence.md#C10',
      d20Limitations,
    ),
    mapping_traits: [
      'Ctrip/Trip.com connectivity path; confirm the intended Trip account identity',
      'Account coverage, currency and restrictions are not assumed from the name',
    ],
  },
] as const;

export function findChannelProfile(
  channelKey: string,
): ChannelProfile | undefined {
  return channelProfiles.find((profile) => profile.channel_key === channelKey);
}
