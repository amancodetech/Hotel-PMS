import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChannexAdapter,
  SimulatorAdapter,
  SimulatorEngine,
  channexAdapterVersion,
  createChannexHttpClient,
  findChannelProfile,
  lifecycleScenario,
  parseAvailabilitySnapshot,
  parseChannelRevisionEnvelope,
  parseMappingSnapshot,
  parsePushResultEnvelope,
  realChannelKeys,
  simulatorTestProfile,
  syntheticSixthChannelKey,
} from '../../packages/backend/dist/modules/distribution/index.js';
import {
  certaintyLevels,
  channelCatalog,
} from '../../packages/contracts/dist/distribution.js';
import {
  AlternateAdapter,
  alternateAdapterVersion,
  alternateProviderKey,
} from './support/alternate-adapter.mjs';

const connectionId = '11111111-2222-4333-8444-555555555555';
const policy = {
  allowedProviderKeys: new Set(['simulator', 'channex', alternateProviderKey]),
  allowedChannelKeys: new Set([
    ...channelCatalog.map((entry) => entry.key),
    syntheticSixthChannelKey,
  ]),
};
const meta = { deadline_ms: 3000, correlation_id: 'P02-06-conformance' };

function context(provider, channelKey = 'tiket-com') {
  return {
    connection_id: connectionId,
    tenant_id: '11111111-2222-4333-8444-666666666666',
    property_id: '11111111-2222-4333-8444-777777777777',
    provider_key: provider,
    environment: 'test',
    channel_key: channelKey,
    secret_ref: 'secret:synthetic',
    external_property_id: 'EXT-1',
    adapter_version:
      provider === 'channex'
        ? channexAdapterVersion
        : provider === alternateProviderKey
          ? alternateAdapterVersion
          : 'simulator-1.0.0',
  };
}

function availabilitySnapshot(channelKey) {
  return parseAvailabilitySnapshot({
    schema_version: 1,
    connection_id: connectionId,
    channel_key: channelKey,
    inventory_version: 1,
    cells: [
      {
        product_ref: 'ROOM-1',
        date: '2026-10-01',
        available: 2,
        inventory_version: 1,
      },
    ],
  });
}

async function assertContract(
  adapter,
  ctx,
  expectedRevisions = 3,
  { expectMappings = true } = {},
) {
  const capabilities = await adapter.inspectCapabilities(ctx, meta);
  expect(Array.isArray(capabilities)).toBe(true);
  if (expectMappings) {
    const mappings = await adapter.inspectMappings(ctx, meta);
    parseMappingSnapshot(mappings);
  } else {
    await expect(adapter.inspectMappings(ctx, meta)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  }
  const revisions = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = await adapter.pullRevisions(ctx, cursor, 2, meta);
    for (const revision of page.revisions)
      revisions.push(parseChannelRevisionEnvelope(revision, policy));
    cursor = page.next_cursor;
    guard += 1;
  } while (cursor !== null && guard < 5);
  expect(revisions).toHaveLength(expectedRevisions);
  const ack = await adapter.acknowledgeRevision(
    ctx,
    revisions[0].provider_revision_id,
    meta,
  );
  expect(certaintyLevels).toContain(ack.certainty);
  if (ack.certainty === 'PROVIDER_ACCEPTED')
    expect(ack.provider_request_id).toEqual(expect.any(String));
  const pushed = parsePushResultEnvelope(
    await adapter.pushAvailability(
      ctx,
      availabilitySnapshot(ctx.channel_key),
      meta,
    ),
  );
  expect(pushed.certainty).not.toBe('CHANNEL_VERIFIED');
  return { revisions, pushed, ack };
}

test('simulator conformance across the five channels', async () => {
  for (const channelKey of realChannelKeys()) {
    const adapter = new SimulatorAdapter({
      engine: new SimulatorEngine(lifecycleScenario(channelKey)),
      allowedChannelKeys: realChannelKeys(),
    });
    const result = await assertContract(
      adapter,
      context('simulator', channelKey),
    );
    expect(result.revisions[0].channel_key).toBe(channelKey);
  }
});

test('synthetic sixth channel passes conformance but stays out of production catalog', async () => {
  const adapter = new SimulatorAdapter({
    engine: new SimulatorEngine(lifecycleScenario(syntheticSixthChannelKey)),
    allowedChannelKeys: [...realChannelKeys(), syntheticSixthChannelKey],
  });
  const profile = simulatorTestProfile(syntheticSixthChannelKey);
  const ctx = context('simulator', syntheticSixthChannelKey);
  const result = await assertContract(adapter, ctx);
  expect(result.revisions[0].channel_key).toBe(syntheticSixthChannelKey);
  expect(profile.channel_key).toBe(syntheticSixthChannelKey);
  expect(
    channelCatalog.some((entry) => entry.key === syntheticSixthChannelKey),
  ).toBe(false);
  expect(findChannelProfile(syntheticSixthChannelKey)).toBeUndefined();
});

