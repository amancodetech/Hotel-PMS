import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  AcknowledgeResult,
  ChannelAdapter,
  ChannelProfile,
  ConnectionContext,
} from '@hotel/contracts';
import { computeBackoffMs } from '../domain/backoff.js';
import { isProviderAccepted } from '../domain/certainty.js';
import { ValidationError } from '../domain/errors.js';
import { toSafeRef } from '../domain/safety.js';
import {
  findLatestExceptionForInbox,
  openException,
} from '../persistence/exception-repository.js';
import { findConnection } from '../persistence/connection-repository.js';
import {
  claimPendingAck,
  listUnrecoveredExhaustedAcks,
  renewAckLease,
  requeueAckRevision,
  sweepExhaustedAcks,
  updateAckResult,
  updateInboxRevision,
} from '../persistence/inbox-repository.js';
import type { InboxRow } from '../persistence/types.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';

export interface AckTarget {
  adapter: ChannelAdapter;
  context: ConnectionContext;
  profile: ChannelProfile;
  tenantId: string;
  propertyId: string;
}

export interface AckOnceOptions {
  connectionId?: string;
  orm: MikroORM;
  tenantId?: string;
  resolveTarget: (connectionId: string) => Promise<AckTarget | null>;
  limit?: number;
  maxAttempts?: number;
  leaseMs?: number;
  owner?: string;
  now?: () => string;
}

export interface AckSummary {
  processed: number;
  sent: number;
  retryable: number;
  rejected: number;
  exhausted: number;
  recovered: number;
  lost: number;
}

const defaultNow = () => new Date().toISOString();

function scopedTransaction<T>(
  options: AckOnceOptions,
  tenantId: string | null | undefined,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  if (!tenantId) return options.orm.em.fork().transactional(work);
  return runScopedTransaction(options.orm, { tenantId }, work);
}

export interface AckApplication {
  ackState: 'SENT' | 'UNKNOWN' | 'FAILED';
  ackProviderRequestId: string | null;
  exceptionType: 'ACK_REJECTED' | 'ACK_EXHAUSTED' | null;
  nextAttemptAt: string | null;
}

export function applyAckResult(
  row: InboxRow,
  result: AcknowledgeResult,
  maxAttempts: number,
  nowIso: string,
): AckApplication {
  if (isProviderAccepted(result.certainty))
    return {
      ackState: 'SENT',
      ackProviderRequestId: toSafeRef(result.provider_request_id),
      exceptionType: null,
      nextAttemptAt: null,
    };
  if (result.certainty === 'REJECTED')
    return {
      ackState: 'FAILED',
      ackProviderRequestId: toSafeRef(result.provider_request_id),
      exceptionType: 'ACK_REJECTED',
      nextAttemptAt: null,
    };
  if (row.ack_attempt_count >= maxAttempts)
    return {
      ackState: 'UNKNOWN',
      ackProviderRequestId: null,
      exceptionType: 'ACK_EXHAUSTED',
      nextAttemptAt: null,
    };
  return {
    ackState: 'UNKNOWN',
    ackProviderRequestId: null,
    exceptionType: null,
    nextAttemptAt: new Date(
      Date.parse(nowIso) +
        computeBackoffMs(row.ack_attempt_count, result.retry_after_ms, row.id),
    ).toISOString(),
  };
}

