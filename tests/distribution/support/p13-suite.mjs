import {
  SimulatorAdapter,
  SimulatorEngine,
  lifecycleScenario,
  realChannelKeys,
  simulatorTestProfile,
  syntheticSixthChannelKey,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import { channelCatalog } from '../../../packages/contracts/dist/distribution.js';

const connectionId = '22222222-3333-4444-8555-666666666666';
const tenantId = '22222222-3333-4444-8555-777777777777';
const propertyId = '22222222-3333-4444-8555-888888888888';
const meta = { deadline_ms: 3000, correlation_id: 'P13-local-conformance' };

export function context(channelKey, provider = 'simulator') {
  return {
    connection_id: connectionId,
    tenant_id: tenantId,
    property_id: propertyId,
    provider_key: provider,
    environment: 'test',
    channel_key: channelKey,
    secret_ref: 'secret:synthetic',
    external_property_id: 'EXT-P13',
    adapter_version: 'simulator-1.0.0',
  };
}

function allowedKeys() {
  return [...realChannelKeys(), syntheticSixthChannelKey];
}

function adapterFor(channelKey, overrides = {}) {
  return new SimulatorAdapter({
    engine: new SimulatorEngine(lifecycleScenario(channelKey, overrides)),
    allowedChannelKeys: allowedKeys(),
  });
}

function availability(channelKey, available = 1) {
  return {
    schema_version: 1,
    connection_id: connectionId,
    channel_key: channelKey,
    inventory_version: 7,
    cells: [
      {
        product_ref: 'ROOM-1',
        date: '2026-10-01',
        available,
        inventory_version: 7,
      },
    ],
  };
}

function restrictions(channelKey, stopSell) {
  return {
    schema_version: 1,
    connection_id: connectionId,
    channel_key: channelKey,
    inventory_version: 7,
    cells: [
      {
        rate_ref: 'RATE-1',
        date: '2026-10-01',
        price: null,
        currency: null,
        min_stay: null,
        max_stay: null,
        stop_sell: stopSell,
        closed_to_arrival: null,
        closed_to_departure: null,
        inventory_version: 7,
      },
    ],
  };
}

export async function runAdapterConformance(channelKey) {
  const checks = [];
  const check = (id, passed, detail) =>
    checks.push({ id, passed: Boolean(passed), detail });

  const ctx = context(channelKey);

  const baseline = adapterFor(channelKey);
  const accepted = await baseline.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'availability-provider-accepted-is-not-channel-verified',
    accepted.certainty === 'PROVIDER_ACCEPTED' &&
      accepted.certainty !== 'CHANNEL_VERIFIED',
    `certainty=${accepted.certainty}`,
  );
  const providerState = await baseline.readProviderState(
    ctx,
    {
      product_refs: ['ROOM-1'],
      date_from: '2026-10-01',
      date_to: '2026-10-02',
    },
    meta,
  );
  check(
    'readback-is-provider-state-not-channel-proof',
    providerState.certainty === 'PROVIDER_ACCEPTED',
    `certainty=${providerState.certainty}`,
  );
  const noEvidence = await baseline.readChannelEvidence(
    ctx,
    {
      product_refs: ['ROOM-1'],
      date_from: '2026-10-01',
      date_to: '2026-10-02',
    },
    meta,
  );
  check(
    'channel-evidence-unavailable-stays-unknown',
    noEvidence.certainty === 'UNKNOWN' &&
      noEvidence.warnings.includes('CHANNEL_EVIDENCE_UNAVAILABLE'),
    `certainty=${noEvidence.certainty}`,
  );

  const verified = new SimulatorAdapter({
    engine: new SimulatorEngine(
      lifecycleScenario(channelKey, { verified_channel: true }),
    ),
    allowedChannelKeys: allowedKeys(),
  });
  const evidence = await verified.readChannelEvidence(
    ctx,
    {
      product_refs: ['ROOM-1'],
      date_from: '2026-10-01',
      date_to: '2026-10-02',
    },
    meta,
  );
  check(
    'channel-evidence-verified-only-with-proof',
    evidence.certainty === 'CHANNEL_VERIFIED',
    `certainty=${evidence.certainty}`,
  );

  const rateLimited = adapterFor(channelKey, {
    failures: [
      {
        operation: 'pushAvailability',
        kind: 'rate_limited',
        times: 1,
        retry_after_ms: 1000,
      },
    ],
  });
  const limited = await rateLimited.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-rate-limit-is-unknown-with-retry-after',
    limited.certainty === 'UNKNOWN' && limited.retry_after_ms === 1000,
    `certainty=${limited.certainty} retry_after_ms=${limited.retry_after_ms}`,
  );
  const afterLimit = await rateLimited.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-retry-succeeds-without-false-verification',
    afterLimit.certainty === 'PROVIDER_ACCEPTED' &&
      afterLimit.certainty !== 'CHANNEL_VERIFIED',
    `certainty=${afterLimit.certainty}`,
  );

  const afterSend = adapterFor(channelKey, {
    failures: [
      { operation: 'pushAvailability', kind: 'timeout_after_send', times: 1 },
    ],
  });
  const lost = await afterSend.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-timeout-after-send-is-unknown-not-not-sent',
    lost.certainty === 'UNKNOWN',
    `certainty=${lost.certainty}`,
  );
  const beforeSend = adapterFor(channelKey, {
    failures: [
      { operation: 'pushAvailability', kind: 'timeout_before_send', times: 1 },
    ],
  });
  const notSent = await beforeSend.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-timeout-before-send-is-not-sent',
    notSent.certainty === 'NOT_SENT',
    `certainty=${notSent.certainty}`,
  );

  const partial = adapterFor(channelKey, {
    unknown_cells: ['ROOM-1:2026-10-01'],
  });
  const partialResult = await partial.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-partial-cells-never-report-accepted',
    partialResult.certainty === 'PARTIAL' &&
      partialResult.cell_results[0]?.status === 'UNKNOWN',
    `certainty=${partialResult.certainty} cell=${partialResult.cell_results[0]?.status}`,
  );
  const rejected = adapterFor(channelKey, {
    rejected_cells: ['ROOM-1:2026-10-01'],
  });
  const rejectedResult = await rejected.pushAvailability(
    ctx,
    availability(channelKey),
    meta,
  );
  check(
    'at-c05-rejected-cell-is-rejected',
    rejectedResult.certainty === 'REJECTED' &&
      rejectedResult.cell_results[0]?.status === 'REJECTED',
    `certainty=${rejectedResult.certainty}`,
  );

  const ackEngine = adapterFor(channelKey);
  const firstAck = await ackEngine.acknowledgeRevision(
    ctx,
    `${channelKey}-R1`,
    meta,
  );
  const replayAck = await ackEngine.acknowledgeRevision(
    ctx,
    `${channelKey}-R1`,
    meta,
  );
  check(
    'at-c04-ack-replay-is-idempotent',
    firstAck.certainty === 'PROVIDER_ACCEPTED' &&
      replayAck.provider_request_id === firstAck.provider_request_id,
    `first=${firstAck.certainty} replay=${replayAck.certainty}`,
  );

  const page = await baseline.pullRevisions(ctx, null, 10, meta);
  const newRevision = page.revisions.find(
    (revision) => revision.revision_type === 'new',
  );
  check(
    'at-c10-money-keeps-source-values-and-unknown-as-unknown',
    newRevision?.amount_total === '1250000.50' &&
      newRevision?.currency === 'IDR' &&
      newRevision?.commission_amount === null &&
      newRevision?.net_amount === null,
    `amount=${newRevision?.amount_total} currency=${newRevision?.currency} commission=${newRevision?.commission_amount}`,
  );

  const stop = await baseline.pushRestrictions(
    ctx,
    restrictions(channelKey, true),
    meta,
  );
  const open = await baseline.pushRestrictions(
    ctx,
    restrictions(channelKey, false),
    meta,
  );
  check(
    'at-c03-stop-sell-and-open-are-provider-accepted-not-verified',
    stop.certainty === 'PROVIDER_ACCEPTED' &&
      open.certainty === 'PROVIDER_ACCEPTED' &&
      stop.certainty !== 'CHANNEL_VERIFIED',
    `stop=${stop.certainty} open=${open.certainty}`,
  );

  const otherChannel =
    realChannelKeys().find((key) => key !== channelKey) ?? 'booking-com';
  const isolatedEngine = new SimulatorEngine(
    lifecycleScenario(channelKey, {
      failures: [
        { operation: 'pushAvailability', kind: 'server_error', times: 1 },
      ],
    }),
  );
  const isolated = new SimulatorAdapter({
    engine: isolatedEngine,
    allowedChannelKeys: allowedKeys(),
  });
  const other = new SimulatorAdapter({
    engine: new SimulatorEngine(lifecycleScenario(otherChannel)),
    allowedChannelKeys: allowedKeys(),
  });
  let failingCertainty;
  try {
    const response = await isolated.pushAvailability(
      ctx,
      availability(channelKey),
      meta,
    );
    failingCertainty = response.certainty;
  } catch {
    failingCertainty = 'THROWN';
  }
  const otherPush = await other.pushAvailability(
    context(otherChannel),
    availability(otherChannel),
    meta,
  );
  check(
    'channel-isolation-failure-on-one-channel-does-not-block-another',
    !['PROVIDER_ACCEPTED', 'CHANNEL_VERIFIED'].includes(failingCertainty) &&
      otherPush.certainty === 'PROVIDER_ACCEPTED',
    `${channelKey}=${failingCertainty} ${otherChannel}=${otherPush.certainty}`,
  );

  const profile = simulatorTestProfile(channelKey);
  check(
    'simulator-profile-is-synthetic-evidence-only',
    profile.capabilities.every((entry) =>
      entry.limitations.some((line) => line.includes('never upgrades')),
    ),
    `capabilities=${profile.capabilities.length}`,
  );

  return {
    channel_key: channelKey,
    checks,
    passed: checks.every((entry) => entry.passed),
  };
}

