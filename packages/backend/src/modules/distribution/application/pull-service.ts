import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  ChannelAdapter,
  ChannelProfile,
  ChannelRevisionEnvelope,
  ConnectionContext,
} from '@hotel/contracts';
import { StaleCursorError } from '../domain/errors.js';
import {
  getCheckpoint,
  setCheckpoint,
} from '../persistence/checkpoint-repository.js';
import { storeChannelRevision } from './inbox-store.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import type { StoreResult } from './inbox-store.js';

export type StoreRevisionFunction = (
  em: EntityManager,
  revision: ChannelRevisionEnvelope,
  options: { receivedAt: string; tenantId: string; propertyId: string },
) => Promise<StoreResult>;

export interface PullOnceOptions {
  orm: MikroORM;
  adapter: ChannelAdapter;
  context: ConnectionContext;
  profile: ChannelProfile;
  tenantId: string;
  propertyId: string;
  limit?: number;
  stream?: string;
  now?: () => string;
  store?: StoreRevisionFunction;
}

export interface PullSummary {
  fetched: number;
  stored: number;
  statuses: StoreResult['status'][];
  nextCursor: string | null;
  skippedStaleCursor: boolean;
}

const defaultNow = () => new Date().toISOString();
const defaultStream = 'revisions';

export async function pullRevisionsOnce(
  options: PullOnceOptions,
): Promise<PullSummary> {
  const now = options.now ?? defaultNow;
  const stream = options.stream ?? defaultStream;
  const limit = options.limit ?? 50;
  const store = options.store ?? storeChannelRevision;
  const checkpoint = await runScopedTransaction(
    options.orm,
    { tenantId: options.tenantId },
    (em) => getCheckpoint(em, options.context.connection_id, stream),
  );
  const page = await options.adapter.pullRevisions(
    options.context,
    checkpoint?.cursor ?? null,
    limit,
    {
      deadline_ms: 10_000,
      correlation_id: `pull:${options.context.connection_id}`,
    },
  );
  if (page.revisions.length === 0)
    return {
      fetched: 0,
      stored: 0,
      statuses: [],
      nextCursor: checkpoint?.cursor ?? null,
      skippedStaleCursor: false,
    };
  const statuses: StoreResult['status'][] = [];
  try {
    await runScopedTransaction(
      options.orm,
      { tenantId: options.tenantId },
      async (em) => {
        await em.execute('select pg_advisory_xact_lock(hashtext(?))', [
          `${options.context.connection_id}:${stream}`,
        ]);
        const locked = await getCheckpoint(
          em,
          options.context.connection_id,
          stream,
        );
        if ((locked?.cursor ?? null) !== (checkpoint?.cursor ?? null))
          throw new StaleCursorError(options.context.connection_id);
        for (const revision of page.revisions) {
          const result = await store(em, revision, {
            receivedAt: now(),
            tenantId: options.tenantId,
            propertyId: options.propertyId,
          });
          statuses.push(result.status);
        }
        await setCheckpoint(em, {
          connectionId: options.context.connection_id,
          stream,
          cursor: page.next_cursor,
          pulledAt: now(),
        });
      },
    );
  } catch (error) {
    if (error instanceof StaleCursorError)
      return {
        fetched: page.revisions.length,
        stored: 0,
        statuses: [],
        nextCursor: checkpoint?.cursor ?? null,
        skippedStaleCursor: true,
      };
    throw error;
  }
  return {
    fetched: page.revisions.length,
    stored: statuses.length,
    statuses,
    nextCursor: page.next_cursor,
    skippedStaleCursor: false,
  };
}
