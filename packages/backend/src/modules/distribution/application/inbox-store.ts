import type { EntityManager } from '@mikro-orm/postgresql';
import type { ChannelRevisionEnvelope } from '@hotel/contracts';
import { decideRevisionApplication } from '../domain/ordering.js';
import type {
  ApplicationDecision,
  AppliedExternalBookingState,
} from '../domain/ordering.js';
import { openException } from '../persistence/exception-repository.js';
import {
  findInboxRevisionByIdForUpdate,
  insertInboxRevision,
  updateInboxRevision,
} from '../persistence/inbox-repository.js';
import {
  findExternalBookingForUpdate,
  upsertExternalBooking,
} from '../persistence/external-booking-repository.js';
import { findMappingForItem } from '../persistence/mapping-repository.js';
import { registerDedup } from '../persistence/dedup-repository.js';
import type { InboxRow } from '../persistence/types.js';

export type StoreStatus =
  'APPLIED' | 'DUPLICATE' | 'IGNORED_STALE' | 'EXCEPTION' | 'REPLAY_CONFLICT';

export interface StoreResult {
  status: StoreStatus;
  inboxId: string;
  externalBookingId: string | null;
  exceptionId: string | null;
  decision: ApplicationDecision | null;
  created: boolean;
}

export interface StoreOptions {
  receivedAt: string;
  tenantId: string;
  propertyId: string;
}

function currentState(
  row: Awaited<ReturnType<typeof findExternalBookingForUpdate>>,
): AppliedExternalBookingState {
  if (!row)
    return {
      provider_revision_id: null,
      payload_hash: null,
      state: 'NONE',
      source_sequence: null,
      source_time: null,
    };
  return {
    provider_revision_id: row.latest_revision_id,
    payload_hash: row.latest_payload_hash,
    state:
      row.state === 'EXCEPTION'
        ? 'EXCEPTION'
        : row.state === 'CANCELLED'
          ? 'CANCELLED'
          : 'ACTIVE',
    source_sequence: row.source_sequence,
    source_time: row.source_time,
  };
}

function missingMappingItemRefs(
  envelope: ChannelRevisionEnvelope,
  mappings: { found: boolean }[],
): string[] {
  return envelope.items
    .filter((_item, index) => !mappings[index]?.found)
    .map((item, index) => item.item_ref ?? `index-${index}`);
}

async function resolveMappings(
  em: EntityManager,
  envelope: ChannelRevisionEnvelope,
): Promise<{ found: boolean }[]> {
  const results: { found: boolean }[] = [];
  for (const item of envelope.items) {
    if (item.external_room_ref === null || item.external_rate_ref === null) {
      results.push({ found: false });
      continue;
    }
    const mapping = await findMappingForItem(
      em,
      envelope.connection_id,
      envelope.channel_key,
      item.external_room_ref,
      item.external_rate_ref,
      item.occupancy,
    );
    results.push({ found: mapping !== null });
  }
  return results;
}

async function openInboxException(
  em: EntityManager,
  envelope: ChannelRevisionEnvelope,
  inboxId: string,
  type: string,
  details: Record<string, unknown>,
  options: StoreOptions,
): Promise<StoreResult> {
  const exception = await openException(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    connectionId: envelope.connection_id,
    inboxRevisionId: inboxId,
    outboxId: null,
    type,
    detailsSafe: details,
  });
  await updateInboxRevision(em, inboxId, {
    processingState: 'EXCEPTION',
    exceptionId: exception.id,
    safeErrorCode: type,
  });
  return {
    status: 'EXCEPTION',
    inboxId,
    externalBookingId: null,
    exceptionId: exception.id,
    decision: null,
    created: true,
  };
}

