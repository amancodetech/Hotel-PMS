#!/usr/bin/env node
// Root-run adapter transport trial; never a worker, reservation, or OTA proof.
import { readFile, mkdir, open, rename, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ChannexAdapter,
  channexAdapterVersion,
  createChannexHttpClient,
} from '../packages/backend/dist/modules/distribution/index.js';

const args = process.argv.slice(2),
  mode = args.shift(),
  opts = {};
for (let at = 0; at < args.length; at += 2) {
  if (!args[at].startsWith('--') || !args[at + 1])
    throw new Error('Expected --option value');
  opts[args[at].slice(2)] = args[at + 1];
}
const fail = (message) => {
  throw Object.assign(new Error(message), { safeTrial: true });
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const HOST = 'https://staging.channex.io/api/v1';
const META = {
  deadline_ms: 15000,
  correlation_id: 'NP-STAGING-TRANSPORT-ONLY',
};
let requests = 0;
async function atomic(path, value, exclusive = false) {
  const target = exclusive ? path : `${path}.${process.pid}.tmp`;
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(json(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!exclusive) await rename(target, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function boundedFetch(url, init) {
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://staging.channex.io' ||
    parsed.username ||
    parsed.password ||
    !/^\/api\/v1\/(availability|restrictions|booking_revisions\/feed)$/.test(
      parsed.pathname,
    )
  )
    fail('Transport trial endpoint denied');
  if (++requests > 24) fail('Trial request budget exhausted');
  const response = await fetch(url, { ...init, redirect: 'error' });
  const reader = response.body?.getReader();
  if (!reader) fail('Provider returned no response body');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        fail('Provider body exceeds bound');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}
function provider() {
  const key =
    process.env.CHANNEX_STAGING_API_KEY ?? process.env.CHANNEX_API_KEY;
  if (!key || /[\r\n]/.test(key)) fail('Missing scoped staging credential');
  return new ChannexAdapter({
    baseUrl: HOST,
    authHeaderName: 'user-api-key',
    resolveSecret: async (ref) => {
      if (ref !== 'private:NP-staging') fail('Unknown secret reference');
      return key;
    },
    http: createChannexHttpClient({
      allowHosts: ['staging.channex.io'],
      live: true,
      allowExternal: true,
      maxBodyBytes: 2_000_000,
      fetchImpl: boundedFetch,
    }),
    channelKeyByOtaName: { Offline: 'staging-crs', offline: 'staging-crs' },
  });
}
async function sourceHashes() {
  const paths = [
    'scripts/channex-staging-transport-trial.mjs',
    'packages/backend/src/modules/distribution/adapters/channex/channex-adapter.ts',
    'packages/backend/src/modules/distribution/adapters/channex/normalize.ts',
    'packages/backend/dist/modules/distribution/adapters/channex/channex-adapter.js',
    'packages/backend/dist/modules/distribution/adapters/channex/normalize.js',
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, hash(await readFile(path))]),
    ),
  );
}
async function main() {
  if (!['plan', 'apply', 'check', 'restore'].includes(mode))
    fail(
      'Usage: plan|apply|check|restore --out private-dir [--catalog private-catalog-dir --property-title exact-title --date YYYY-MM-DD] [--approve-plan-sha256 digest]',
    );
  const out = resolve(opts.out ?? fail('--out required'));
  if (!out.startsWith(`${resolve('.local/verification')}/`))
    fail('Private verification output required');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const info = await lstat(out);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    fail('Output must be private0700');
  const adapter = provider();
  const planPath = `${out}/transport-plan.json`;
  if (mode === 'plan') {
    const catalog = resolve(opts.catalog ?? fail('--catalog required'));
    const raw = await readFile(`${catalog}/plan.json`),
      catalogPlan = JSON.parse(raw);
    let receipt;
    try {
      receipt = JSON.parse(await readFile(`${catalog}/check-receipt.json`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      receipt = JSON.parse(await readFile(`${catalog}/apply-receipt.json`));
    }
    const journal = JSON.parse(await readFile(`${catalog}/journal.json`));
    if (
      receipt.status !== 'STAGING_CLOSED_CATALOG_VERIFIED' ||
      receipt.plan_sha256 !== hash(raw) ||
      journal.plan_sha256 !== hash(raw)
    )
      fail('Missing matching verified catalog receipt');
    const p = catalogPlan.properties.find(
      (p) => p.payload.title === opts['property-title'],
    );
    if (!p) fail('Exact catalog property title required');
    const propertyId = journal.operations[`properties:${p.key}`]?.id;
    const room =
      p.rooms.find(
        (r) =>
          r.pms.physical_leaf_resource_ids.length === 1 &&
          r.pms.resource_code.includes('-R'),
      ) ?? p.rooms.find((r) => r.pms.resource_code.startsWith('KL'));
    if (!room) fail('No atomic room in selected property');
    const roomId = journal.operations[`room_types:${room.key}`]?.id,
      rateId = journal.operations[`rate_plans:${room.key}`]?.id;
    if (![propertyId, roomId, rateId].every(uuid))
      fail('Catalog external identifiers missing');
    const date = opts.date ?? fail('--date required'),
      at = Date.parse(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(at) ||
      new Date(at).toISOString().slice(0, 10) !== date ||
      date < catalogPlan.date_from ||
      date > catalogPlan.date_to
    )
      fail('Date outside verified catalog window');
    const context = {
      connection_id: '00000000-0000-4000-8000-000000000013',
      tenant_id: room.pms.tenant_id,
      property_id: room.pms.property_id,
      provider_key: 'channex',
      environment: 'staging',
      channel_key: 'staging-crs',
      secret_ref: 'private:NP-staging',
      external_property_id: propertyId,
      adapter_version: channexAdapterVersion,
    };
    const scope = {
      product_refs: [roomId],
      rate_refs: [rateId],
      date_from: date,
      date_to: date,
    };
    const initial = await adapter.readAriState(context, scope, META);
    if (
      initial.availability[roomId][date] !== 0 ||
      initial.restrictions[rateId][date].stop_sell !== true ||
      Number(initial.restrictions[rateId][date].rate) !== 100000
    )
      fail(
        'Selected room baseline must be zero availability, stop sell and IDR100000',
      );
    const feed = await adapter.pullRevisions(context, null, 20, META);
    // This batch is not allowed to persist bookings or ACK around the materialization gap.
    if (feed.revisions.length || feed.next_cursor)
      fail(
        'Scoped feed contains revisions; stop for actual persisted-runtime batch, do not ACK',
      );
    const plan = {
      schema: 1,
      host: HOST,
      context,
      scope,
      catalog_path: catalog,
      catalog_plan_sha256: hash(raw),
      property_title: p.payload.title,
      room_name: room.pms.name,
      room_pms_refs: room.pms,
      dummy_rate_idr: '110000.00',
      restoration_rate_idr: '100000.00',
      initial,
      source_hashes: await sourceHashes(),
      proof_level: 'ADAPTER_TRANSPORT_ONLY',
      worker_wiring_proven: false,
      reservation_pipeline_proven: false,
      channel_cutoff_proven: false,
    };
    await atomic(planPath, plan, true);
    console.log(
      json({
        status: 'READ_ONLY_TRANSPORT_PLAN_READY',
        plan_sha256: hash(json(plan)),
        plan_path: planPath,
      }).trim(),
    );
    return;
  }
  const raw = await readFile(planPath),
    plan = JSON.parse(raw),
    digest = hash(raw);
  if (
    plan.host !== HOST ||
    !uuid(plan.context.external_property_id) ||
    plan.context.environment !== 'staging' ||
    plan.context.channel_key !== 'staging-crs' ||
    plan.dummy_rate_idr !== '110000.00' ||
    plan.restoration_rate_idr !== '100000.00' ||
    JSON.stringify(plan.source_hashes) !== JSON.stringify(await sourceHashes())
  )
    fail('Transport source/plan changed');
  if (
    ['apply', 'restore'].includes(mode) &&
    opts['approve-plan-sha256'] !== digest
  )
    fail('Root-reviewed exact plan SHA required');
  const lock = await open(`${out}/transport.lock`, 'wx', 0o600).catch(() =>
    fail('Existing lock: root verify stopped PID and preserve before clearing'),
  );
  await lock.writeFile(json({ pid: process.pid, mode, plan_sha256: digest }));
  await lock.sync();
  await lock.close();
  const journalPath = `${out}/transport-journal.json`;
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    journal = { plan_sha256: digest, operations: {} };
  }
  if (journal.plan_sha256 !== digest) fail('Transport journal mismatch');
  const roomId = plan.scope.product_refs[0],
    rateId = plan.scope.rate_refs[0],
    date = plan.scope.date_from;
  const observed = await adapter.readAriState(plan.context, plan.scope, META);
  if (
    observed.availability[roomId][date] !== 0 ||
    observed.restrictions[rateId][date].stop_sell !== true
  )
    fail('Closed safety prerequisite changed');
  async function write(name, fn) {
    if (journal.operations[name])
      fail('Prior mutation recorded; reconcile via check, never blind repeat');
    journal.operations[name] = {
      state: 'INTENT',
      at: new Date().toISOString(),
    };
    await atomic(journalPath, journal);
    const result = await fn();
    journal.operations[name] = { state: 'RESPONSE', result };
    await atomic(journalPath, journal);
    if (result.certainty !== 'PROVIDER_ACCEPTED' || result.warnings.length)
      fail(
        'Provider outcome not accepted; journal retained for read-only reconciliation',
      );
  }
  if (mode === 'apply') {
    if (
      Number(observed.restrictions[rateId][date].rate) !==
      Number(plan.restoration_rate_idr)
    )
      fail('Initial price baseline changed');
    await write('availability', () =>
      adapter.pushAvailability(
        plan.context,
        {
          schema_version: 1,
          connection_id: plan.context.connection_id,
          channel_key: 'staging-crs',
          inventory_version: 0,
          cells: [
            { product_ref: roomId, date, available: 0, inventory_version: 0 },
          ],
        },
        META,
      ),
    );
    await write('restrictions', () =>
      adapter.pushRestrictions(
        plan.context,
        {
          schema_version: 1,
          connection_id: plan.context.connection_id,
          channel_key: 'staging-crs',
          inventory_version: 0,
          cells: [
            {
              rate_ref: rateId,
              date,
              price: plan.dummy_rate_idr,
              currency: 'IDR',
              min_stay: null,
              max_stay: null,
              stop_sell: true,
              closed_to_arrival: null,
              closed_to_departure: null,
              inventory_version: 0,
            },
          ],
        },
        META,
      ),
    );
  }
  if (!journal.operations.availability || !journal.operations.restrictions)
    fail('No trial mutation evidence; readback alone is insufficient');
  let final = await adapter.readAriState(plan.context, plan.scope, META);
  function matches(state, rate) {
    return (
      state.availability[roomId][date] === 0 &&
      state.restrictions[rateId][date].stop_sell === true &&
      Number(state.restrictions[rateId][date].rate) === Number(rate)
    );
  }
  if (matches(final, plan.dummy_rate_idr)) {
    journal.trial_observed = {
      state: 'GET_MATCHED',
      observations: final,
      at: new Date().toISOString(),
    };
    await atomic(journalPath, journal);
    if (mode === 'check') {
      const pending = {
        status: 'TRIAL_GET_VERIFIED_RESTORE_PENDING',
        plan_sha256: digest,
        temporary_observations: final,
        restoration_rate_idr: plan.restoration_rate_idr,
        g13_accepted: false,
      };
      await atomic(`${out}/check-receipt.json`, pending);
      console.log(json(pending).trim());
      return;
    }
    await write('restore-restrictions', () =>
      adapter.pushRestrictions(
        plan.context,
        {
          schema_version: 1,
          connection_id: plan.context.connection_id,
          channel_key: 'staging-crs',
          inventory_version: 0,
          cells: [
            {
              rate_ref: rateId,
              date,
              price: plan.restoration_rate_idr,
              currency: 'IDR',
              min_stay: null,
              max_stay: null,
              stop_sell: true,
              closed_to_arrival: null,
              closed_to_departure: null,
              inventory_version: 0,
            },
          ],
        },
        META,
      ),
    );
    final = await adapter.readAriState(plan.context, plan.scope, META);
  }
  if (
    !journal.trial_observed ||
    !journal.operations['restore-restrictions'] ||
    !matches(final, plan.restoration_rate_idr)
  )
    fail(
      'Trial or restored baseline not verified; check later without repeating mutation',
    );
  const feed = await adapter.pullRevisions(plan.context, null, 20, META);
  if (feed.revisions.length || feed.next_cursor)
    fail('Revisions require persisted-runtime next batch; never ACK here');
  const receipt = {
    status: 'STAGING_ADAPTER_TRANSPORT_VERIFIED_WITH_LIMITS',
    plan_sha256: digest,
    external_property_id: plan.context.external_property_id,
    external_room_id: roomId,
    external_rate_id: rateId,
    date,
    temporary_observations: journal.trial_observed.observations,
    restored_observations: final,
    baseline_restored: true,
    empty_property_scoped_feed: true,
    requests,
    actual_worker_wiring: false,
    persisted_inbox_ack_proven: false,
    operational_reservation_lifecycle: false,
    ota_channel_evidence: false,
    withdrawal_cutoff_proof: false,
    g13_accepted: false,
    checked_at: new Date().toISOString(),
  };
  await atomic(`${out}/${mode}-receipt.json`, receipt);
  journal.observed = { state: 'GET_MATCHED', at: receipt.checked_at };
  await atomic(journalPath, journal);
  console.log(json(receipt).trim());
}
main().catch((error) => {
  const codes = new Set([
    'VALIDATION_FAILED',
    'UNSUPPORTED',
    'NOT_FOUND',
    'RATE_LIMITED',
    'PROVIDER_ERROR',
    'UNKNOWN',
  ]);
  console.error(
    `TRANSPORT_TRIAL_STOP: ${error.safeTrial ? error.message : codes.has(error.code) ? `adapter safe code ${error.code}` : 'inspect private journal and root evidence'}; no automatic retry`,
  );
  process.exitCode = 1;
});
