import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  AvailabilitySnapshot,
  ChannelAdapter,
  ChannelProfile,
  ConnectionContext,
  PushResultEnvelope,
  RestrictionSnapshot,
} from '@hotel/contracts';
import { assertPushCapability } from '../domain/capabilities.js';
import { isProviderAccepted } from '../domain/certainty.js';
import { computeBackoffMs } from '../domain/backoff.js';
import { DistributionError, isRetryable } from '../domain/errors.js';
import { sanitizeWarningCodes, toSafeRef } from '../domain/safety.js';
import {
  parseAvailabilitySnapshot,
  parseRestrictionSnapshot,
} from '../domain/validation.js';
import type { AdapterResolver } from '../domain/ports.js';
import { findConnection } from '../persistence/connection-repository.js';
import { openException } from '../persistence/exception-repository.js';
import { insertDeadLetter } from '../persistence/dead-letter-repository.js';
import {
  incrementOutboxAttempt,
  leaseDueOutbox,
  renewOutboxLease,
  updateOutboxResult,
} from '../persistence/outbox-repository.js';
import type { OutboxFence } from '../persistence/outbox-repository.js';
import {
  finishAttempt,
  startAttempt,
} from '../persistence/attempt-repository.js';
import type { ConnectionRow, OutboxRow } from '../persistence/types.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';

export interface DispatcherOptions {
  connectionId?: string;
  orm: MikroORM;
  tenantId?: string;
  registry: AdapterResolver;
  profileFor: (context: ConnectionContext) => ChannelProfile;
  owner: string;
  tenantIdHint?: string;
  propertyIdHint?: string;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => string;
}

export interface DispatchSummary {
  leased: number;
  acknowledged: number;
  channelVerified: number;
  partial: number;
  retried: number;
  deadLettered: number;
  notSent: number;
  lost: number;
}

const defaultNow = () => new Date().toISOString();

function scopedTransaction<T>(
  options: DispatcherOptions,
  tenantId: string | null | undefined,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  if (!tenantId) return options.orm.em.fork().transactional(work);
  return runScopedTransaction(options.orm, { tenantId }, work);
}

function scopeFor(
  options: DispatcherOptions,
  event: { tenant_id: string },
): string {
  return options.tenantId ?? event.tenant_id;
}

function contextFor(
  connection: ConnectionRow,
  adapter: ChannelAdapter,
): ConnectionContext {
  return {
    connection_id: connection.id,
    tenant_id: connection.tenant_id,
    property_id: connection.property_id,
    provider_key: connection.provider_key,
    environment: connection.environment,
    channel_key: connection.channel_key,
    secret_ref: connection.secret_ref,
    external_property_id: connection.external_property_id,
    adapter_version: adapter.adapter_version,
  };
}

function buildSnapshot(
  event: OutboxRow,
  connectionId: string,
  channelKey: string,
): AvailabilitySnapshot | RestrictionSnapshot {
  const payload = (event.payload_safe ?? {}) as { cells?: unknown };
  const base = {
    schema_version: 1 as const,
    connection_id: connectionId,
    channel_key: channelKey,
    inventory_version: event.inventory_version,
    cells: payload.cells ?? [],
  };
  return event.event_type === 'AvailabilitySnapshot'
    ? parseAvailabilitySnapshot(base)
    : parseRestrictionSnapshot(base);
}

interface FailureOutcome {
  retryable: boolean;
  safeErrorCode: string;
  certainty: PushResultEnvelope['certainty'];
}

function failureOutcome(error: unknown): FailureOutcome {
  if (error instanceof DistributionError)
    return {
      retryable: isRetryable(error.code),
      safeErrorCode: error.code,
      certainty: isRetryable(error.code) ? 'UNKNOWN' : 'REJECTED',
    };
  return {
    retryable: true,
    safeErrorCode: 'UNKNOWN',
    certainty: 'UNKNOWN',
  };
}

type FailureDisposition = 'retry' | 'dead' | 'lost';

