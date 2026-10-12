import type {
  AcknowledgeResult,
  Certainty,
  ChannelRevisionEnvelope,
  MappingSnapshot,
  PushResultEnvelope,
  RevisionItem,
  RevisionType,
} from '@hotel/contracts';
import { DistributionError, ValidationError } from '../../domain/errors.js';
import { hashPayload } from '../../domain/hash.js';

export type SimulatorFailureKind =
  | 'timeout_after_send'
  | 'timeout_before_send'
  | 'rate_limited'
  | 'server_error'
  | 'validation_rejected'
  | 'auth_failed';

export type SimulatorOperation =
  | 'pullRevisions'
  | 'acknowledgeRevision'
  | 'pushAvailability'
  | 'pushRestrictions'
  | 'readProviderState'
  | 'readChannelEvidence'
  | 'inspectMappings'
  | 'inspectCapabilities';

export interface SimulatorFailurePlan {
  operation: SimulatorOperation;
  kind: SimulatorFailureKind;
  times: number;
  retry_after_ms?: number;
}

export interface SimulatorRevisionSeed {
  provider_revision_id: string;
  revision_type: RevisionType;
  external_booking_id: string;
  provider_booking_id?: string | null;
  source_sequence?: string | null;
  source_time?: string | null;
  channel_key?: string;
  items?: Partial<RevisionItem>[];
  amount_total?: string | null;
  currency?: string | null;
  commission_amount?: string | null;
  tax_amount?: string | null;
  net_amount?: string | null;
  meal_plan_ref?: string | null;
  occupancy?: number | null;
  unmapped_fields?: string[];
  payload_variant?: string | null;
}

export interface SimulatorScenarioOptions {
  seed: string;
  start_time?: string;
  revisions?: SimulatorRevisionSeed[];
  delivery_order?: string[];
  duplicate_deliveries?: number;
  failures?: SimulatorFailurePlan[];
  mappings?: MappingSnapshot | null;
  capabilities?: unknown;
  verified_channel?: boolean;
  rejected_cells?: string[];
  unknown_cells?: string[];
}

interface SimulatorClock {
  now(): string;
  advance(ms: number): void;
}

function defaultClock(startTime: string): SimulatorClock {
  const base = Date.parse(startTime);
  if (!Number.isFinite(base))
    throw new ValidationError('Invalid scenario start_time');
  let offset = 0;
  return {
    now: () => new Date(base + offset).toISOString(),
    advance: (ms) => {
      offset += ms;
    },
  };
}

export { hashPayload };

export class SimulatorEngine {
  readonly seed: string;
  private readonly clock: SimulatorClock;
  private readonly revisions: ChannelRevisionEnvelope[] = [];
  private readonly deliveryOrder: string[];
  private readonly duplicateDeliveries: number;
  private readonly failures = new Map<
    SimulatorOperation,
    SimulatorFailurePlan[]
  >();
  private readonly mappings: MappingSnapshot | null;
  private readonly capabilities: unknown;
  private readonly verifiedChannel: boolean;
  private readonly rejectedCells: Set<string>;
  private readonly unknownCells: Set<string>;
  private readonly acknowledged = new Map<string, AcknowledgeResult>();

  constructor(options: SimulatorScenarioOptions) {
    this.seed = options.seed;
    this.clock = defaultClock(options.start_time ?? '2026-09-13T00:00:00Z');
    this.duplicateDeliveries = options.duplicate_deliveries ?? 0;
    this.mappings = options.mappings ?? null;
    this.capabilities = options.capabilities ?? null;
    this.verifiedChannel = options.verified_channel ?? false;
    this.rejectedCells = new Set(options.rejected_cells ?? []);
    this.unknownCells = new Set(options.unknown_cells ?? []);
    for (const failure of options.failures ?? []) this.planFailure(failure);
    for (const seed of options.revisions ?? []) this.addRevision(seed);
    this.deliveryOrder = options.delivery_order
      ? [...options.delivery_order]
      : this.revisions.map((revision) => revision.provider_revision_id);
    const known = new Set(this.revisions.map((r) => r.provider_revision_id));
    for (const id of this.deliveryOrder)
      if (!known.has(id))
        throw new ValidationError(`Unknown revision in delivery_order: ${id}`);
  }

