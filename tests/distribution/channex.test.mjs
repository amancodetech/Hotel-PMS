import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import {
  ChannexAdapter,
  channexAdapterVersion,
  createChannexHttpClient,
  toSafeRef,
  unrecognizedWarningCode,
} from '../../packages/backend/dist/modules/distribution/index.js';

const connectionId = '11111111-2222-4333-8444-555555555555';
const secret = 'synthetic-provider-secret';

function context(overrides = {}) {
  return {
    connection_id: connectionId,
    tenant_id: '11111111-2222-4333-8444-666666666666',
    property_id: '11111111-2222-4333-8444-777777777777',
    provider_key: 'channex',
    environment: 'test',
    channel_key: 'booking-com',
    secret_ref: 'secret:channex-test',
    external_property_id: 'EXT-1',
    adapter_version: channexAdapterVersion,
    ...overrides,
  };
}

const meta = { deadline_ms: 3000, correlation_id: 'P02-05-test' };
const channelKeyByOtaName = {
  'booking.com': 'booking-com',
  agoda: 'agoda',
  traveloka: 'traveloka',
  'trip.com': 'trip-com',
  ctrip: 'trip-com',
  'tiket.com': 'tiket-com',
};

function revision(id, status, extra = {}) {
  return {
    id: `booking-${id}`,
    type: 'booking_revision',
    attributes: {
      booking_id: `SYNTH-${id}`,
      revision_id: `REV-${id}`,
      status,
      property_id: 'EXT-1',
      ota_name: 'Booking.com',
      amount: '1250000.50',
      currency: 'IDR',
      customer: {
        id: 'customer-1',
        name: 'Synthetic Guest',
        email: 'guest@example.com',
        card_number: '4111111111111111',
        cvv: '123',
      },
      rooms: [
        {
          id: `ROOMITEM-${id}`,
          room_type_id: 'ROOM-1',
          rate_plan_id: 'RATE-1',
          occupancy: { adults: 2, children: 0, infants: 0 },
          meal_plan: 'BB',
          checkin_date: '2026-10-01',
          checkout_date: '2026-10-03',
          amount: '625000.25',
          currency: 'IDR',
        },
      ],
      inserted_at: '2026-09-13T00:00:00Z',
      unknown_attribute: 'ignore-me',
      ...extra,
    },
  };
}

let server;
let baseUrl;
let requests;
let handler;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length > 0
    ? JSON.parse(Buffer.concat(chunks).toString())
    : null;
}

beforeAll(async () => {
  requests = [];
  server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readBody(request) : null;
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    handler(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function adapter(overrides = {}) {
  const http = createChannexHttpClient({
    allowHosts: ['127.0.0.1'],
    live: false,
    ...overrides,
  });
  return new ChannexAdapter({
    baseUrl: overrides.baseUrl ?? baseUrl,
    http,
    authHeaderName: 'user-api-key',
    resolveSecret: async (ref) => {
      expect(ref).toBe('secret:channex-test');
      return secret;
    },
    channelKeyByOtaName,
    now: () => '2026-09-13T00:00:01Z',
  });
}

test('feed pages normalize, sanitize and paginate deterministically', async () => {
  handler = (request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if (
      request.url?.startsWith('/booking_revisions/feed') &&
      query.get('pagination[page]') === '1'
    ) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [revision('1', 'new'), revision('2', 'modified')],
          meta: { page: 1, limit: 2, total: 3 },
        }),
      );
      return;
    }
    if (
      request.url?.startsWith('/booking_revisions/feed') &&
      query.get('pagination[page]') === '2'
    ) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [revision('3', 'cancelled', { rooms: [] })],
          meta: { page: 2, limit: 2, total: 3 },
        }),
      );
      return;
    }
    response.statusCode = 500;
    response.end('{}');
  };
  requests.length = 0;
  const provider = adapter();
  const first = await provider.pullRevisions(context(), null, 2, meta);
  expect(first.revisions).toHaveLength(2);
  expect(first.next_cursor).toEqual(expect.any(String));
  expect(first.revisions[0].channel_key).toBe('booking-com');
  expect(first.revisions[0].revision_type).toBe('new');
  expect(first.revisions[0].provider_booking_id).toBe('SYNTH-1');
  expect(
    new URL(requests[0].url, 'http://localhost').searchParams.get(
      'filter[property_id]',
    ),
  ).toBe('EXT-1');
  expect(
    new URL(requests[0].url, 'http://localhost').searchParams.get(
      'order[inserted_at]',
    ),
  ).toBe('asc');
  expect(first.revisions[0].items[0]).toMatchObject({
    external_room_ref: 'ROOM-1',
    external_rate_ref: 'RATE-1',
    occupancy: 2,
    arrival: '2026-10-01',
    departure: '2026-10-03',
    amount: '625000.25',
    currency: 'IDR',
  });
  const serialized = JSON.stringify(first.revisions);
  for (const forbidden of [
    '4111111111111111',
    'guest@example.com',
    'Synthetic Guest',
    'customer-1',
  ])
    expect(serialized).not.toContain(forbidden);
  expect(first.revisions[0].unmapped_fields).toContain(
    'attributes.customer.identity_fields',
  );
  expect(first.revisions[0].unmapped_fields).toContain(
    'attributes.unknown_attribute',
  );
  expect(first.revisions[0].unmapped_fields).toContain('type');
  expect(requests[0].headers['user-api-key']).toBe(secret);
  expect(requests[0].headers['x-correlation-id']).toBe('P02-05-test');

  const second = await provider.pullRevisions(
    context(),
    first.next_cursor,
    2,
    meta,
  );
  expect(second.revisions).toHaveLength(1);
  expect(second.revisions[0].revision_type).toBe('cancelled');
  expect(second.next_cursor).toBeNull();
  await expect(
    provider.pullRevisions(context(), 'not-a-cursor', 2, meta),
  ).rejects.toThrow('Invalid provider feed cursor');
});

