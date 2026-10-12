import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import {
  ChannexAdapter,
  channexAdapterVersion,
  createChannexHttpClient,
  sanitizeWarningCodes,
  toSafeRef,
  unrecognizedWarningCode,
} from '../../packages/backend/dist/modules/distribution/index.js';

const connectionId = '11111111-2222-4333-8444-555555555555';
const canaries = ['guest@example.test', '4111111111111111', 'Synthetic Guest'];

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

function snapshot() {
  return {
    schema_version: 1,
    connection_id: connectionId,
    channel_key: 'booking-com',
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
}

const meta = { deadline_ms: 2000, correlation_id: 'R3-R5-regression' };

function providerFor(http, baseUrl = 'http://127.0.0.1:9') {
  return new ChannexAdapter({
    baseUrl,
    http,
    authHeaderName: 'user-api-key',
    resolveSecret: async () => 'synthetic-secret',
  });
}

let server;
let baseUrl;
let requests;
let handler;

beforeAll(async () => {
  requests = [];
  server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('external hosts stay offline unless live and allowExternal are both explicit', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      '{"data":[{"type":"task","id":"11111111-2222-4333-8444-555555555555"}],"meta":{"warnings":[]}}',
    );
  };

  const defaultClient = createChannexHttpClient({
    allowHosts: ['provider.invalid'],
    fetchImpl,
  });
  const blocked = await providerFor(
    defaultClient,
    'https://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(0);
  expect(blocked.certainty).toBe('NOT_SENT');
  expect(blocked.safe_error_code).toBe('UNSUPPORTED');

  const allowExternalOnly = createChannexHttpClient({
    allowHosts: ['provider.invalid'],
    allowExternal: true,
    live: false,
    fetchImpl,
  });
  const stillBlocked = await providerFor(
    allowExternalOnly,
    'https://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(0);
  expect(stillBlocked.certainty).toBe('NOT_SENT');

  const plaintextLive = createChannexHttpClient({
    allowHosts: ['provider.invalid'],
    allowExternal: true,
    live: true,
    fetchImpl,
  });
  const tlsBlocked = await providerFor(
    plaintextLive,
    'http://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(0);
  expect(tlsBlocked.certainty).toBe('NOT_SENT');

  const authorized = await providerFor(
    plaintextLive,
    'https://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(1);
  expect(authorized.certainty).toBe('PROVIDER_ACCEPTED');
});

test('pre-request policy rejections stay NOT_SENT without any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}');
  };
  const protocolClient = createChannexHttpClient({
    allowHosts: ['provider.invalid'],
    fetchImpl,
  });
  const protocol = await providerFor(
    protocolClient,
    'ftp://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(0);
  expect(protocol.certainty).toBe('NOT_SENT');
  expect(protocol.safe_error_code).toBe('VALIDATION_FAILED');

  const resetClient = createChannexHttpClient({
    allowHosts: ['provider.invalid'],
    allowExternal: true,
    live: true,
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      });
    },
  });
  const reset = await providerFor(
    resetClient,
    'https://provider.invalid',
  ).pushAvailability(context(), snapshot(), meta);
  expect(calls).toBe(1);
  expect(reset.certainty).toBe('UNKNOWN');
  expect(reset.certainty).not.toBe('NOT_SENT');
});

test('received but unreadable responses are UNKNOWN, never NOT_SENT', async () => {
  const adapter = () =>
    new ChannexAdapter({
      baseUrl,
      http: createChannexHttpClient({ allowHosts: ['127.0.0.1'] }),
      authHeaderName: 'user-api-key',
      resolveSecret: async () => 'synthetic-secret',
    });

  handler = (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('not-json');
  };
  requests.length = 0;
  const invalidJson = await adapter().pushAvailability(
    context(),
    snapshot(),
    meta,
  );
  expect(requests).toHaveLength(1);
  expect(invalidJson.certainty).toBe('UNKNOWN');
  expect(invalidJson.safe_error_code).toBe('PROVIDER_ERROR');

  handler = (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: 'x'.repeat(500) }));
  };
  requests.length = 0;
  const oversize = await new ChannexAdapter({
    baseUrl,
    http: createChannexHttpClient({
      allowHosts: ['127.0.0.1'],
      maxBodyBytes: 64,
    }),
    authHeaderName: 'user-api-key',
    resolveSecret: async () => 'synthetic-secret',
  }).pushAvailability(context(), snapshot(), meta);
  expect(requests).toHaveLength(1);
  expect(oversize.certainty).toBe('UNKNOWN');

  handler = (request) => {
    request.socket.destroy();
  };
  requests.length = 0;
  const resetAfterSend = await adapter().pushAvailability(
    context(),
    snapshot(),
    meta,
  );
  expect(requests).toHaveLength(1);
  expect(resetAfterSend.certainty).toBe('UNKNOWN');

  handler = (_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', 'https://untrusted.example/redirect');
    response.end();
  };
  requests.length = 0;
  const redirected = await adapter().pushAvailability(
    context(),
    snapshot(),
    meta,
  );
  expect(requests).toHaveLength(1);
  expect(redirected.certainty).toBe('UNKNOWN');

  const refused = await providerFor(
    createChannexHttpClient({ allowHosts: ['127.0.0.1'] }),
    'http://127.0.0.1:47831',
  ).pushAvailability(context(), snapshot(), meta);
  expect(refused.certainty).toBe('NOT_SENT');
});

test('only app-owned warning codes pass and refs become derived tokens', () => {
  expect(
    sanitizeWarningCodes([
      'CELL_DELAYED',
      '4111111111111111',
      'Synthetic Guest',
      'sk_live_abcdef1234567890',
      'CELL_DELAYED',
    ]),
  ).toEqual(['CELL_DELAYED', unrecognizedWarningCode]);
  const token = toSafeRef('4111111111111111');
  expect(token).toMatch(/^ref-[0-9a-f]{16}$/);
  expect(token).not.toContain('4111');
  expect(toSafeRef(token)).toBe(token);
  expect(toSafeRef('')).toBeNull();
  expect(toSafeRef(null)).toBeNull();
  expect(toSafeRef(42)).toBeNull();
});

test('provider warnings and refs are reduced to safe codes and tokens', async () => {
  handler = (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', 'guest@example.test#4111111111111111');
    response.end(
      JSON.stringify({
        data: [{ status: 'ok' }],
        warnings: [
          'Guest guest@example.test card 4111111111111111 failed',
          'CELL_DELAYED',
        ],
      }),
    );
  };
  requests.length = 0;
  const result = await new ChannexAdapter({
    baseUrl,
    http: createChannexHttpClient({ allowHosts: ['127.0.0.1'] }),
    authHeaderName: 'user-api-key',
    resolveSecret: async () => 'synthetic-secret',
  }).pushAvailability(context(), snapshot(), meta);
  expect(result.certainty).toBe('PARTIAL');
  expect(result.warnings).toEqual([unrecognizedWarningCode, 'CELL_DELAYED']);
  expect(result.provider_request_id).toMatch(/^ref-[0-9a-f]{16}$/);
  const serialized = JSON.stringify(result);
  for (const canary of canaries) expect(serialized).not.toContain(canary);
});
