import { describe, expect, test } from '@jest/globals';
import {
  SimulatorAdapter,
  SimulatorEngine,
  decideRevisionApplication,
  isSuccess,
  lifecycleScenario,
  mappingFixture,
  realChannelKeys,
  simulatorAdapterVersion,
} from '../../packages/backend/dist/modules/distribution/index.js';
import { channelCatalog } from '../../packages/contracts/dist/distribution.js';

const connection = {
  connection_id: '11111111-2222-4333-8444-555555555555',
  tenant_id: '11111111-2222-4333-8444-666666666666',
  property_id: '11111111-2222-4333-8444-777777777777',
  provider_key: 'simulator',
  environment: 'simulator',
  channel_key: 'tiket-com',
  secret_ref: 'secret:simulator',
  external_property_id: 'EXT-1',
  adapter_version: simulatorAdapterVersion,
};
const meta = { deadline_ms: 2000, correlation_id: 'corr-P02-02' };

function adapterFor(scenario, channelKey = connection.channel_key) {
  const engine = new SimulatorEngine(scenario);
  const adapter = new SimulatorAdapter({
    engine,
    allowedChannelKeys: realChannelKeys(),
  });
  return {
    engine,
    adapter,
    context: { ...connection, channel_key: channelKey },
  };
}

function applyAll(state, revisions) {
  let current = state;
  const decisions = [];
  for (const revision of revisions) {
    const decision = decideRevisionApplication(current, {
      provider_revision_id: revision.provider_revision_id,
      payload_hash: revision.payload_hash,
      revision_type: revision.revision_type,
      source_sequence: revision.source_sequence,
      source_time: revision.source_time,
    });
    decisions.push(`${revision.provider_revision_id}:${decision.action}`);
    if (decision.action === 'apply')
      current = {
        provider_revision_id: revision.provider_revision_id,
        payload_hash: revision.payload_hash,
        state: revision.revision_type === 'cancelled' ? 'CANCELLED' : 'ACTIVE',
        source_sequence: revision.source_sequence,
        source_time: revision.source_time,
      };
  }
  return { decisions, current };
}

const emptyState = {
  provider_revision_id: null,
  payload_hash: null,
  state: 'NONE',
  source_sequence: null,
  source_time: null,
};

