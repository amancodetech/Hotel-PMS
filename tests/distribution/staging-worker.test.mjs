import { test, expect, jest, afterEach } from '@jest/globals';
import {
  createStagingWorkerRuntime,
  safeStagingFailure,
  runStagingTick,
  StagingTickFailure,
  TransportFailure,
  DistributionError,
  assertStagingContext,
  assertStagingHttp,
  assertStagingRevisionResponse,
  stagingWorkerScope,
  stagingTransportProfile,
  stagingDatabase,
  stagingSecretRef,
  startFiniteStagingTicks,
  boundedStagingFetch,
  evaluateActivationGate,
  channexAdapterVersion,
  leaseDueOutbox,
  claimPendingAck,
  sweepExhaustedAcks,
  listUnrecoveredExhaustedAcks,
} from '../../packages/backend/dist/modules/distribution/index.js';
const id = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
const scope = {
  tenantId: id(1),
  propertyId: id(2),
  connectionId: id(3),
  externalPropertyId: id(4),
  externalRoomId: id(5),
  externalRateId: id(6),
  date: '2026-10-15',
  maxTicks: 3,
};
const context = {
  tenant_id: scope.tenantId,
  property_id: scope.propertyId,
  connection_id: scope.connectionId,
  external_property_id: scope.externalPropertyId,
  provider_key: 'channex',
  environment: 'staging',
  channel_key: 'staging-crs',
  secret_ref: stagingSecretRef,
  adapter_version: channexAdapterVersion,
};
const config = {
  CHANNEX_STAGING_WORKER: 'on',
  DISTRIBUTION_WORKER: 'on',
  NIGHT_AUDIT_WORKER: 'off',
  REPORT_EXPORT_WORKER: 'off',
  CHANNEX_STAGING_TENANT_ID: scope.tenantId,
  CHANNEX_STAGING_PROPERTY_ID: scope.propertyId,
  CHANNEX_STAGING_CONNECTION_ID: scope.connectionId,
  CHANNEX_STAGING_EXTERNAL_PROPERTY_ID: scope.externalPropertyId,
  CHANNEX_STAGING_EXTERNAL_ROOM_ID: scope.externalRoomId,
  CHANNEX_STAGING_EXTERNAL_RATE_ID: scope.externalRateId,
  CHANNEX_STAGING_DATE: scope.date,
  CHANNEX_STAGING_MAX_TICKS: 3,
  DATABASE_URL: `postgres://localhost:55432/${stagingDatabase}`,
  API_DATABASE_URL: `postgres://localhost:55432/${stagingDatabase}`,
  WORKER_DATABASE_URL: `postgres://localhost:55432/${stagingDatabase}`,
};
const request = (path, body, method = 'POST') => ({
  method,
  url: `https://staging.channex.io/api/v1/${path}`,
  headers: {},
  body,
  timeoutMs: 1000,
  correlationId: 'synthetic',
});
const cell = {
  property_id: scope.externalPropertyId,
  rate_plan_id: scope.externalRateId,
  date: scope.date,
  stop_sell: true,
};
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
test('opt-in refuses original DB, incomplete scope and other clone workers; transport profile never opens activation', () => {
  expect(stagingWorkerScope(config)).toEqual(scope);
  for (const patch of [
    { DATABASE_URL: 'postgres://localhost/hotel' },
    { DATABASE_URL: `postgres://localhost:5432/${stagingDatabase}` },
    { API_DATABASE_URL: 'postgres://localhost/hotel' },
    { WORKER_DATABASE_URL: 'postgres://localhost/hotel' },
    { CHANNEX_STAGING_PROPERTY_ID: undefined },
    { DISTRIBUTION_WORKER: 'off' },
    { NIGHT_AUDIT_WORKER: 'on' },
    { REPORT_EXPORT_WORKER: 'on' },
  ])
    expect(() => stagingWorkerScope({ ...config, ...patch })).toThrow();
  for (const patch of [
    { tenant_id: id(99) },
    { property_id: id(99) },
    { connection_id: id(99) },
    { external_property_id: id(99) },
    { environment: 'live' },
    { channel_key: 'booking-com' },
    { provider_key: 'simulator' },
    { secret_ref: 'env:OTHER' },
    { adapter_version: 'wrong' },
  ])
    expect(() =>
      assertStagingContext(scope, { ...context, ...patch }),
    ).toThrow();
  const profile = stagingTransportProfile(scope, context);
  expect(evaluateActivationGate(profile).allowed).toBe(false);
  expect(profile.capabilities.every((entry) => entry.status !== 'TESTED')).toBe(
    true,
  );
  expect(
    profile.capabilities.find(
      (entry) => entry.capability_code === 'd20_withdraw_evidence',
    ),
  ).toMatchObject({
    status: 'UNKNOWN',
    authorization_status: 'NOT_AUTHORIZED',
  });
});
test('HTTP guard admits exact closed cells and rejects other rooms, dates, prices, open flags and production endpoints', () => {
  expect(() =>
    assertStagingHttp(scope, request('restrictions', { values: [cell] })),
  ).not.toThrow();
  const availability = {
    property_id: scope.externalPropertyId,
    room_type_id: scope.externalRoomId,
    date: scope.date,
    availability: 0,
  };
  expect(() =>
    assertStagingHttp(
      scope,
      request('availability', { values: [availability] }),
    ),
  ).not.toThrow();
  for (const patch of [
    { property_id: id(99) },
    { rate_plan_id: id(99) },
    { date: '2026-10-16' },
    { stop_sell: false },
    { rate: '100000' },
    { closed_to_arrival: false },
  ])
    expect(() =>
      assertStagingHttp(
        scope,
        request('restrictions', { values: [{ ...cell, ...patch }] }),
      ),
    ).toThrow();
  for (const patch of [{ room_type_id: id(99) }, { availability: 1 }])
    expect(() =>
      assertStagingHttp(
        scope,
        request('availability', { values: [{ ...availability, ...patch }] }),
      ),
    ).toThrow();
  expect(() =>
    assertStagingHttp(scope, {
      ...request('restrictions', { values: [cell] }),
      url: 'https://app.channex.io/api/v1/restrictions',
    }),
  ).toThrow();
});
test('shared property feed and ACK read reject unrelated booking scope before storage or posting', () => {
  const attributes = {
    property_id: scope.externalPropertyId,
    ota_name: 'Offline',
    rooms: [
      {
        room_type_id: scope.externalRoomId,
        rate_plan_id: scope.externalRateId,
        checkin_date: scope.date,
        checkout_date: '2026-10-16',
        occupancy: { adults: 2, children: 0, infants: 0 },
      },
    ],
  };
  const feed = request(
    `booking_revisions/feed?filter[property_id]=${scope.externalPropertyId}`,
    null,
    'GET',
  );
  const response = (data) => ({ status: 200, headers: {}, body: { data } });
  expect(() =>
    assertStagingRevisionResponse(scope, feed, response([{ attributes }])),
  ).not.toThrow();
  for (const patch of [
    { ota_name: 'Booking.com' },
    { property_id: id(99) },
    { rooms: [] },
    { rooms: [{ ...attributes.rooms[0], rate_plan_id: id(99) }] },
    { rooms: [{ ...attributes.rooms[0], checkin_date: '2026-10-16' }] },
  ]) {
    const foreign = { attributes: { ...attributes, ...patch } };
    expect(() =>
      assertStagingRevisionResponse(
        scope,
        feed,
        response([{ attributes }, foreign]),
      ),
    ).toThrow();
    expect(() =>
      assertStagingRevisionResponse(
        scope,
        request(`booking_revisions/${id(7)}`, null, 'GET'),
        response(foreign),
      ),
    ).toThrow();
  }
});
test('finite scheduler awaits work, caps ticks and drains shutdown; failure ends future ticks', async () => {
  jest.useFakeTimers();
  let release;
  const tick = jest.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const onFailure = jest.fn();
  const worker = startFiniteStagingTicks({
    maxTicks: 3,
    tick,
    onFailure,
    intervalMs: 100,
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  await jest.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
  const doneTick = jest.fn(async () => undefined);
  const finite = startFiniteStagingTicks({
    maxTicks: 3,
    tick: doneTick,
    onFailure,
    intervalMs: 100,
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(doneTick).toHaveBeenCalledTimes(3);
  await finite.stop();
  const failed = jest.fn(async () => {
    throw new Error('synthetic unknown');
  });
  const failure = startFiniteStagingTicks({
    maxTicks: 3,
    tick: failed,
    onFailure,
    intervalMs: 100,
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledTimes(1);
  await failure.stop();
});
test('chunked response without content-length stops and cancels at the byte limit', async () => {
  let cancelled = false;
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1_500_000));
          controller.enqueue(new Uint8Array(1_500_000));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect(
    boundedStagingFetch(
      'https://staging.channex.io/api/v1/booking_revisions/feed',
      {},
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});
test('all scoped lease/recovery queries filter connection before limit and locking; default queries retain original parameters', async () => {
  const captured = [];
  const em = {
    execute: async (sql, params) => {
      captured.push({ sql, params });
      return [];
    },
  };
  const input = {
    connectionId: scope.connectionId,
    owner: 'synthetic',
    limit: 10,
    maxAttempts: 1,
    now: '2026-10-11T00:00:00Z',
    leaseMs: 1000,
  };
  for (const operation of [
    leaseDueOutbox,
    claimPendingAck,
    sweepExhaustedAcks,
    listUnrecoveredExhaustedAcks,
  ])
    await operation(em, input);
  for (const { sql, params } of captured) {
    expect(sql).toMatch(/and (?:i\.)?"connection_id" = \?/);
    expect(sql.indexOf('"connection_id" = ?')).toBeLessThan(
      sql.indexOf('limit ?'),
    );
    expect(params[0]).toBe(scope.connectionId);
  }
  captured.length = 0;
  const { connectionId: _ignored, ...defaultInput } = input;
  await leaseDueOutbox(em, defaultInput);
  expect(captured[0].params[0]).toBe(input.now);
  expect(captured[0].sql).not.toContain('"connection_id" = ?');
});

test('constructed real staging runtime reaches protected mocked fetch and refuses changed context before HTTP', async () => {
  const row = { ...context, id: scope.connectionId, status: 'DRAFT' };
  const em = {
    execute: async (sql) => {
      if (sql.includes('from "distribution_connection"')) return [row];
      if (sql.includes('from "property"')) return [{ status: 'ACTIVE' }];
      if (sql.includes('distribution_sync_checkpoint')) return [];
      return [];
    },
  };
  const orm = {
    em: { fork: () => ({ transactional: async (work) => work(em) }) },
  };
  const fetched = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ data: [], meta: { page: 1, limit: 10, total: 0 } }),
        { status: 200 },
      ),
    );
  const runtime = await createStagingWorkerRuntime(orm, config, {
    NP_CHANNEX_STAGING_KEY: 'synthetic-staging-secret',
  });
  await runtime.pullConnection(context, scope.tenantId, scope.propertyId, 10);
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(new URL(fetched.mock.calls[0][0]).origin).toBe(
    'https://staging.channex.io',
  );
  row.environment = 'live';
  const contextFailure = await runtime.tick().catch((error) => error);
  expect(safeStagingFailure(contextFailure)).toEqual({
    phase: 'CONTEXT',
    code: 'UNKNOWN',
  });

  await expect(
    runtime.pullConnection(context, scope.tenantId, scope.propertyId, 10),
  ).rejects.toThrow();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(() =>
    assertStagingHttp(scope, {
      ...request('restrictions', { values: [cell] }),
      url: 'https://app.channex.io/api/v1/restrictions',
    }),
  ).toThrow();
  expect(fetched).toHaveBeenCalledTimes(1);
});

test('failure diagnostics retain only allowlisted phase/code and discard hostile details', async () => {
  const hostile = 'synthetic-secret-token header=user-api-key rawpayload';
  const transport = new TransportFailure('AFTER_SEND', 'TIMEOUT', hostile);
  expect(safeStagingFailure(transport, 'PULL')).toEqual({
    phase: 'PULL',
    code: 'TIMEOUT',
  });
  const provider = new DistributionError('RATE_LIMITED', hostile, {
    token: hostile,
  });
  expect(safeStagingFailure(provider, 'PULL')).toEqual({
    phase: 'PULL',
    code: 'RATE_LIMITED',
  });
  for (const thrown of [
    new Error(hostile),
    { code: 'AUTH_FAILED', phase: 'PULL', message: hostile },
    hostile,
  ]) {
    expect(safeStagingFailure(thrown)).toEqual({
      phase: 'TICK',
      code: 'UNKNOWN',
    });
    expect(JSON.stringify(safeStagingFailure(thrown))).not.toContain(hostile);
  }
  const failure = await runStagingTick({
    tick: async () => {
      throw transport;
    },
  }).catch((error) => error);
  expect(safeStagingFailure(failure)).toEqual({
    phase: 'DISPATCH_ACK',
    code: 'TIMEOUT',
  });
  expect(failure.message).not.toContain(hostile);
  const phasePreserved = await runStagingTick({
    tick: async () => {
      throw new StagingTickFailure('CONTEXT', 'UNKNOWN');
    },
  }).catch((error) => error);
  expect(safeStagingFailure(phasePreserved)).toEqual({
    phase: 'CONTEXT',
    code: 'UNKNOWN',
  });
  jest.useFakeTimers();
  const tick = jest.fn(async () => {
    throw new StagingTickFailure('PULL', 'TIMEOUT');
  });
  const failureCallback = jest.fn();
  const worker = startFiniteStagingTicks({
    maxTicks: 3,
    tick,
    onFailure: failureCallback,
    intervalMs: 100,
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
  expect(failureCallback).toHaveBeenCalledTimes(1);
  expect(safeStagingFailure(failureCallback.mock.calls[0][0])).toEqual({
    phase: 'PULL',
    code: 'TIMEOUT',
  });
  await worker.stop();
  await jest.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
});