export async function processPendingAcks(
  options: AckOnceOptions,
): Promise<AckSummary> {
  const now = options.now ?? defaultNow;
  const limit = options.limit ?? 50;
  const maxAttempts = options.maxAttempts ?? 4;
  const leaseMs = options.leaseMs ?? 30_000;
  const owner = options.owner ?? 'ack-worker';
  const summary: AckSummary = {
    processed: 0,
    sent: 0,
    retryable: 0,
    rejected: 0,
    exhausted: 0,
    recovered: 0,
    lost: 0,
  };

  await scopedTransaction(options, options.tenantId, async (em) => {
    const legacy = await listUnrecoveredExhaustedAcks(em, {
      connectionId: options.connectionId,
      maxAttempts,
      limit,
    });
    for (const row of legacy) {
      const existing = await findLatestExceptionForInbox(
        em,
        row.id,
        'ACK_EXHAUSTED',
      );
      const exception =
        existing ??
        (await openException(em, {
          tenantId: row.tenant_id ?? row.provider_key,
          propertyId: row.property_id ?? row.connection_id,
          connectionId: row.connection_id,
          inboxRevisionId: row.id,
          outboxId: null,
          type: 'ACK_EXHAUSTED',
          detailsSafe: {
            provider_revision_id: row.provider_revision_id,
            attempts: row.ack_attempt_count,
            abandoned: true,
            recovered: true,
          },
        }));
      await updateInboxRevision(em, row.id, {
        ackState: 'UNKNOWN',
        ackExceptionId: exception.id,
      });
      summary.recovered += 1;
    }
  });

  await scopedTransaction(options, options.tenantId, async (em) => {
    const swept = await sweepExhaustedAcks(em, {
      connectionId: options.connectionId,
      maxAttempts,
      now: now(),
      limit,
    });
    for (const row of swept) {
      const connection = await findConnection(em, row.connection_id);
      const exception = await openException(em, {
        tenantId: connection?.tenant_id ?? row.provider_key,
        propertyId: connection?.property_id ?? row.connection_id,
        connectionId: row.connection_id,
        inboxRevisionId: row.id,
        outboxId: null,
        type: 'ACK_EXHAUSTED',
        detailsSafe: {
          provider_revision_id: row.provider_revision_id,
          attempts: row.ack_attempt_count,
          abandoned: true,
        },
      });
      await updateInboxRevision(em, row.id, {
        ackExceptionId: exception.id,
      });
      summary.exhausted += 1;
    }
  });

  const claimed = await scopedTransaction(options, options.tenantId, (em) =>
    claimPendingAck(em, {
      connectionId: options.connectionId,
      owner,
      limit,
      maxAttempts,
      now: now(),
      leaseMs,
    }),
  );

  for (const row of claimed) {
    const token = row.ack_lease_token ?? '';
    const renewed = await scopedTransaction(options, options.tenantId, (em) =>
      renewAckLease(em, {
        id: row.id,
        owner,
        token,
        now: now(),
        leaseMs,
      }),
    );
    if (!renewed) {
      summary.lost += 1;
      continue;
    }
    summary.processed += 1;
    const target = await options.resolveTarget(row.connection_id);
    let result: AcknowledgeResult;
    if (target === null) {
      result = {
        certainty: 'REJECTED',
        provider_request_id: null,
        observed_at: now(),
        safe_error_code: 'NOT_FOUND',
        retry_after_ms: null,
      };
    } else {
      try {
        result = await target.adapter.acknowledgeRevision(
          target.context,
          row.provider_revision_id,
          {
            deadline_ms: 10_000,
            correlation_id: `ack:${row.id}`,
          },
        );
      } catch {
        result = {
          certainty: 'UNKNOWN',
          provider_request_id: null,
          observed_at: now(),
          safe_error_code: 'UNKNOWN',
          retry_after_ms: null,
        };
      }
    }
    const applied = applyAckResult(row, result, maxAttempts, now());
    const tenantId = target?.tenantId ?? row.provider_key;
    const propertyId = target?.propertyId ?? row.connection_id;
    const disposition = await scopedTransaction(
      options,
      options.tenantId,
      async (em): Promise<'applied' | 'lost'> => {
        const updated = await updateAckResult(em, row.id, token, {
          ackState: applied.ackState,
          ackProviderRequestId: applied.ackProviderRequestId,
          ackNextAttemptAt: applied.nextAttemptAt,
        });
        if (!updated) return 'lost';
        if (applied.exceptionType !== null) {
          const exception = await openException(em, {
            tenantId,
            propertyId,
            connectionId: row.connection_id,
            inboxRevisionId: row.id,
            outboxId: null,
            type: applied.exceptionType,
            detailsSafe: {
              provider_revision_id: row.provider_revision_id,
              safe_error_code: result.safe_error_code,
            },
          });
          await updateInboxRevision(em, row.id, {
            ackExceptionId: exception.id,
          });
        }
        return 'applied';
      },
    );
    if (disposition === 'lost') {
      summary.lost += 1;
      continue;
    }
    if (applied.ackState === 'SENT') summary.sent += 1;
    else if (applied.exceptionType === 'ACK_EXHAUSTED') summary.exhausted += 1;
    else if (applied.exceptionType === 'ACK_REJECTED') summary.rejected += 1;
    else summary.retryable += 1;
  }
  return summary;
}

export interface RequeueAckOptions {
  orm: MikroORM;
  inboxRevisionId: string;
  by: string;
  reason: string;
}

export async function requeueExhaustedAck(
  options: RequeueAckOptions,
): Promise<InboxRow> {
  if (!options.by.trim() || !options.reason.trim())
    throw new ValidationError('Requeue requires an actor and a reason');
  return options.orm.em.fork().transactional(async (em) => {
    const row = await requeueAckRevision(em, options.inboxRevisionId);
    if (!row) throw new ValidationError('ACK revision is not requeueable');
    const connection = await findConnection(em, row.connection_id);
    await openException(em, {
      tenantId: connection?.tenant_id ?? row.provider_key,
      propertyId: connection?.property_id ?? row.connection_id,
      connectionId: row.connection_id,
      inboxRevisionId: row.id,
      outboxId: null,
      type: 'ACK_REQUEUED',
      detailsSafe: {
        by: options.by.trim().slice(0, 64),
        reason: options.reason.slice(0, 200),
      },
    });
    return row;
  });
}
