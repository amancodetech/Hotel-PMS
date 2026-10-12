import type { RevisionType } from '@hotel/contracts';

export interface AppliedExternalBookingState {
  provider_revision_id: string | null;
  payload_hash: string | null;
  state: 'NONE' | 'ACTIVE' | 'CANCELLED' | 'EXCEPTION';
  source_sequence: string | null;
  source_time: string | null;
}

export interface IncomingRevisionFingerprint {
  provider_revision_id: string;
  payload_hash: string;
  revision_type: RevisionType;
  source_sequence: string | null;
  source_time: string | null;
}

export type ApplicationDecision =
  | { action: 'apply' }
  | { action: 'duplicate' }
  | {
      action: 'stale';
      reason: 'OLDER_REVISION' | 'SEQUENCE_NOT_NEWER' | 'CANCELLED_TERMINAL';
    }
  | {
      action: 'reconcile';
      reason: 'HASH_CONFLICT' | 'AMBIGUOUS_REORDER' | 'UNKNOWN_ORDER';
    };

function numericSequence(value: string | null): bigint | null {
  if (value === null || !/^\d{1,30}$/.test(value)) return null;
  return BigInt(value);
}

export function decideRevisionApplication(
  current: AppliedExternalBookingState,
  incoming: IncomingRevisionFingerprint,
): ApplicationDecision {
  if (current.provider_revision_id === incoming.provider_revision_id) {
    return current.payload_hash === incoming.payload_hash
      ? { action: 'duplicate' }
      : { action: 'reconcile', reason: 'HASH_CONFLICT' };
  }
  if (current.state === 'NONE' || current.provider_revision_id === null)
    return { action: 'apply' };

  const currentSequence = numericSequence(current.source_sequence);
  const incomingSequence = numericSequence(incoming.source_sequence);
  if (currentSequence !== null && incomingSequence !== null) {
    if (incomingSequence === currentSequence)
      return { action: 'reconcile', reason: 'AMBIGUOUS_REORDER' };
    if (incomingSequence < currentSequence)
      return { action: 'stale', reason: 'SEQUENCE_NOT_NEWER' };
    return { action: 'apply' };
  }

  if (current.source_time !== null && incoming.source_time !== null) {
    const currentTime = Date.parse(current.source_time);
    const incomingTime = Date.parse(incoming.source_time);
    if (
      Number.isFinite(currentTime) &&
      Number.isFinite(incomingTime) &&
      incomingTime !== currentTime
    ) {
      if (incomingTime < currentTime)
        return { action: 'stale', reason: 'OLDER_REVISION' };
      return { action: 'apply' };
    }
    if (incomingTime === currentTime)
      return { action: 'reconcile', reason: 'AMBIGUOUS_REORDER' };
  }

  if (current.state === 'CANCELLED') {
    return incoming.revision_type === 'cancelled'
      ? { action: 'stale', reason: 'CANCELLED_TERMINAL' }
      : { action: 'reconcile', reason: 'AMBIGUOUS_REORDER' };
  }

  if (current.state === 'EXCEPTION')
    return { action: 'reconcile', reason: 'UNKNOWN_ORDER' };

  return { action: 'apply' };
}