export function certificationChecklist() {
  return [
    {
      code: 'AT-C01',
      local_coverage: 'adapter-inspect-mappings-and-activation-gate',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C02',
      local_coverage: 'at-c04-ack-replay-plus-p06 revision suite',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C03',
      local_coverage: 'at-c03-stop-sell-and-open',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C04',
      local_coverage: 'at-c04-ack-replay-is-idempotent',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C05',
      local_coverage: 'at-c05-rate-limit/timeout/partial/rejected',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C06',
      local_coverage:
        'tests/property/reservation-import.pg.test.mjs (P06-05 file+feed once)',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C07',
      local_coverage:
        'tests/property/p13-conformance.pg.test.mjs AT-C07 D-20 quota',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C08',
      local_coverage:
        'tests/property/inventory-constraints + composition-* suites',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C09',
      local_coverage:
        'tests/property/p13-conformance.pg.test.mjs AT-C09 recovery freeze',
      live_status: 'BLOCKED_EXTERNAL',
    },
    {
      code: 'AT-C10',
      local_coverage: 'at-c10 adapter check + tests/finance-money.test.mjs',
      live_status: 'BLOCKED_EXTERNAL',
    },
  ];
}

export function channelKeys() {
  return channelCatalog.map((entry) => entry.key);
}