describe('P02-02 deterministic simulator lifecycle', () => {
  test('pulls new, modified and cancelled in pages with an opaque cursor', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', {
        mappings: mappingFixture('tiket-com', connection.connection_id),
      }),
    );
    const first = await adapter.pullRevisions(connection, null, 2, meta);
    expect(first.revisions.map((r) => r.provider_revision_id)).toEqual([
      'tiket-com-R1',
      'tiket-com-R2',
    ]);
    expect(first.revisions.map((r) => r.revision_type)).toEqual([
      'new',
      'modified',
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toContain('2026');
    const second = await adapter.pullRevisions(
      connection,
      first.next_cursor,
      2,
      meta,
    );
    expect(second.revisions.map((r) => r.provider_revision_id)).toEqual([
      'tiket-com-R3',
    ]);
    expect(second.revisions[0].revision_type).toBe('cancelled');
    expect(second.next_cursor).toBeNull();
    const all = [...first.revisions, ...second.revisions];
    const { decisions, current } = applyAll(emptyState, all);
    expect(decisions).toEqual([
      'tiket-com-R1:apply',
      'tiket-com-R2:apply',
      'tiket-com-R3:apply',
    ]);
    expect(current.state).toBe('CANCELLED');
  });
  test('same seed and scenario replay identical revisions', async () => {
    const first = adapterFor(lifecycleScenario('agoda'));
    const second = adapterFor(lifecycleScenario('agoda'));
    const pageA = await first.adapter.pullRevisions(
      first.context,
      null,
      10,
      meta,
    );
    const pageB = await second.adapter.pullRevisions(
      second.context,
      null,
      10,
      meta,
    );
    expect(pageA).toEqual(pageB);
  });
  test('duplicate delivery never applies twice', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', { duplicate_deliveries: 1 }),
    );
    const page = await adapter.pullRevisions(connection, null, 10, meta);
    expect(page.revisions.map((r) => r.provider_revision_id)).toEqual([
      'tiket-com-R1',
      'tiket-com-R1',
      'tiket-com-R2',
      'tiket-com-R2',
      'tiket-com-R3',
      'tiket-com-R3',
    ]);
    const { decisions } = applyAll(emptyState, page.revisions);
    expect(decisions).toEqual([
      'tiket-com-R1:apply',
      'tiket-com-R1:duplicate',
      'tiket-com-R2:apply',
      'tiket-com-R2:duplicate',
      'tiket-com-R3:apply',
      'tiket-com-R3:duplicate',
    ]);
  });
  test('delivery reordering never revives a cancelled booking', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('booking-com', {
        delivery_order: ['booking-com-R3', 'booking-com-R2', 'booking-com-R1'],
      }),
    );
    const page = await adapter.pullRevisions(
      { ...connection, channel_key: 'booking-com' },
      null,
      10,
      meta,
    );
    const { decisions, current } = applyAll(emptyState, page.revisions);
    expect(decisions).toEqual([
      'booking-com-R3:apply',
      'booking-com-R2:stale',
      'booking-com-R1:stale',
    ]);
    expect(current.state).toBe('CANCELLED');
    expect(current.provider_revision_id).toBe('booking-com-R3');
  });
  test('missing mapping is reported, not guessed', async () => {
    const { adapter, engine } = adapterFor(lifecycleScenario('traveloka'));
    const snapshot = await adapter.inspectMappings(
      { ...connection, channel_key: 'traveloka' },
      meta,
    );
    expect(snapshot.mapping_version).toBe(0);
    expect(snapshot.entries).toEqual([]);
    expect(engine.mappingSnapshot('traveloka').entries).toEqual([]);
    const page = await adapter.pullRevisions(
      { ...connection, channel_key: 'traveloka' },
      null,
      10,
      meta,
    );
    expect(page.revisions).toHaveLength(3);
  });
  test('all five channel fixtures work through the same adapter', async () => {
    for (const channelKey of channelCatalog.map((entry) => entry.key)) {
      const { adapter } = adapterFor(lifecycleScenario(channelKey), channelKey);
      const page = await adapter.pullRevisions(
        { ...connection, channel_key: channelKey },
        null,
        10,
        meta,
      );
      expect(page.revisions).toHaveLength(3);
      expect(page.revisions[0].channel_key).toBe(channelKey);
      expect(page.revisions[0].external_booking_id).toBe(
        `SYNTH-${channelKey}-1`,
      );
    }
  });
});