test('acknowledge maps statuses, rate limits and timeouts safely', async () => {
  const provider = adapter();
  const cases = [
    ['ack-ok', 200, {}, 'PROVIDER_ACCEPTED'],
    ['ack-missing', 404, {}, 'REJECTED'],
    ['ack-limited', 429, { 'retry-after': '2' }, 'UNKNOWN'],
    ['ack-broken', 500, {}, 'UNKNOWN'],
  ];
  handler = (request, response) => {
    const id = String(request.url).split('/')[2];
    if (request.method === 'GET') {
      response.end(
        JSON.stringify({ data: { id, attributes: { property_id: 'EXT-1' } } }),
      );
      return;
    }
    const found = cases.find(([name]) => name === id);
    if (!found) {
      response.statusCode = 500;
      response.end('{}');
      return;
    }
    for (const [key, value] of Object.entries(found[2]))
      response.setHeader(key, value);
    response.setHeader('x-request-id', `provider-${id}`);
    response.statusCode = found[1];
    response.end('{}');
  };
  const ok = await provider.acknowledgeRevision(context(), 'ack-ok', meta);
  expect(ok.certainty).toBe('PROVIDER_ACCEPTED');
  expect(ok.provider_request_id).toBe(toSafeRef('provider-ack-ok'));
  const missing = await provider.acknowledgeRevision(
    context(),
    'ack-missing',
    meta,
  );
  expect(missing).toMatchObject({
    certainty: 'REJECTED',
    safe_error_code: 'NOT_FOUND',
  });
  const limited = await provider.acknowledgeRevision(
    context(),
    'ack-limited',
    meta,
  );
  expect(limited).toMatchObject({
    certainty: 'UNKNOWN',
    safe_error_code: 'RATE_LIMITED',
    retry_after_ms: 2000,
  });
  const broken = await provider.acknowledgeRevision(
    context(),
    'ack-broken',
    meta,
  );
  expect(broken.certainty).toBe('UNKNOWN');
  expect(JSON.stringify(broken)).not.toContain(secret);

  handler = async (request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    response.end('{}');
  };
  const timedOut = await provider.acknowledgeRevision(
    context(),
    'ack-timeout',
    { deadline_ms: 50, correlation_id: 'timeout-test' },
  );
  expect(timedOut.certainty).toBe('UNKNOWN');
  expect(timedOut.safe_error_code).toBe('TIMEOUT');
});