  now(): string {
    return this.clock.now();
  }

  advanceTime(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0)
      throw new ValidationError('advanceTime requires a non-negative integer');
    this.clock.advance(ms);
  }

  planFailure(plan: SimulatorFailurePlan): void {
    if (plan.times < 1)
      throw new ValidationError('Failure plan times must be positive');
    const list = this.failures.get(plan.operation) ?? [];
    list.push({ ...plan });
    this.failures.set(plan.operation, list);
  }

  addRevision(seed: SimulatorRevisionSeed): void {
    if (
      this.revisions.some(
        (revision) =>
          revision.provider_revision_id === seed.provider_revision_id,
      )
    )
      throw new ValidationError(
        `Duplicate revision id in scenario: ${seed.provider_revision_id}`,
      );
    const envelope = this.buildEnvelope(seed);
    this.revisions.push(envelope);
  }

  revisionIds(): string[] {
    return this.deliveryOrder.flatMap((id) =>
      Array.from({ length: this.duplicateDeliveries + 1 }, () => id),
    );
  }

  pullPage(
    channelKey: string,
    cursor: string | null,
    limit: number,
  ): { revisions: ChannelRevisionEnvelope[]; next_cursor: string | null } {
    const failure = this.consumeFailure('pullRevisions');
    if (failure) throw failure;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new ValidationError('Pull limit must be between 1 and 500');
    const offset = cursor === null ? 0 : this.decodeCursor(cursor);
    const ids = this.revisionIds();
    if (offset > ids.length)
      throw new ValidationError('Cursor is past the end of the feed');
    const selected = ids.slice(offset, offset + limit);
    const revisions = selected.map((id) => {
      const revision = this.revisions.find(
        (item) => item.provider_revision_id === id,
      );
      if (!revision) throw new ValidationError('Revision missing from feed');
      const received = { ...revision, received_at: this.clock.now() };
      return {
        ...received,
        channel_key: channelKey,
      };
    });
    const nextOffset = offset + selected.length;
    return {
      revisions,
      next_cursor:
        nextOffset < ids.length ? this.encodeCursor(nextOffset) : null,
    };
  }

  acknowledge(providerRevisionId: string): AcknowledgeResult {
    const failure = this.consumeFailure('acknowledgeRevision');
    if (failure) return this.resultFromFailure(failure);
    const existing = this.acknowledged.get(providerRevisionId);
    if (existing) return existing;
    const known = this.revisions.some(
      (revision) => revision.provider_revision_id === providerRevisionId,
    );
    if (!known)
      return {
        certainty: 'REJECTED',
        provider_request_id: null,
        observed_at: this.clock.now(),
        safe_error_code: 'NOT_FOUND',
        retry_after_ms: null,
      };
    const result: AcknowledgeResult = {
      certainty: 'PROVIDER_ACCEPTED',
      provider_request_id: `sim-ack-${hashPayload(providerRevisionId).slice(0, 16)}`,
      observed_at: this.clock.now(),
      safe_error_code: null,
      retry_after_ms: null,
    };
    this.acknowledged.set(providerRevisionId, result);
    return result;
  }

  push(
    operation: 'pushAvailability' | 'pushRestrictions',
    cellKeys: string[],
  ): PushResultEnvelope {
    const failure = this.consumeFailure(operation);
    if (failure) return this.pushFromFailure(failure, cellKeys);
    const cellResults = cellKeys.map((cellKey) => {
      if (this.rejectedCells.has(cellKey))
        return {
          cell_key: cellKey,
          status: 'REJECTED' as const,
          safe_error_code: 'VALIDATION_FAILED' as const,
        };
      if (this.unknownCells.has(cellKey))
        return {
          cell_key: cellKey,
          status: 'UNKNOWN' as const,
          safe_error_code: 'UNKNOWN' as const,
        };
      return {
        cell_key: cellKey,
        status: 'ACCEPTED' as const,
        safe_error_code: null,
      };
    });
    const requested = `sim-${operation}-${hashPayload(cellKeys).slice(0, 16)}`;
    const hasRejected = cellResults.some((cell) => cell.status === 'REJECTED');
    const hasUnknown = cellResults.some((cell) => cell.status !== 'ACCEPTED');
    const certainty: Certainty = hasRejected
      ? 'REJECTED'
      : hasUnknown
        ? 'PARTIAL'
        : 'PROVIDER_ACCEPTED';
    return {
      schema_version: 1,
      provider_request_id: requested,
      provider_task_id: null,
      observed_at: this.clock.now(),
      certainty,
      safe_error_code: hasRejected ? 'VALIDATION_FAILED' : null,
      retry_after_ms: null,
      warnings: hasUnknown ? ['PARTIAL_CELL_PROCESSING'] : [],
      cell_results: cellResults,
    };
  }

  readProviderState(cellKeys: string[]): PushResultEnvelope {
    return this.push('pushAvailability', cellKeys);
  }

  readChannelEvidence(cellKeys: string[]): PushResultEnvelope {
    const failure = this.consumeFailure('readChannelEvidence');
    if (failure) return this.pushFromFailure(failure, cellKeys);
    return {
      schema_version: 1,
      provider_request_id: null,
      provider_task_id: null,
      observed_at: this.clock.now(),
      certainty: this.verifiedChannel ? 'CHANNEL_VERIFIED' : 'UNKNOWN',
      safe_error_code: this.verifiedChannel ? null : 'UNKNOWN',
      retry_after_ms: null,
      warnings: this.verifiedChannel ? [] : ['CHANNEL_EVIDENCE_UNAVAILABLE'],
      cell_results: cellKeys.map((cellKey) => ({
        cell_key: cellKey,
        status: this.verifiedChannel ? 'ACCEPTED' : 'UNKNOWN',
        safe_error_code: this.verifiedChannel ? null : 'UNKNOWN',
      })),
    };
  }

  mappingSnapshot(channelKey: string): MappingSnapshot {
    const failure = this.consumeFailure('inspectMappings');
    if (failure) throw failure;
    if (!this.mappings)
      return {
        connection_id: '',
        channel_key: channelKey,
        mapping_version: 0,
        entries: [],
      };
    return { ...this.mappings, channel_key: channelKey };
  }

  capabilityPayload(): unknown {
    const failure = this.consumeFailure('inspectCapabilities');
    if (failure) throw failure;
    return this.capabilities;
  }

  capabilitySnapshot(): unknown {
    return this.capabilities;
  }

  private consumeFailure(
    operation: SimulatorOperation,
  ): DistributionError | null {
    const list = this.failures.get(operation);
    if (!list || list.length === 0) return null;
    const plan = list[0]!;
    plan.times -= 1;
    if (plan.times <= 0) list.shift();
    return this.errorFromKind(plan.kind);
  }

  private errorFromKind(kind: SimulatorFailureKind): DistributionError {
    switch (kind) {
      case 'timeout_before_send':
        return new DistributionError(
          'TIMEOUT',
          'Synthetic timeout before send',
        );
      case 'timeout_after_send':
        return new DistributionError('TIMEOUT', 'Synthetic timeout after send');
      case 'rate_limited':
        return new DistributionError('RATE_LIMITED', 'Synthetic rate limit');
      case 'server_error':
        return new DistributionError(
          'PROVIDER_ERROR',
          'Synthetic provider error',
        );
      case 'validation_rejected':
        return new DistributionError(
          'VALIDATION_FAILED',
          'Synthetic validation rejection',
        );
      case 'auth_failed':
        return new DistributionError('AUTH_FAILED', 'Synthetic auth failure');
    }
  }

  private resultFromFailure(failure: DistributionError): AcknowledgeResult {
    const certainty = this.certaintyFromFailure(failure);
    return {
      certainty,
      provider_request_id: null,
      observed_at: this.clock.now(),
      safe_error_code: failure.code,
      retry_after_ms: failure.code === 'RATE_LIMITED' ? 1000 : null,
    };
  }

  private certaintyFromFailure(failure: DistributionError): Certainty {
    if (failure.code === 'VALIDATION_FAILED' || failure.code === 'AUTH_FAILED')
      return 'REJECTED';
    if (
      failure.code === 'RATE_LIMITED' ||
      failure.message.includes('after send')
    )
      return 'UNKNOWN';
    return 'NOT_SENT';
  }

  private pushFromFailure(
    failure: DistributionError,
    cellKeys: string[],
  ): PushResultEnvelope {
    const certainty = this.certaintyFromFailure(failure);
    return {
      schema_version: 1,
      provider_request_id: null,
      provider_task_id: null,
      observed_at: this.clock.now(),
      certainty,
      safe_error_code: failure.code,
      retry_after_ms: failure.code === 'RATE_LIMITED' ? 1000 : null,
      warnings: [],
      cell_results: cellKeys.map((cellKey) => ({
        cell_key: cellKey,
        status: certainty === 'REJECTED' ? 'REJECTED' : 'UNKNOWN',
        safe_error_code: failure.code,
      })),
    };
  }

  private buildEnvelope(seed: SimulatorRevisionSeed): ChannelRevisionEnvelope {
    const items: RevisionItem[] = (seed.items ?? []).map((item, index) => ({
      item_ref: item.item_ref ?? `ITEM-${index + 1}`,
      item_ref_stable: item.item_ref_stable ?? true,
      external_room_ref: item.external_room_ref ?? 'ROOM-1',
      external_rate_ref: item.external_rate_ref ?? 'RATE-1',
      occupancy: item.occupancy ?? 2,
      meal_plan_ref: item.meal_plan_ref ?? null,
      arrival: item.arrival ?? '2026-10-01',
      departure: item.departure ?? '2026-10-03',
      amount: item.amount ?? null,
      currency: item.currency ?? null,
    }));
    const payload = {
      provider_revision_id: seed.provider_revision_id,
      revision_type: seed.revision_type,
      external_booking_id: seed.external_booking_id,
      provider_booking_id: seed.provider_booking_id ?? null,
      source_sequence: seed.source_sequence ?? null,
      source_time: seed.source_time ?? null,
      channel_key: seed.channel_key ?? null,
      items,
      amount_total: seed.amount_total ?? null,
      currency: seed.currency ?? null,
      commission_amount: seed.commission_amount ?? null,
      tax_amount: seed.tax_amount ?? null,
      net_amount: seed.net_amount ?? null,
      meal_plan_ref: seed.meal_plan_ref ?? null,
      occupancy: seed.occupancy ?? null,
      unmapped_fields: seed.unmapped_fields ?? [],
      payload_variant: seed.payload_variant ?? null,
    };
    return {
      schema_version: 1,
      provider_key: 'simulator',
      environment: 'simulator',
      connection_id: '',
      channel_key: seed.channel_key ?? '',
      external_booking_id: seed.external_booking_id,
      provider_booking_id: seed.provider_booking_id ?? null,
      provider_revision_id: seed.provider_revision_id,
      revision_type: seed.revision_type,
      source_sequence: seed.source_sequence ?? null,
      source_time: seed.source_time ?? null,
      received_at: this.clock.now(),
      items,
      amount_total: seed.amount_total ?? null,
      currency: seed.currency ?? null,
      commission_amount: seed.commission_amount ?? null,
      tax_amount: seed.tax_amount ?? null,
      net_amount: seed.net_amount ?? null,
      meal_plan_ref: seed.meal_plan_ref ?? null,
      occupancy: seed.occupancy ?? null,
      unmapped_fields: seed.unmapped_fields ?? [],
      payload_hash: hashPayload(payload),
      payload_safe_ref: `safe:simulator:${seed.provider_revision_id}`,
      sanitized: true,
    };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, at: offset })).toString(
      'base64url',
    );
  }

  private decodeCursor(cursor: string): number {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as { v?: unknown; at?: unknown };
      const offset = parsed.at;
      if (
        parsed.v !== 1 ||
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        throw new Error('bad cursor');
      return offset;
    } catch {
      throw new ValidationError('Invalid simulator cursor');
    }
  }
}
