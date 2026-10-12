import { capabilitiesRequiredForActivation } from '@hotel/contracts';
import type {
  CapabilityCode,
  CapabilityEvidence,
  ChannelProfile,
} from '@hotel/contracts';
import { DistributionError } from './errors.js';

export interface ActivationGate {
  allowed: boolean;
  missing: CapabilityCode[];
  blockers: CapabilityCode[];
}

export function evidenceFor(
  profile: ChannelProfile,
  code: CapabilityCode,
): CapabilityEvidence | undefined {
  return profile.capabilities.find(
    (evidence) => evidence.capability_code === code,
  );
}

export function evaluateActivationGate(
  profile: ChannelProfile,
): ActivationGate {
  const missing: CapabilityCode[] = [];
  const blockers: CapabilityCode[] = [];
  for (const code of capabilitiesRequiredForActivation) {
    const evidence = evidenceFor(profile, code);
    if (
      !evidence ||
      evidence.status !== 'TESTED' ||
      evidence.authorization_status !== 'AUTHORIZED'
    ) {
      missing.push(code);
      blockers.push(code);
    }
  }
  return { allowed: blockers.length === 0, missing, blockers };
}

export function capabilityStatus(
  profile: ChannelProfile,
  code: CapabilityCode,
): CapabilityEvidence['status'] {
  return evidenceFor(profile, code)?.status ?? 'UNKNOWN';
}

export function assertPushCapability(
  profile: ChannelProfile,
  code: CapabilityCode,
): void {
  const status = capabilityStatus(profile, code);
  if (status === 'UNKNOWN' || status === 'UNSUPPORTED')
    throw new DistributionError(
      'UNSUPPORTED',
      'Capability is not available for this channel',
      { channelKey: profile.channel_key, capability: code, status },
    );
}

export function assertActivationAllowed(profile: ChannelProfile): void {
  const gate = evaluateActivationGate(profile);
  if (!gate.allowed)
    throw new DistributionError(
      'UNSUPPORTED',
      'Connection activation is blocked by missing verified capabilities',
      {
        channelKey: profile.channel_key,
        blockers: gate.blockers,
      },
    );
}