async function resolveAdapterContext(
  options: DispatcherOptions,
  event: OutboxRow,
): Promise<{
  adapter: ChannelAdapter;
  context: ConnectionContext;
  profile: ChannelProfile;
}> {
  const connection = await scopedTransaction(
    options,
    scopeFor(options, event),
    (em) => findConnection(em, event.connection_id),
  );
  if (!connection)
    throw new DistributionError('NOT_FOUND', 'Connection is missing', {
      connectionId: event.connection_id,
    });
  const adapter = options.registry.resolve(connection.provider_key);
  const context = contextFor(connection, adapter);
  const profile = options.profileFor(context);
  return { adapter, context, profile };
}

async function recordPreparationFailure(
  options: DispatcherOptions,
  event: OutboxRow,
  fence: OutboxFence,
  outcome: FailureOutcome,
  nowIso: string,
): Promise<FailureDisposition> {
  const maxAttempts = options.maxAttempts ?? 5;
  return scopedTransaction(options, scopeFor(options, event), async (em) => {
    const incremented = await incrementOutboxAttempt(em, event.id, fence);
    if (!incremented) return 'lost';
    const attemptNo = incremented.attempt_count;
    const permanent = !outcome.retryable;
    const dead = permanent || attemptNo >= maxAttempts;
    await startAttempt(em, {
      outboxId: event.id,
      attemptNo,
      startedAt: nowIso,
    });
    await finishAttempt(em, event.id, attemptNo, {
      status: permanent ? 'REJECTED' : 'FAILED',
      certainty: permanent ? 'REJECTED' : 'UNKNOWN',
      httpStatus: null,
      providerRequestId: null,
      providerTaskId: null,
      safeErrorCode: outcome.safeErrorCode,
      retryAfterMs: null,
      finishedAt: nowIso,
      responseSafe: { phase: 'PREPARATION' },
    });
    const reason = permanent ? 'PREPARATION_FAILED' : 'ATTEMPTS_EXHAUSTED';
    if (!dead) {
      const updated = await updateOutboxResult(
        em,
        event.id,
        {
          status: 'RETRY_SCHEDULED',
          safeErrorCode: outcome.safeErrorCode,
          nextAttemptAt: new Date(
            Date.parse(nowIso) + computeBackoffMs(attemptNo, null, event.id),
          ).toISOString(),
          clearLease: true,
        },
        { fence },
      );
      return updated ? 'retry' : 'lost';
    }
    const updated = await updateOutboxResult(
      em,
      event.id,
      {
        status: 'DEAD_LETTER',
        safeErrorCode: outcome.safeErrorCode,
        clearLease: true,
      },
      { fence },
    );
    if (!updated) return 'lost';
    await insertDeadLetter(em, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      connectionId: event.connection_id,
      outboxId: event.id,
      eventType: event.event_type,
      payloadSafe: event.payload_safe,
      safeErrorCode: outcome.safeErrorCode,
      attempts: attemptNo,
      reason,
    });
    await openException(em, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      connectionId: event.connection_id,
      inboxRevisionId: null,
      outboxId: event.id,
      type: reason,
      detailsSafe: {
        safe_error_code: outcome.safeErrorCode,
        phase: 'PREPARATION',
      },
    });
    return 'dead';
  });
}

function countPreparationDisposition(
  summary: DispatchSummary,
  disposition: FailureDisposition,
): void {
  if (disposition === 'retry') summary.retried += 1;
  else if (disposition === 'dead') summary.deadLettered += 1;
  else summary.lost += 1;
}