export async function storeChannelRevision(
  em: EntityManager,
  envelope: ChannelRevisionEnvelope,
  options: StoreOptions,
): Promise<StoreResult> {
  const { row, inserted } = await insertInboxRevision(em, {
    connectionId: envelope.connection_id,
    channelKey: envelope.channel_key,
    providerKey: envelope.provider_key,
    environment: envelope.environment,
    providerRevisionId: envelope.provider_revision_id,
    externalBookingId: envelope.external_booking_id,
    revisionType: envelope.revision_type,
    payloadHash: envelope.payload_hash,
    payloadSafe: envelope,
    sourceSequence: envelope.source_sequence,
    sourceTime: envelope.source_time,
    receivedAt: options.receivedAt,
  });

  if (!inserted) {
    if (row.payload_hash === envelope.payload_hash)
      return {
        status: 'DUPLICATE',
        inboxId: row.id,
        externalBookingId: row.external_booking_ref,
        exceptionId: row.exception_id,
        decision: { action: 'duplicate' },
        created: false,
      };
    const exception = await openException(em, {
      tenantId: options.tenantId,
      propertyId: options.propertyId,
      connectionId: envelope.connection_id,
      inboxRevisionId: row.id,
      outboxId: null,
      type: 'DUPLICATE_REVISION_HASH_CONFLICT',
      detailsSafe: {
        provider_revision_id: envelope.provider_revision_id,
        stored_hash_prefix: row.payload_hash.slice(0, 12),
        incoming_hash_prefix: envelope.payload_hash.slice(0, 12),
      },
    });
    await updateInboxRevision(em, row.id, {
      exceptionId: exception.id,
      safeErrorCode: 'DUPLICATE_REVISION_HASH_CONFLICT',
    });
    return {
      status: 'REPLAY_CONFLICT',
      inboxId: row.id,
      externalBookingId: row.external_booking_ref,
      exceptionId: exception.id,
      decision: { action: 'reconcile', reason: 'HASH_CONFLICT' },
      created: false,
    };
  }

  const dedup = await registerDedup(em, {
    scope: `${envelope.connection_id}:${envelope.environment}`,
    key: envelope.provider_revision_id,
    payloadHash: envelope.payload_hash,
    inboxRevisionId: row.id,
  });
  if (dedup.kind === 'conflict')
    return openInboxException(
      em,
      envelope,
      row.id,
      'DEDUP_HASH_CONFLICT',
      { provider_revision_id: envelope.provider_revision_id },
      options,
    );

  const mappingResults = await resolveMappings(em, envelope);
  if (mappingResults.some((result) => !result.found))
    return openInboxException(
      em,
      envelope,
      row.id,
      'MAPPING_MISSING',
      {
        provider_revision_id: envelope.provider_revision_id,
        items: missingMappingItemRefs(envelope, mappingResults),
      },
      options,
    );

  const current = currentState(
    await findExternalBookingForUpdate(
      em,
      envelope.connection_id,
      envelope.external_booking_id,
    ),
  );
  const decision = decideRevisionApplication(current, {
    provider_revision_id: envelope.provider_revision_id,
    payload_hash: envelope.payload_hash,
    revision_type: envelope.revision_type,
    source_sequence: envelope.source_sequence,
    source_time: envelope.source_time,
  });

  if (decision.action === 'apply') {
    const booking = await upsertExternalBooking(em, {
      connectionId: envelope.connection_id,
      channelKey: envelope.channel_key,
      externalBookingId: envelope.external_booking_id,
      providerBookingId: envelope.provider_booking_id,
      state: envelope.revision_type === 'cancelled' ? 'CANCELLED' : 'ACTIVE',
      latestRevisionId: envelope.provider_revision_id,
      latestPayloadHash: envelope.payload_hash,
      sourceSequence: envelope.source_sequence,
      sourceTime: envelope.source_time,
      exceptionId: null,
    });
    await updateInboxRevision(em, row.id, {
      processingState: 'APPLIED',
      externalBookingRef: booking.id,
      appliedAt: options.receivedAt,
    });
    return {
      status: 'APPLIED',
      inboxId: row.id,
      externalBookingId: booking.id,
      exceptionId: null,
      decision,
      created: true,
    };
  }

  if (decision.action === 'duplicate') {
    await updateInboxRevision(em, row.id, { processingState: 'DUPLICATE' });
    return {
      status: 'DUPLICATE',
      inboxId: row.id,
      externalBookingId: null,
      exceptionId: null,
      decision,
      created: true,
    };
  }

  if (decision.action === 'stale') {
    await updateInboxRevision(em, row.id, {
      processingState: 'IGNORED_STALE',
      safeErrorCode: decision.reason,
    });
    return {
      status: 'IGNORED_STALE',
      inboxId: row.id,
      externalBookingId: null,
      exceptionId: null,
      decision,
      created: true,
    };
  }

  const exception = await openException(em, {
    tenantId: options.tenantId,
    propertyId: options.propertyId,
    connectionId: envelope.connection_id,
    inboxRevisionId: row.id,
    outboxId: null,
    type: decision.reason,
    detailsSafe: { provider_revision_id: envelope.provider_revision_id },
  });
  await updateInboxRevision(em, row.id, {
    processingState: 'EXCEPTION',
    exceptionId: exception.id,
    safeErrorCode: decision.reason,
  });
  return {
    status: 'EXCEPTION',
    inboxId: row.id,
    externalBookingId: null,
    exceptionId: exception.id,
    decision,
    created: true,
  };
}

export async function reprocessInboxRevision(
  em: EntityManager,
  inboxId: string,
  options: StoreOptions,
): Promise<InboxRow> {
  const row = await findInboxRevisionByIdForUpdate(em, inboxId);
  if (!row) throw new Error('Inbox revision not found');
  if (row.processing_state !== 'EXCEPTION')
    throw new Error('Only EXCEPTION revisions can be reprocessed');
  const envelope = row.payload_safe as ChannelRevisionEnvelope;
  const mappingResults = await resolveMappings(em, envelope);
  if (mappingResults.some((result) => !result.found)) return row;
  const current = currentState(
    await findExternalBookingForUpdate(
      em,
      envelope.connection_id,
      envelope.external_booking_id,
    ),
  );
  const decision = decideRevisionApplication(current, {
    provider_revision_id: envelope.provider_revision_id,
    payload_hash: envelope.payload_hash,
    revision_type: envelope.revision_type,
    source_sequence: envelope.source_sequence,
    source_time: envelope.source_time,
  });
  if (decision.action !== 'apply') return row;
  const booking = await upsertExternalBooking(em, {
    connectionId: envelope.connection_id,
    channelKey: envelope.channel_key,
    externalBookingId: envelope.external_booking_id,
    providerBookingId: envelope.provider_booking_id,
    state: envelope.revision_type === 'cancelled' ? 'CANCELLED' : 'ACTIVE',
    latestRevisionId: envelope.provider_revision_id,
    latestPayloadHash: envelope.payload_hash,
    sourceSequence: envelope.source_sequence,
    sourceTime: envelope.source_time,
    exceptionId: null,
  });
  return updateInboxRevision(em, row.id, {
    processingState: 'APPLIED',
    externalBookingRef: booking.id,
    appliedAt: options.receivedAt,
    safeErrorCode: null,
  });
}
