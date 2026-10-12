import { capabilityCodes, safeErrorCodes } from '@hotel/contracts';
import type { SafeErrorCode } from '@hotel/contracts';
import type { ChannelProfile, ConnectionContext } from '@hotel/contracts';
import type { AppConfig } from '../../../config.js';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { findConnection } from '../persistence/connection-repository.js';
import {
  ChannexAdapter,
  channexAdapterVersion,
} from '../adapters/channex/channex-adapter.js';
import { createChannexHttpClient } from '../adapters/channex/http-client.js';
import {
  TransportFailure,
  HttpPolicyError,
} from '../adapters/channex/http-client.js';
import { DistributionError } from '../domain/errors.js';
import type {
  HttpClientRequest,
  HttpClientResponse,
} from '../adapters/channex/http-client.js';
import { ProviderRegistry } from '../adapters/registry.js';
import { DistributionRuntime } from '../application/runtime.js';

export const stagingDatabase = 'hotel_np_operational_trial_20261009';
export const stagingSecretRef = 'env:NP_CHANNEX_STAGING_KEY';
const origin = 'https://staging.channex.io';
export type StagingFailurePhase = 'CONTEXT' | 'PULL' | 'DISPATCH_ACK' | 'TICK';
const failurePhases: readonly StagingFailurePhase[] = [
  'CONTEXT',
  'PULL',
  'DISPATCH_ACK',
  'TICK',
];
export class StagingTickFailure extends Error {
  constructor(
    public readonly phase: StagingFailurePhase,
    public readonly safeCode: SafeErrorCode,
  ) {
    super('Staging tick stopped');
    this.name = 'StagingTickFailure';
  }
}
export function safeStagingFailure(
  error: unknown,
  fallback: StagingFailurePhase = 'TICK',
): { phase: StagingFailurePhase; code: SafeErrorCode } {
  const phase =
    error instanceof StagingTickFailure && failurePhases.includes(error.phase)
      ? error.phase
      : fallback;
  const candidate =
    error instanceof TransportFailure ||
    error instanceof HttpPolicyError ||
    error instanceof StagingTickFailure
      ? error.safeCode
      : error instanceof DistributionError
        ? error.code
        : 'UNKNOWN';
  return {
    phase: failurePhases.includes(phase) ? phase : 'TICK',
    code: safeErrorCodes.includes(candidate) ? candidate : 'UNKNOWN',
  };
}
async function inStagingPhase<T>(
  phase: StagingFailurePhase,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const safe = safeStagingFailure(error, phase);
    throw new StagingTickFailure(safe.phase, safe.code);
  }
}
export async function runStagingTick(
  runtime: Pick<DistributionRuntime, 'tick'>,
): Promise<Awaited<ReturnType<DistributionRuntime['tick']>>> {
  return inStagingPhase('DISPATCH_ACK', () => runtime.tick());
}
export interface StagingWorkerScope {
  tenantId: string;
  propertyId: string;
  connectionId: string;
  externalPropertyId: string;
  externalRoomId: string;
  externalRateId: string;
  date: '2026-10-15';
  maxTicks: number;
}
function invalid(): never {
  throw new Error('Staging worker scope is invalid');
}
export function stagingWorkerScope(config: AppConfig): StagingWorkerScope {
  if (
    config.CHANNEX_STAGING_WORKER !== 'on' ||
    config.DISTRIBUTION_WORKER !== 'on' ||
    config.NIGHT_AUDIT_WORKER !== 'off' ||
    config.REPORT_EXPORT_WORKER !== 'off'
  )
    invalid();
  for (const value of [
    config.DATABASE_URL,
    config.API_DATABASE_URL,
    config.WORKER_DATABASE_URL,
  ]) {
    const url = new URL(value);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.port !== '55432' ||
      decodeURIComponent(url.pathname) !== `/${stagingDatabase}`
    )
      invalid();
  }
  const {
    CHANNEX_STAGING_TENANT_ID: tenantId,
    CHANNEX_STAGING_PROPERTY_ID: propertyId,
    CHANNEX_STAGING_CONNECTION_ID: connectionId,
    CHANNEX_STAGING_EXTERNAL_PROPERTY_ID: externalPropertyId,
    CHANNEX_STAGING_EXTERNAL_ROOM_ID: externalRoomId,
    CHANNEX_STAGING_EXTERNAL_RATE_ID: externalRateId,
    CHANNEX_STAGING_DATE: date,
  } = config;
  if (
    !tenantId ||
    !propertyId ||
    !connectionId ||
    !externalPropertyId ||
    !externalRoomId ||
    !externalRateId ||
    !date
  )
    invalid();
  return {
    tenantId,
    propertyId,
    connectionId,
    externalPropertyId,
    externalRoomId,
    externalRateId,
    date,
    maxTicks: config.CHANNEX_STAGING_MAX_TICKS,
  };
}
export function assertStagingContext(
  scope: StagingWorkerScope,
  context: ConnectionContext,
): void {
  if (
    context.tenant_id !== scope.tenantId ||
    context.property_id !== scope.propertyId ||
    context.connection_id !== scope.connectionId ||
    context.external_property_id !== scope.externalPropertyId ||
    context.provider_key !== 'channex' ||
    context.environment !== 'staging' ||
    context.channel_key !== 'staging-crs' ||
    context.secret_ref !== stagingSecretRef ||
    context.adapter_version !== channexAdapterVersion
  )
    invalid();
}
export function stagingTransportProfile(
  scope: StagingWorkerScope,
  context: ConnectionContext,
): ChannelProfile {
  assertStagingContext(scope, context);
  return {
    channel_key: 'staging-crs',
    provider_key: 'channex',
    environment: 'staging',
    adapter_version: channexAdapterVersion,
    mapping_traits: [
      'Closed isolated Booking CRS transport only; no OTA proof',
    ],
    capabilities: capabilityCodes.map((code) => ({
      capability_code: code,
      status: [
        'rates',
        'absolute_availability',
        'inbound_new',
        'inbound_modified',
        'inbound_cancelled',
      ].includes(code)
        ? 'DOCUMENTED'
        : 'UNKNOWN',
      authorization_status: [
        'rates',
        'absolute_availability',
        'inbound_new',
        'inbound_modified',
        'inbound_cancelled',
      ].includes(code)
        ? 'AUTHORIZED'
        : 'NOT_AUTHORIZED',
      evidence_ref: 'docs/execution/NP-channex-staging-runtime-plan.md',
      checked_at: '2026-10-11',
      test_run_id: null,
      limitations: [
        'Authorized synthetic staging transport; untested by this profile; activation, quota, withdrawal and OTA proof unavailable',
      ],
      owner: 'product-owner',
      recheck_trigger: 'Independent review of scoped staging evidence',
    })),
  };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function assertStagingHttp(
  scope: StagingWorkerScope,
  request: HttpClientRequest,
): void {
  const url = new URL(request.url);
  if (url.origin !== origin || url.username || url.password || url.hash)
    invalid();
  if (request.method === 'GET') {
    if (url.pathname === '/api/v1/booking_revisions/feed') {
      if (
        url.searchParams.get('filter[property_id]') !== scope.externalPropertyId
      )
        invalid();
    } else if (
      !/^\/api\/v1\/booking_revisions\/[A-Za-z0-9-]+$/.test(url.pathname) ||
      url.search
    )
      invalid();
    return;
  }
  if (
    /^\/api\/v1\/booking_revisions\/[A-Za-z0-9-]+\/ack$/.test(url.pathname) &&
    !url.search
  )
    return;
  if (
    !['/api/v1/availability', '/api/v1/restrictions'].includes(url.pathname) ||
    url.search
  )
    invalid();
  const values = record(request.body)['values'];
  if (!Array.isArray(values) || values.length !== 1) invalid();
  const cell = record(values[0]);
  if (
    cell['property_id'] !== scope.externalPropertyId ||
    cell['date'] !== scope.date
  )
    invalid();
  const allowed = url.pathname.endsWith('/availability')
    ? ['property_id', 'room_type_id', 'date', 'availability']
    : ['property_id', 'rate_plan_id', 'date', 'stop_sell'];
  if (Object.keys(cell).some((key) => !allowed.includes(key))) invalid();
  if (url.pathname.endsWith('/availability')) {
    if (
      cell['room_type_id'] !== scope.externalRoomId ||
      cell['availability'] !== 0
    )
      invalid();
  } else if (
    cell['rate_plan_id'] !== scope.externalRateId ||
    cell['stop_sell'] !== true
  )
    invalid();
}
export function assertStagingRevisionResponse(
  scope: StagingWorkerScope,
  request: HttpClientRequest,
  response: HttpClientResponse,
): void {
  if (
    request.method !== 'GET' ||
    response.status < 200 ||
    response.status >= 300
  )
    return;
  const raw = record(response.body)['data'];
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    const attributes = record(record(entry)['attributes']);
    const rooms = attributes['rooms'];
    // Empty cancellation scope cannot prove room/rate ownership; fail before storage/ACK.
    if (
      attributes['property_id'] !== scope.externalPropertyId ||
      attributes['ota_name'] !== 'Offline' ||
      !Array.isArray(rooms) ||
      rooms.length !== 1
    )
      invalid();
    const room = record(rooms[0]);
    const occupancy = record(room['occupancy']);
    if (
      room['room_type_id'] !== scope.externalRoomId ||
      room['rate_plan_id'] !== scope.externalRateId ||
      room['checkin_date'] !== scope.date ||
      room['checkout_date'] !== '2026-10-16' ||
      occupancy['adults'] !== 2 ||
      occupancy['children'] !== 0 ||
      occupancy['infants'] !== 0
    )
      invalid();
  }
}
export function startFiniteStagingTicks(options: {
  maxTicks: number;
  tick: () => Promise<void>;
  onFailure: (error?: unknown) => void;
  intervalMs?: number;
}): { stop: () => Promise<void> } {
  if (
    !Number.isInteger(options.maxTicks) ||
    options.maxTicks < 1 ||
    options.maxTicks > 3
  )
    invalid();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let count = 0;
  const run = () => {
    if (stopping) return;
    count += 1;
    inFlight = options
      .tick()
      .then(() => {
        if (!stopping && count < options.maxTicks)
          timer = setTimeout(run, options.intervalMs ?? 60000);
      })
      .catch((error: unknown) => {
        stopping = true;
        options.onFailure(error);
      });
  };
  timer = setTimeout(run, 0);
  return {
    stop: async () => {
      stopping = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
export async function boundedStagingFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        invalid();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
export async function createStagingWorkerRuntime(
  orm: MikroORM,
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): Promise<DistributionRuntime> {
  const scope = stagingWorkerScope(config);
  const context = async (): Promise<ConnectionContext> =>
    runScopedTransaction(orm, { tenantId: scope.tenantId }, async (em) => {
      const row = await findConnection(em, scope.connectionId);
      if (!row || row.status !== 'DRAFT') invalid();
      const properties = await em.execute<{ status: string }[]>(
        'select "status" from "property" where "id" = ? and "tenant_id" = ?',
        [scope.propertyId, scope.tenantId],
      );
      if (properties.length !== 1 || properties[0]?.status === 'ARCHIVED')
        invalid();
      const result: ConnectionContext = {
        connection_id: row.id,
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        provider_key: row.provider_key,
        environment: row.environment,
        channel_key: row.channel_key,
        secret_ref: row.secret_ref,
        external_property_id: row.external_property_id,
        adapter_version: channexAdapterVersion,
      };
      assertStagingContext(scope, result);
      return result;
    });
  await context();
  const transport = createChannexHttpClient({
    allowHosts: ['staging.channex.io'],
    live: true,
    allowExternal: true,
    fetchImpl: boundedStagingFetch,
  });
  let requests = 0;
  const adapter = new ChannexAdapter({
    baseUrl: `${origin}/api/v1`,
    authHeaderName: 'user-api-key',
    channelKeyByOtaName: { offline: 'staging-crs' },
    resolveSecret: async (ref) => {
      await context();
      if (ref !== stagingSecretRef || !env['NP_CHANNEX_STAGING_KEY']) invalid();
      return env['NP_CHANNEX_STAGING_KEY'];
    },
    http: async (request) => {
      assertStagingHttp(scope, request);
      requests += 1;
      if (requests > 60) invalid();
      const response = await transport(request);
      assertStagingRevisionResponse(scope, request, response);
      return response;
    },
  });
  const runtime: DistributionRuntime = new DistributionRuntime({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor: (value) => stagingTransportProfile(scope, value),
    owner: `staging-worker-${process.pid}`,
    connectionScope: scope,
    maxAttempts: 1,
    beforeScopedTick: async () => {
      const current = await inStagingPhase('CONTEXT', context);
      await inStagingPhase('PULL', () =>
        runtime.pullConnection(current, scope.tenantId, scope.propertyId, 10),
      );
    },
  });
  return runtime;
}