test('connection refusal before send is NOT_SENT and redirects are not followed', async () => {
  const refused = adapter({ baseUrl: 'http://127.0.0.1:47831' });
  const beforeSend = await refused.acknowledgeRevision(
    context(),
    'REV-refused',
    { deadline_ms: 1000, correlation_id: 'refused' },
  );
  expect(beforeSend.certainty).toBe('NOT_SENT');
  expect(beforeSend.safe_error_code).toBe('TIMEOUT');

  handler = (request, response) => {
    response.statusCode = 302;
    response.setHeader('location', 'https://untrusted.example/redirect');
    response.end();
  };
  requests.length = 0;
  const redirected = await adapter().acknowledgeRevision(
    context(),
    'REV-redirect',
    meta,
  );
  expect(redirected.certainty).not.toBe('PROVIDER_ACCEPTED');
  expect(requests).toHaveLength(1);

  const strict = adapter({ allowHosts: ['api.provider.invalid'] });
  const blocked = await strict.acknowledgeRevision(context(), 'REV-x', meta);
  expect(blocked).toMatchObject({
    certainty: 'NOT_SENT',
    safe_error_code: 'UNSUPPORTED',
  });
});

test('ARI pushes send single-date cells and keep warnings partial', async () => {
  handler = (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', 'provider-ari-1');
    response.end(
      JSON.stringify({
        data: [{ type: 'task', id: '11111111-2222-4333-8444-555555555555' }],
        meta: { warnings: ['third cell delayed'] },
      }),
    );
  };
  requests.length = 0;
  const snapshot = {
    schema_version: 1,
    connection_id: connectionId,
    channel_key: 'booking-com',
    inventory_version: 4,
    cells: [
      {
        product_ref: 'ROOM-1',
        date: '2026-10-01',
        available: 2,
        inventory_version: 4,
      },
      {
        product_ref: 'ROOM-1',
        date: '2026-10-02',
        available: 2,
        inventory_version: 4,
      },
      {
        product_ref: 'ROOM-1',
        date: '2026-10-03',
        available: 1,
        inventory_version: 4,
      },
    ],
  };
  const result = await adapter().pushAvailability(context(), snapshot, meta);
  const sent = requests.find((request) => request.url === '/availability');
  expect(sent.body.values).toHaveLength(3);
  expect(sent.body.values.map((cell) => cell.date)).toEqual([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
  ]);
  expect(
    sent.body.values.every(
      (cell) => typeof cell.date === 'string' && !cell.date.includes('/'),
    ),
  ).toBe(true);
  expect(result.certainty).toBe('PARTIAL');
  expect(result.warnings).toEqual([unrecognizedWarningCode]);
  expect(result.provider_request_id).toBe(toSafeRef('provider-ari-1'));
  expect(result.provider_task_id).toBe(
    toSafeRef('11111111-2222-4333-8444-555555555555'),
  );
  expect(result.cell_results.every((cell) => cell.status === 'UNKNOWN')).toBe(
    true,
  );

  handler = (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: [{ type: 'task', id: '11111111-2222-4333-8444-555555555555' }],
        meta: { warnings: [] },
      }),
    );
  };
  const accepted = await adapter().pushRestrictions(
    context(),
    {
      schema_version: 1,
      connection_id: connectionId,
      channel_key: 'booking-com',
      inventory_version: 5,
      cells: [
        {
          rate_ref: 'RATE-1',
          date: '2026-10-01',
          price: '1250000.50',
          currency: 'IDR',
          min_stay: 1,
          max_stay: null,
          stop_sell: false,
          closed_to_arrival: null,
          closed_to_departure: null,
          inventory_version: 5,
        },
      ],
    },
    meta,
  );
  expect(accepted.certainty).toBe('PROVIDER_ACCEPTED');
  const restrictionRequest = requests.find(
    (request) => request.url === '/restrictions',
  );
  expect(restrictionRequest.body.values[0]).toMatchObject({
    rate: '1250000.50',
    min_stay_arrival: 1,
    min_stay_through: 1,
  });
  expect(restrictionRequest.body.values[0]).not.toHaveProperty('price');
  expect(accepted.cell_results[0].status).toBe('UNKNOWN');
});

test('shared credential feed rejects wrong or missing property before normalization', async () => {
  for (const property_id of ['EXT-OTHER', undefined]) {
    handler = (_request, response) =>
      response.end(
        JSON.stringify({
          data: [revision('foreign', 'new', { property_id })],
          meta: { page: 1, limit: 1, total: 1 },
        }),
      );
    requests.length = 0;
    await expect(
      adapter().pullRevisions(context(), null, 1, meta),
    ).rejects.toThrow('property does not match');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  }
});

