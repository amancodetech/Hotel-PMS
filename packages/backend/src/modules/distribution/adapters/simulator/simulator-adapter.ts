import {
  assertActivationAllowed,
  assertPushCapability,
} from '../../domain/capabilities.js';
import type {
  AcknowledgeResult,
  AdapterRequestMeta,
  AvailabilitySnapshot,
  CapabilityEvidence,
  ChannelAdapter,
  ChannelProfile,
  ChannelRevisionEnvelope,
  ConnectionContext,
  MappingSnapshot,
  ProviderStateScope,
  PullPage,
  PushResultEnvelope,
  RestrictionSnapshot,
} from '@hotel/contracts';
import {
  parseAvailabilitySnapshot,
  parseChannelRevisionEnvelope,
  parseConnectionContext,
  parseMappingSnapshot,
  parsePushResultEnvelope,
  parseRestrictionSnapshot,
  ValidationError,
} from '../../domain/index.js';
import type { SimulatorEngine } from './engine.js';
import { simulatorAdapterVersion, simulatorTestProfile } from './fixtures.js';

export interface SimulatorAdapterOptions {
  engine: SimulatorEngine;
  allowedChannelKeys: readonly string[];
  defaultProfile?: (context: ConnectionContext) => ChannelProfile;
}

export class SimulatorAdapter implements ChannelAdapter {
  readonly provider_key = 'simulator';
  readonly adapter_version = simulatorAdapterVersion;
  private readonly engine: SimulatorEngine;
  private readonly allowedChannelKeys: ReadonlySet<string>;
  private readonly defaultProfile: (
    context: ConnectionContext,
  ) => ChannelProfile;
  private readonly profileCache = new Map<string, ChannelProfile>();

  constructor(options: SimulatorAdapterOptions) {
    this.engine = options.engine;
    this.allowedChannelKeys = new Set(options.allowedChannelKeys);
    this.defaultProfile =
      options.defaultProfile ??
      ((context) => simulatorTestProfile(context.channel_key));
  }

  private profileFor(context: ConnectionContext): ChannelProfile {
    const cached = this.profileCache.get(context.channel_key);
    if (cached) return cached;
    const base = this.defaultProfile(context);
    const payload = this.engine.capabilitySnapshot();
    const profile =
      payload === null || payload === undefined
        ? base
        : {
            ...base,
            capabilities: Array.isArray(payload)
              ? (payload as CapabilityEvidence[])
              : [],
          };
    this.profileCache.set(context.channel_key, profile);
    return profile;
  }

  async inspectCapabilities(
    context: ConnectionContext,
    _meta: AdapterRequestMeta,
  ): Promise<CapabilityEvidence[]> {
    parseConnectionContext(context);
    const payload = this.engine.capabilityPayload();
    if (payload === null || payload === undefined)
      return this.profileFor(context).capabilities;
    if (!Array.isArray(payload))
      throw new ValidationError('Simulator capabilities must be an array');
    return payload as CapabilityEvidence[];
  }

  async inspectMappings(
    context: ConnectionContext,
    _meta: AdapterRequestMeta,
  ): Promise<MappingSnapshot> {
    parseConnectionContext(context);
    assertPushCapability(this.profileFor(context), 'mapping');
    const snapshot = this.engine.mappingSnapshot(context.channel_key);
    return parseMappingSnapshot({
      ...snapshot,
      connection_id: snapshot.connection_id || context.connection_id,
      channel_key: context.channel_key,
    });
  }

  async pullRevisions(
    context: ConnectionContext,
    cursor: string | null,
    limit: number,
    _meta: AdapterRequestMeta,
  ): Promise<PullPage> {
    parseConnectionContext(context);
    assertPushCapability(this.profileFor(context), 'inbound_new');
    const page = this.engine.pullPage(context.channel_key, cursor, limit);
    return {
      revisions: page.revisions.map((revision) =>
        this.validateEnvelope(revision, context),
      ),
      next_cursor: page.next_cursor,
    };
  }

  async acknowledgeRevision(
    context: ConnectionContext,
    providerRevisionId: string,
    _meta: AdapterRequestMeta,
  ): Promise<AcknowledgeResult> {
    parseConnectionContext(context);
    assertPushCapability(this.profileFor(context), 'recovery');
    if (!providerRevisionId || providerRevisionId.length > 200)
      throw new ValidationError('Invalid revision id for acknowledge');
    return this.engine.acknowledge(providerRevisionId);
  }

  async pushAvailability(
    context: ConnectionContext,
    snapshot: AvailabilitySnapshot,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    const parsed = parseAvailabilitySnapshot(snapshot);
    this.assertSnapshotContext(
      context,
      parsed.connection_id,
      parsed.channel_key,
    );
    assertPushCapability(this.profileFor(context), 'absolute_availability');
    return parsePushResultEnvelope(
      this.engine.push(
        'pushAvailability',
        parsed.cells.map((cell) => `${cell.product_ref}:${cell.date}`),
      ),
    );
  }

  async pushRestrictions(
    context: ConnectionContext,
    snapshot: RestrictionSnapshot,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    const parsed = parseRestrictionSnapshot(snapshot);
    this.assertSnapshotContext(
      context,
      parsed.connection_id,
      parsed.channel_key,
    );
    assertPushCapability(this.profileFor(context), 'rates');
    return parsePushResultEnvelope(
      this.engine.push(
        'pushRestrictions',
        parsed.cells.map((cell) => `${cell.rate_ref}:${cell.date}`),
      ),
    );
  }

  async readProviderState(
    context: ConnectionContext,
    scope: ProviderStateScope,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    assertPushCapability(this.profileFor(context), 'readback');
    return parsePushResultEnvelope(
      this.engine.readProviderState(
        scope.product_refs.map((ref) => `${ref}:${scope.date_from}`),
      ),
    );
  }

  async readChannelEvidence(
    context: ConnectionContext,
    scope: ProviderStateScope,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    assertPushCapability(this.profileFor(context), 'd20_withdraw_evidence');
    return parsePushResultEnvelope(
      this.engine.readChannelEvidence(
        scope.product_refs.map((ref) => `${ref}:${scope.date_from}`),
      ),
    );
  }

  assertActivatable(context: ConnectionContext): void {
    assertActivationAllowed(this.profileFor(context));
  }

  private validateEnvelope(
    revision: ChannelRevisionEnvelope,
    context: ConnectionContext,
  ): ChannelRevisionEnvelope {
    return parseChannelRevisionEnvelope(
      {
        ...revision,
        provider_key: this.provider_key,
        environment: context.environment,
        connection_id: context.connection_id,
        channel_key: context.channel_key,
      },
      {
        allowedProviderKeys: new Set([this.provider_key]),
        allowedChannelKeys: this.allowedChannelKeys,
      },
    );
  }

  private assertSnapshotContext(
    context: ConnectionContext,
    snapshotConnectionId: string,
    snapshotChannelKey: string,
  ): void {
    if (
      snapshotConnectionId !== context.connection_id ||
      snapshotChannelKey !== context.channel_key
    )
      throw new ValidationError('Snapshot does not match the connection');
  }
}
