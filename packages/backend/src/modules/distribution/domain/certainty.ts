import type { Certainty } from '@hotel/contracts';

const ranks: Record<Certainty, number> = {
  NOT_SENT: 0,
  REJECTED: 0,
  UNKNOWN: 1,
  PARTIAL: 2,
  PROVIDER_ACCEPTED: 3,
  CHANNEL_VERIFIED: 4,
};

export function certaintyRank(certainty: Certainty): number {
  return ranks[certainty];
}

export function isProviderAccepted(certainty: Certainty): boolean {
  return certainty === 'PROVIDER_ACCEPTED' || certainty === 'CHANNEL_VERIFIED';
}

export function isChannelVerified(certainty: Certainty): boolean {
  return certainty === 'CHANNEL_VERIFIED';
}

export function isSuccess(certainty: Certainty): boolean {
  return isProviderAccepted(certainty);
}

export function isPartial(certainty: Certainty): boolean {
  return certainty === 'PARTIAL';
}

export function isFailure(certainty: Certainty): boolean {
  return certainty === 'NOT_SENT' || certainty === 'REJECTED';
}

export function isUnknown(certainty: Certainty): boolean {
  return certainty === 'UNKNOWN';
}
