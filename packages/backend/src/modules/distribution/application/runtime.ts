import type { MikroORM } from '@mikro-orm/postgresql';
import type { ChannelProfile, ConnectionContext } from '@hotel/contracts';
import type { LogEvent, SafeLogFields } from '../../../logging.js';
import type { AdapterResolver } from '../domain/ports.js';
import { dispatchDueEvents } from './dispatcher.js';
import type { DispatchSummary, DispatcherOptions } from './dispatcher.js';
import { processPendingAcks } from './ack-service.js';
import type { AckSummary, AckTarget } from './ack-service.js';
import { findConnection } from '../persistence/connection-repository.js';
import { listDistributionWorkTenants } from '../persistence/work-repository.js';
import { pullRevisionsOnce } from './pull-service.js';
import type { PullSummary } from './pull-service.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';

export interface DistributionRuntimeOptions {
  orm: MikroORM;
  registry: AdapterResolver;
  profileFor: (context: ConnectionContext) => ChannelProfile;
  owner: string;
  maxAttempts?: number;
  leaseMs?: number;
  now?: () => string;
  logger?: (event: LogEvent, fields?: Omit<SafeLogFields, 'service'>) => void;
  connectionScope?: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
  };
  beforeScopedTick?: () => Promise<void>;
}

export interface TickSummary {
  dispatch: DispatchSummary;
  ack: AckSummary;
}

const emptyDispatch = (): DispatchSummary => ({
  leased: 0,
  acknowledged: 0,
  channelVerified: 0,
  partial: 0,
  retried: 0,
  deadLettered: 0,
  notSent: 0,
  lost: 0,
});

const emptyAck = (): AckSummary => ({
  processed: 0,
  sent: 0,
  retryable: 0,
  rejected: 0,
  exhausted: 0,
  recovered: 0,
  lost: 0,
});

export class DistributionRuntime {
  private readonly options: DistributionRuntimeOptions;

  constructor(options: DistributionRuntimeOptions) {
    this.options = options;
  }

  private dispatcherOptions(tenantId: string): DispatcherOptions {
    return {
      orm: this.options.orm,
      registry: this.options.registry,
      profileFor: this.options.profileFor,
      owner: this.options.owner,
      tenantId,
      connectionId: this.options.connectionScope?.connectionId,
      limit: this.options.connectionScope ? 10 : undefined,
      maxAttempts: this.options.maxAttempts,
      leaseMs: this.options.leaseMs,
      now: this.options.now,
    };
  }

  async tick(): Promise<TickSummary> {
    await this.options.beforeScopedTick?.();
    const tenants = this.options.connectionScope
      ? [this.options.connectionScope.tenantId]
      : await listDistributionWorkTenants(
          this.options.orm,
          this.options.maxAttempts ?? 4,
        );
    const totals: TickSummary = {
      dispatch: emptyDispatch(),
      ack: emptyAck(),
    };
    for (const tenantId of tenants) {
      const dispatch = await dispatchDueEvents(
        this.dispatcherOptions(tenantId),
      );
      if (
        this.options.connectionScope &&
        (dispatch.retried ||
          dispatch.deadLettered ||
          dispatch.notSent ||
          dispatch.lost ||
          dispatch.partial)
      )
        throw new Error('Scoped distribution dispatch unresolved');
      const ack = await processPendingAcks({
        orm: this.options.orm,
        tenantId,
        connectionId: this.options.connectionScope?.connectionId,
        limit: this.options.connectionScope ? 10 : undefined,
        resolveTarget: (connectionId) =>
          this.resolveAckTargetForTenant(tenantId, connectionId),
        maxAttempts: this.options.maxAttempts,
        leaseMs: this.options.leaseMs,
        owner: this.options.owner,
        now: this.options.now,
      }).catch((error: unknown) => {
        if (this.options.connectionScope) throw error;
        return emptyAck();
      });
      for (const key of Object.keys(totals.dispatch) as Array<
        keyof DispatchSummary
      >)
        totals.dispatch[key] += dispatch[key];
      for (const key of Object.keys(totals.ack) as Array<keyof AckSummary>)
        totals.ack[key] += ack[key];
    }
    return totals;
  }

  private targetFromConnection(
    connection: Awaited<ReturnType<typeof findConnection>>,
  ): AckTarget | null {
    if (!connection) return null;
    const adapter = this.options.registry.resolve(connection.provider_key);
    const context: ConnectionContext = {
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
    return {
      adapter,
      context,
      profile: this.options.profileFor(context),
      tenantId: connection.tenant_id,
      propertyId: connection.property_id,
    };
  }

  async resolveAckTargetForTenant(
    tenantId: string,
    connectionId: string,
  ): Promise<AckTarget | null> {
    const connection = await runScopedTransaction(
      this.options.orm,
      { tenantId },
      (em) => findConnection(em, connectionId),
    );
    return this.targetFromConnection(connection);
  }

  async resolveAckTarget(connectionId: string): Promise<AckTarget | null> {
    const connection = await this.options.orm.em
      .fork()
      .transactional((em) => findConnection(em, connectionId));
    return this.targetFromConnection(connection);
  }

  async pullConnection(
    context: ConnectionContext,
    tenantId: string,
    propertyId: string,
    limit = 50,
  ): Promise<PullSummary> {
    const adapter = this.options.registry.resolveForContext(context);
    return pullRevisionsOnce({
      orm: this.options.orm,
      adapter,
      context,
      profile: this.options.profileFor(context),
      tenantId,
      propertyId,
      limit,
      now: this.options.now,
    });
  }

  startScheduler(intervalMs = 5000): () => void {
    const timer = setInterval(() => {
      void this.tick()
        .then((summary) =>
          this.options.logger?.('distribution_tick', {
            acknowledged: summary.dispatch.acknowledged,
            retried: summary.dispatch.retried,
            dead_lettered: summary.dispatch.deadLettered,
            ack_sent: summary.ack.sent,
          }),
        )
        .catch(() =>
          this.options.logger?.('distribution_tick_failed', {
            code: 'TICK_FAILED',
          }),
        );
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