describe('P02-02 deterministic simulator failures', () => {
  test('rate limit keeps retry_after and does not fail permanently', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', {
        failures: [
          { operation: 'acknowledgeRevision', kind: 'rate_limited', times: 1 },
        ],
      }),
    );
    const limited = await adapter.acknowledgeRevision(
      connection,
      'tiket-com-R1',
      meta,
    );
    expect(limited).toMatchObject({
      certainty: 'UNKNOWN',
      safe_error_code: 'RATE_LIMITED',
      retry_after_ms: 1000,
    });
    const accepted = await adapter.acknowledgeRevision(
      connection,
      'tiket-com-R1',
      meta,
    );
    expect(accepted.certainty).toBe('PROVIDER_ACCEPTED');
  });
  test('timeout after send is unknown, never success, and retries cleanly', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', {
        failures: [
          {
            operation: 'pushAvailability',
            kind: 'timeout_after_send',
            times: 1,
          },
        ],
      }),
    );
    const snapshot = {
      schema_version: 1,
      connection_id: connection.connection_id,
      channel_key: connection.channel_key,
      inventory_version: 1,
      cells: [
        {
          product_ref: 'ROOM-1',
          date: '2026-10-01',
          available: 2,
          inventory_version: 1,
        },
      ],
    };
    const unknown = await adapter.pushAvailability(connection, snapshot, meta);
    expect(unknown.certainty).toBe('UNKNOWN');
    expect(isSuccess(unknown.certainty)).toBe(false);
    expect(unknown.safe_error_code).toBe('TIMEOUT');
    const accepted = await adapter.pushAvailability(connection, snapshot, meta);
    expect(accepted.certainty).toBe('PROVIDER_ACCEPTED');
  });
  test('partial cells are partial, and channel evidence stays unknown', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('agoda', {
        unknown_cells: ['ROOM-1:2026-10-01'],
      }),
    );
    const context = { ...connection, channel_key: 'agoda' };
    const result = await adapter.pushAvailability(
      context,
      {
        schema_version: 1,
        connection_id: context.connection_id,
        channel_key: 'agoda',
        inventory_version: 1,
        cells: [
          {
            product_ref: 'ROOM-1',
            date: '2026-10-01',
            available: 1,
            inventory_version: 1,
          },
          {
            product_ref: 'ROOM-1',
            date: '2026-10-02',
            available: 1,
            inventory_version: 1,
          },
        ],
      },
      meta,
    );
    expect(result.certainty).toBe('PARTIAL');
    expect(isSuccess(result.certainty)).toBe(false);
    const evidence = await adapter.readChannelEvidence(
      context,
      {
        product_refs: ['ROOM-1'],
        rate_refs: [],
        date_from: '2026-10-01',
        date_to: '2026-10-02',
      },
      meta,
    );
    expect(evidence.certainty).toBe('UNKNOWN');
    expect(evidence.warnings.length).toBeGreaterThan(0);
  });
  test('validation rejection is rejected and not retried as unknown', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('trip-com', {
        failures: [
          {
            operation: 'pushRestrictions',
            kind: 'validation_rejected',
            times: 1,
          },
        ],
      }),
    );
    const context = { ...connection, channel_key: 'trip-com' };
    const result = await adapter.pushRestrictions(
      context,
      {
        schema_version: 1,
        connection_id: context.connection_id,
        channel_key: 'trip-com',
        inventory_version: 1,
        cells: [
          {
            rate_ref: 'RATE-1',
            date: '2026-10-01',
            price: '1250000.50',
            currency: 'IDR',
            min_stay: null,
            max_stay: null,
            stop_sell: false,
            closed_to_arrival: null,
            closed_to_departure: null,
            inventory_version: 1,
          },
        ],
      },
      meta,
    );
    expect(result.certainty).toBe('REJECTED');
    expect(result.safe_error_code).toBe('VALIDATION_FAILED');
  });
  test('capability gate blocks an unknown profile before network use', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', { capabilities: [] }),
    );
    await expect(
      adapter.pushAvailability(
        connection,
        {
          schema_version: 1,
          connection_id: connection.connection_id,
          channel_key: 'tiket-com',
          inventory_version: 1,
          cells: [
            {
              product_ref: 'ROOM-1',
              date: '2026-10-01',
              available: 1,
              inventory_version: 1,
            },
          ],
        },
        meta,
      ),
    ).rejects.toThrow('Capability is not available');
  });
  test('invalid cursor, limit and mismatched snapshot are rejected', async () => {
    const { adapter } = adapterFor(lifecycleScenario('tiket-com'));
    await expect(
      adapter.pullRevisions(connection, 'not-a-cursor', 10, meta),
    ).rejects.toThrow('Invalid simulator cursor');
    await expect(
      adapter.pullRevisions(connection, null, 0, meta),
    ).rejects.toThrow('Pull limit');
    await expect(
      adapter.pushAvailability(
        connection,
        {
          schema_version: 1,
          connection_id: '99999999-2222-4333-8444-555555555555',
          channel_key: 'tiket-com',
          inventory_version: 1,
          cells: [
            {
              product_ref: 'ROOM-1',
              date: '2026-10-01',
              available: 1,
              inventory_version: 1,
            },
          ],
        },
        meta,
      ),
    ).rejects.toThrow('Snapshot does not match the connection');
  });
  test('verified channel evidence is explicit, not implied by provider acceptance', async () => {
    const { adapter } = adapterFor(
      lifecycleScenario('tiket-com', { verified_channel: true }),
    );
    const evidence = await adapter.readChannelEvidence(
      connection,
      {
        product_refs: ['ROOM-1'],
        rate_refs: [],
        date_from: '2026-10-01',
        date_to: '2026-10-01',
      },
      meta,
    );
    expect(evidence.certainty).toBe('CHANNEL_VERIFIED');
    expect(
      evidence.cell_results.every((cell) => cell.status === 'ACCEPTED'),
    ).toBe(true);
  });
});