test('alternate adapter passes the same contract without Channex', async () => {
  const result = await assertContract(
    new AlternateAdapter(),
    context(alternateProviderKey, syntheticSixthChannelKey),
  );
  expect(result.ack.provider_request_id).toBe('alt-ack-1');
  expect(result.pushed.certainty).toBe('PROVIDER_ACCEPTED');
});

let server;
let channexBaseUrl;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/booking_revisions/feed')) {
      if (
        new URL(request.url, 'http://localhost').searchParams.get(
          'pagination[page]',
        ) === '2'
      ) {
        response.end(
          JSON.stringify({
            data: [
              {
                id: 'b3',
                attributes: {
                  booking_id: 'SYNTH-3',
                  revision_id: 'REV-3',
                  status: 'cancelled',
                  property_id: 'EXT-1',
                  ota_name: 'Agoda',
                  rooms: [],
                },
              },
            ],
            meta: { page: 2, limit: 2, total: 3 },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: ['1', '2'].map((id) => ({
            id: `b${id}`,
            attributes: {
              booking_id: `SYNTH-${id}`,
              revision_id: `REV-${id}`,
              status: id === '1' ? 'new' : 'modified',
              property_id: 'EXT-1',
              ota_name: 'Tiket.com',
              amount: '100.00',
              currency: 'IDR',
              rooms: [
                {
                  room_type_id: 'ROOM-1',
                  rate_plan_id: 'RATE-1',
                  occupancy: 1,
                  checkin_date: '2026-10-01',
                  checkout_date: '2026-10-02',
                },
              ],
            },
          })),
          meta: { page: 1, limit: 2, total: 3 },
        }),
      );
      return;
    }
    if (String(request.url).includes('/ack')) {
      response.setHeader('x-request-id', 'provider-ack');
      response.end('{}');
      return;
    }
    if (request.url?.startsWith('/booking_revisions/')) {
      response.end(
        JSON.stringify({
          data: {
            id: String(request.url).split('/')[2],
            attributes: { property_id: 'EXT-1' },
          },
        }),
      );
      return;
    }
    if (request.url === '/availability') {
      response.end(
        JSON.stringify({
          data: [{ type: 'task', id: '11111111-2222-4333-8444-555555555555' }],
          meta: { warnings: [] },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  channexBaseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('channex adapter passes the same contract against a local server', async () => {
  const adapter = new ChannexAdapter({
    baseUrl: channexBaseUrl,
    http: createChannexHttpClient({ allowHosts: ['127.0.0.1'], live: false }),
    authHeaderName: 'user-api-key',
    resolveSecret: async () => 'synthetic-secret',
    channelKeyByOtaName: { agoda: 'agoda', 'tiket.com': 'tiket-com' },
  });
  const result = await assertContract(
    adapter,
    context('channex', 'tiket-com'),
    3,
    {
      expectMappings: false,
    },
  );
  expect(result.ack.certainty).toBe('PROVIDER_ACCEPTED');
  expect(result.pushed.certainty).toBe('PROVIDER_ACCEPTED');
});

test('application, domain and persistence stay provider-neutral', () => {
  const roots = ['domain', 'application', 'persistence'].map(
    (folder) => `packages/backend/src/modules/distribution/${folder}`,
  );
  const violations = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (/from\s+['"][^'"]*adapters\//.test(source))
        violations.push(`${path}: imports an adapter`);
      if (/from\s+['"][^'"]*channex[^'"]*['"]/i.test(source))
        violations.push(`${path}: imports the Channex adapter`);
      for (const line of source.split('\n')) {
        if (
          /from\s+['"](bullmq|ioredis|@nestjs\/)/.test(line) &&
          !path.includes('/persistence/')
        )
          violations.push(`${path}: infrastructure import outside persistence`);
        if (
          /from\s+['"]@mikro-orm\//.test(line) &&
          !line.trimStart().startsWith('import type') &&
          !path.includes('/persistence/')
        )
          violations.push(`${path}: runtime ORM import outside persistence`);
      }
    }
  }
  for (const root of roots) walk(root);
  expect(violations).toEqual([]);
});