export async function dispatchDueEvents(
  options: DispatcherOptions,
): Promise<DispatchSummary> {
  const now = options.now ?? defaultNow;
  const maxAttempts = options.maxAttempts ?? 5;
  const leaseMs = options.leaseMs ?? 30_000;
  const summary: DispatchSummary = {
    leased: 0,
    acknowledged: 0,
    channelVerified: 0,
    partial: 0,
    retried: 0,
    deadLettered: 0,
    notSent: 0,
    lost: 0,
  };
  const leased = await scopedTransaction(options, options.tenantId, (em) =>
    leaseDueOutbox(em, {
      connectionId: options.connectionId,
      owner: options.owner,
      limit: options.limit ?? 25,
      now: now(),
      leaseMs,
    }),
  );
  summary.leased = leased.length;

  for (const event of leased) {
    if (!event.lease_token) {
      summary.lost += 1;
      continue;
    }
    const fence: OutboxFence = {
      owner: options.owner,
      token: event.lease_token,
    };
    const renewed = await scopedTransaction(
      options,
      scopeFor(options, event),
      (em) =>
        renewOutboxLease(em, {
          id: event.id,
          owner: fence.owner,
          token: fence.token,
          now: now(),
          leaseMs,
        }),
    );
    if (!renewed) {
      summary.lost += 1;
      continue;
    }

    let adapter: ChannelAdapter;
    let context: ConnectionContext;
    let profile: ChannelProfile;
    let snapshot: AvailabilitySnapshot | RestrictionSnapshot;
    try {
      ({ adapter, context, profile } = await resolveAdapterContext(
        options,
        event,
      ));
      assertPushCapability(
        profile,
        event.event_type === 'AvailabilitySnapshot'
          ? 'absolute_availability'
          : 'rates',
      );
      snapshot = buildSnapshot(
        event,
        context.connection_id,
        context.channel_key,
      );
    } catch (error) {
      const disposition = await recordPreparationFailure(
        options,
        event,
        fence,
        failureOutcome(error),
        now(),
      );
      countPreparationDisposition(summary, disposition);
      continue;
    }

    const startedAt = now();
    const attemptNo = await scopedTransaction(
      options,
      scopeFor(options, event),
      async (em) => {
        const incremented = await incrementOutboxAttempt(em, event.id, fence);
        if (!incremented) return null;
        await startAttempt(em, {
          outboxId: event.id,
          attemptNo: incremented.attempt_count,
          startedAt,
        });
        return incremented.attempt_count;
      },
    );
    if (attemptNo === null) {
      summary.lost += 1;
      continue;
    }

    let result: PushResultEnvelope;
    try {
      result =
        event.event_type === 'AvailabilitySnapshot'
          ? await adapter.pushAvailability(
              context,
              snapshot as AvailabilitySnapshot,
              { deadline_ms: 15_000, correlation_id: `dispatch:${event.id}` },
            )
          : await adapter.pushRestrictions(
              context,
              snapshot as RestrictionSnapshot,
              { deadline_ms: 15_000, correlation_id: `dispatch:${event.id}` },
            );
    } catch (error) {
      const outcome = failureOutcome(error);
      const finishedAt = now();
      const disposition = await scopedTransaction(
        options,
        scopeFor(options, event),
        async (em): Promise<FailureDisposition> => {
          await finishAttempt(em, event.id, attemptNo, {
            status: outcome.retryable ? 'FAILED' : 'REJECTED',
            certainty: outcome.certainty,
            httpStatus: null,
            providerRequestId: null,
            providerTaskId: null,
            safeErrorCode: outcome.safeErrorCode,
            retryAfterMs: null,
            finishedAt,
            responseSafe: { phase: 'SEND' },
          });
          if (outcome.retryable && attemptNo < maxAttempts) {
            const updated = await updateOutboxResult(
              em,
              event.id,
              {
                status: 'RETRY_SCHEDULED',
                safeErrorCode: outcome.safeErrorCode,
                nextAttemptAt: new Date(
                  Date.parse(finishedAt) +
                    computeBackoffMs(attemptNo, null, event.id),
                ).toISOString(),
                clearLease: true,
              },
              { fence },
            );
            return updated ? 'retry' : 'lost';
          }
          const updated = await updateOutboxResult(
            em,
            event.id,
            {
              status: 'DEAD_LETTER',
              safeErrorCode: outcome.safeErrorCode,
              clearLease: true,
            },
            { fence },
          );
          if (!updated) return 'lost';
          const reason = outcome.retryable
            ? 'ATTEMPTS_EXHAUSTED'
            : 'PERMANENT_FAILURE';
          await insertDeadLetter(em, {
            tenantId: event.tenant_id,
            propertyId: event.property_id,
            connectionId: event.connection_id,
            outboxId: event.id,
            eventType: event.event_type,
            payloadSafe: event.payload_safe,
            safeErrorCode: outcome.safeErrorCode,
            attempts: attemptNo,
            reason,
          });
          await openException(em, {
            tenantId: event.tenant_id,
            propertyId: event.property_id,
            connectionId: event.connection_id,
            inboxRevisionId: null,
            outboxId: event.id,
            type: reason,
            detailsSafe: { safe_error_code: outcome.safeErrorCode },
          });
          return 'dead';
        },
      );
      countPreparationDisposition(summary, disposition);
      continue;
    }

    const certainty = result.certainty;
    const accepted = isProviderAccepted(certainty);
    const withinBudget = attemptNo < maxAttempts;
    let status:
      'ACKNOWLEDGED' | 'CHANNEL_VERIFIED' | 'RETRY_SCHEDULED' | 'DEAD_LETTER' =
      'RETRY_SCHEDULED';
    if (certainty === 'CHANNEL_VERIFIED') status = 'CHANNEL_VERIFIED';
    else if (certainty === 'PROVIDER_ACCEPTED') status = 'ACKNOWLEDGED';
    else if (!withinBudget) status = 'DEAD_LETTER';
    else if (certainty === 'REJECTED') status = 'DEAD_LETTER';
    else status = 'RETRY_SCHEDULED';

    const safeWarnings = sanitizeWarningCodes(result.warnings);
    const safeRequestId = toSafeRef(result.provider_request_id);
    const safeTaskId = toSafeRef(result.provider_task_id);
    const finishedAt = now();
    const disposition = await scopedTransaction(
      options,
      scopeFor(options, event),
      async (em): Promise<FailureDisposition> => {
        await finishAttempt(em, event.id, attemptNo, {
          status: accepted
            ? 'SUCCEEDED'
            : status === 'DEAD_LETTER'
              ? 'REJECTED'
              : 'UNKNOWN',
          certainty,
          httpStatus: null,
          providerRequestId: safeRequestId,
          providerTaskId: safeTaskId,
          safeErrorCode: result.safe_error_code,
          retryAfterMs: result.retry_after_ms,
          finishedAt,
          responseSafe: {
            phase: 'SEND',
            warnings: safeWarnings,
            cell_results: result.cell_results.slice(0, 100),
          },
        });
        const updated = await updateOutboxResult(
          em,
          event.id,
          {
            status,
            certainty,
            safeErrorCode: result.safe_error_code,
            providerRequestId: safeRequestId,
            providerTaskId: safeTaskId,
            nextAttemptAt:
              status === 'RETRY_SCHEDULED'
                ? new Date(
                    Date.parse(finishedAt) +
                      computeBackoffMs(
                        attemptNo,
                        result.retry_after_ms,
                        event.id,
                      ),
                  ).toISOString()
                : null,
            clearLease: true,
          },
          { fence },
        );
        if (!updated) return 'lost';
        if (status === 'DEAD_LETTER')
          await insertDeadLetter(em, {
            tenantId: event.tenant_id,
            propertyId: event.property_id,
            connectionId: event.connection_id,
            outboxId: event.id,
            eventType: event.event_type,
            payloadSafe: event.payload_safe,
            safeErrorCode: result.safe_error_code,
            attempts: attemptNo,
            reason:
              certainty === 'REJECTED'
                ? 'REJECTED_BY_PROVIDER'
                : 'ATTEMPTS_EXHAUSTED',
          });
        return 'retry';
      },
    );

    if (disposition === 'lost') {
      summary.lost += 1;
      continue;
    }
    if (certainty === 'PARTIAL') summary.partial += 1;
    if (certainty === 'NOT_SENT') summary.notSent += 1;
    if (status === 'CHANNEL_VERIFIED') summary.channelVerified += 1;
    else if (status === 'ACKNOWLEDGED') summary.acknowledged += 1;
    else if (status === 'RETRY_SCHEDULED') summary.retried += 1;
    else summary.deadLettered += 1;
  }
  return summary;
}