test('ACK checks exact revision and property before posting with shared credential', async () => {
  for (const attributes of [{ property_id: 'EXT-OTHER' }, {}]) {
    handler = (_request, response) =>
      response.end(JSON.stringify({ data: { id: 'REV-foreign', attributes } }));
    requests.length = 0;
    const result = await adapter().acknowledgeRevision(
      context(),
      'REV-foreign',
      meta,
    );
    expect(result).toMatchObject({
      certainty: 'NOT_SENT',
      safe_error_code: 'VALIDATION_FAILED',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
  }
});

test('ACK rejects a different revision ID even when its property matches', async () => {
  handler = (_request, response) =>
    response.end(
      JSON.stringify({
        data: { id: 'REV-other', attributes: { property_id: 'EXT-1' } },
      }),
    );
  requests.length = 0;
  const result = await adapter().acknowledgeRevision(
    context(),
    'REV-requested',
    meta,
  );
  expect(result).toMatchObject({
    certainty: 'NOT_SENT',
    safe_error_code: 'VALIDATION_FAILED',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'GET',
    url: '/booking_revisions/REV-requested',
  });
});

test('staging requires exact API base and UUID scope before resolving credentials or transport', async () => {
  const externalProperty = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const validBase = 'https://staging.channex.io/api/v1';
  const invalid = [
    ['https://staging.channex.io', externalProperty],
    ['https://staging.channex.io/api/v2', externalProperty],
    ['https://app.channex.io/api/v1', externalProperty],
    [`${validBase}?ignored=1`, externalProperty],
    [`${validBase}#ignored`, externalProperty],
    ['https://user:password@staging.channex.io/api/v1', externalProperty],
    [validBase, 'not-a-property-uuid'],
    [validBase, null],
  ];
  for (const [candidateBase, propertyId] of invalid) {
    let credentialCalls = 0;
    const httpCalls = [];
    const provider = new ChannexAdapter({
      baseUrl: candidateBase,
      authHeaderName: 'user-api-key',
      channelKeyByOtaName,
      resolveSecret: async () => {
        credentialCalls += 1;
        return secret;
      },
      http: async (request) => {
        httpCalls.push(request);
        return { status: 200, headers: {}, body: { data: [] } };
      },
    });
    await expect(
      provider.pullRevisions(
        context({ environment: 'staging', external_property_id: propertyId }),
        null,
        1,
        meta,
      ),
    ).rejects.toThrow();
    expect(credentialCalls).toBe(0);
    expect(httpCalls).toHaveLength(0);
  }
  let credentialCalls = 0;
  const httpCalls = [];
  const provider = new ChannexAdapter({
    baseUrl: validBase,
    authHeaderName: 'user-api-key',
    channelKeyByOtaName,
    resolveSecret: async () => {
      credentialCalls += 1;
      return secret;
    },
    http: async (request) => {
      httpCalls.push(request);
      return {
        status: 200,
        headers: {},
        body: { data: [], meta: { page: 1, limit: 1, total: 0 } },
      };
    },
  });
  const pulled = await provider.pullRevisions(
    context({ environment: 'staging', external_property_id: externalProperty }),
    null,
    1,
    meta,
  );
  expect(pulled.revisions).toEqual([]);
  expect(credentialCalls).toBe(1);
  expect(httpCalls).toHaveLength(1);
  const requested = new URL(httpCalls[0].url);
  expect(requested.origin).toBe('https://staging.channex.io');
  expect(requested.pathname).toBe('/api/v1/booking_revisions/feed');
  expect(requested.searchParams.get('filter[property_id]')).toBe(
    externalProperty,
  );
  expect(httpCalls[0].headers['user-api-key']).toBe(secret);
});

test('official adult occupancy stays accurate and unsupported family counts fail closed', async () => {
  const base = revision('occupancy', 'new');
  const room = base.attributes.rooms[0];
  handler = (_request, response) =>
    response.end(
      JSON.stringify({
        data: [
          {
            ...base,
            attributes: {
              ...base.attributes,
              rooms: [
                { ...room, occupancy: { adults: 2, children: 0, infants: 0 } },
              ],
            },
          },
        ],
        meta: { page: 1, limit: 1, total: 1 },
      }),
    );
  expect(
    (await adapter().pullRevisions(context(), null, 1, meta)).revisions[0]
      .items[0].occupancy,
  ).toBe(2);
  for (const occupancy of [
    { adults: 2, children: 1, infants: 0 },
    { adults: 2, children: 0, infants: 1 },
    { adults: 2, children: 1, infants: 1 },
  ]) {
    handler = (_request, response) =>
      response.end(
        JSON.stringify({
          data: [
            {
              ...base,
              attributes: {
                ...base.attributes,
                rooms: [{ ...room, occupancy }],
              },
            },
          ],
          meta: { page: 1, limit: 1, total: 1 },
        }),
      );
    requests.length = 0;
    await expect(
      adapter().pullRevisions(context(), null, 1, meta),
    ).rejects.toThrow('child or infant occupancy is unsupported');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  }
  for (const occupancy of [
    undefined,
    { adults: 2, children: -1, infants: 0 },
    { adults: '2', children: 0, infants: 0 },
    { adults: 2 },
    2.5,
    0,
  ]) {
    handler = (_request, response) =>
      response.end(
        JSON.stringify({
          data: [
            {
              ...base,
              attributes: {
                ...base.attributes,
                rooms: [{ ...room, occupancy }],
              },
            },
          ],
          meta: { page: 1, limit: 1, total: 1 },
        }),
      );
    await expect(
      adapter().pullRevisions(context(), null, 1, meta),
    ).rejects.toThrow('occupancy is invalid');
  }
});

test('malformed 2xx or fake per-cell response never claims accepted cells', async () => {
  handler = (_request, response) =>
    response.end(JSON.stringify({ data: [{ status: 'ok' }] }));
  const result = await adapter().pushAvailability(
    context(),
    {
      schema_version: 1,
      connection_id: connectionId,
      channel_key: 'booking-com',
      inventory_version: 1,
      cells: [
        {
          product_ref: 'ROOM-1',
          date: '2026-10-01',
          available: 0,
          inventory_version: 1,
        },
      ],
    },
    meta,
  );
  expect(result.certainty).toBe('UNKNOWN');
  expect(result.provider_task_id).toBeNull();
  expect(result.cell_results[0].status).toBe('UNKNOWN');
});

test('scoped provider-only readback preserves actual values and rejects missing cells', async () => {
  const scope = {
    product_refs: ['ROOM-1'],
    rate_refs: ['RATE-1'],
    date_from: '2026-10-01',
    date_to: '2026-10-02',
  };
  let missing = false;
  handler = (request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams;
    expect(query.get('filter[property_id]')).toBe('EXT-1');
    response.end(
      JSON.stringify({
        data: request.url.startsWith('/availability')
          ? {
              'ROOM-1': {
                '2026-10-01': 0,
                ...(!missing ? { '2026-10-02': 1 } : {}),
                '2026-10-03': 99,
              },
              'ROOM-FOREIGN': { '2026-10-01': 9 },
            }
          : {
              'RATE-1': {
                '2026-10-01': { rate: '100000.00', stop_sell: true },
                '2026-10-02': { rate: '110000.00', stop_sell: true },
              },
            },
      }),
    );
  };
  const readback = await adapter().readAriState(context(), scope, meta);
  expect(readback.evidence_level).toBe('PROVIDER_ONLY');
  expect(readback.availability).toEqual({
    'ROOM-1': { '2026-10-01': 0, '2026-10-02': 1 },
  });
  expect(readback.restrictions['RATE-1']['2026-10-02']).toEqual({
    rate: '110000.00',
    stop_sell: true,
  });
  expect(readback).not.toHaveProperty('certainty');
  missing = true;
  await expect(adapter().readAriState(context(), scope, meta)).rejects.toThrow(
    'cell is missing',
  );
  requests.length = 0;
  await expect(
    adapter().readAriState(
      context(),
      { ...scope, date_to: '2027-10-01' },
      meta,
    ),
  ).rejects.toThrow('scope is invalid');
  expect(requests).toHaveLength(0);
});

test('readback and channel evidence stay unsupported without a verified endpoint', async () => {
  const provider = adapter();
  await expect(
    provider.readProviderState(
      context(),
      {
        product_refs: ['ROOM-1'],
        rate_refs: [],
        date_from: '2026-10-01',
        date_to: '2026-10-02',
      },
      meta,
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(
    provider.readChannelEvidence(
      context(),
      {
        product_refs: ['ROOM-1'],
        rate_refs: [],
        date_from: '2026-10-01',
        date_to: '2026-10-02',
      },
      meta,
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(provider.inspectMappings(context(), meta)).rejects.toMatchObject(
    { code: 'UNSUPPORTED' },
  );
});
