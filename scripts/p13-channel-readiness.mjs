import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { validateChannelEvidence } from './support/p13-evidence.mjs';
import { channelCatalog } from '../packages/contracts/dist/distribution.js';

const registryPath = 'docs/execution/channels/channel-readiness.json';
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const emitDocs = process.argv.includes('--emit-docs');
const evidenceDir =
  process.env.P13_EVIDENCE_DIR ?? '.local/verification/P13-04';
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const logPath = `${evidenceDir}/channel-readiness-check.log`;
const log = (line) => {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(logPath, `${stamped}\n`, { mode: 0o600 });
};

const atCodes = Array.from(
  { length: 10 },
  (_, index) => `AT-C${String(index + 1).padStart(2, '0')}`,
);
const channelKeys = channelCatalog.map((entry) => entry.key);
const allowedTestStates = new Set(['NOT_TESTED', 'EXTERNAL_VERIFIED']);
const allowedResourceStates = new Set([
  'NOT_DECLARED',
  'DECLARED_AND_TESTED',
  'BLOCKED',
]);

assert.equal(registry.registry_version, 1, 'registry_version must be 1');
assert(
  Array.isArray(registry.channels) &&
    registry.channels.length === channelKeys.length,
  'registry must cover exactly the five channels',
);
const byKey = new Map();
for (const channel of registry.channels) {
  assert(!byKey.has(channel.channel_key), `duplicate ${channel.channel_key}`);
  byKey.set(channel.channel_key, channel);
}
assert.deepEqual(
  [...byKey.keys()].sort(),
  [...channelKeys].sort(),
  'channel keys must match the production catalog',
);

let declared = 0;
const lines = [];
for (const key of channelKeys) {
  const channel = byKey.get(key);
  assert.equal(
    channel.provider_key,
    'channex',
    `${key} provider must be channex for V1`,
  );
  assert(
    ['NOT_TESTED', 'EXTERNAL_VERIFIED'].includes(channel.status),
    `${key} status unsupported`,
  );
  assert(
    ['NOT_AUTHORIZED', 'AUTHORIZED'].includes(channel.authorization_status),
    `${key} authorization unsupported`,
  );
  let liveEvidence;
  if (
    channel.live_evidence_ref !== null &&
    channel.live_evidence_ref !== undefined
  ) {
    liveEvidence = validateChannelEvidence(channel.live_evidence_ref, {
      provider_key: channel.provider_key,
      channel_key: key,
      environment: channel.environment,
      connection_id: channel.connection_id,
      profile: channel.profile,
    });
    for (const field of ['environment', 'connection_id', 'profile'])
      assert.equal(
        channel[field],
        liveEvidence[field],
        `${key}/${field} required and bound`,
      );
  }
  if (
    channel.authorization_status === 'AUTHORIZED' ||
    channel.status === 'EXTERNAL_VERIFIED'
  )
    assert(
      liveEvidence && channel.authorization_status === 'AUTHORIZED',
      `${key} verified/authorized needs validated live evidence`,
    );
  assert(
    Array.isArray(channel.required_evidence) &&
      channel.required_evidence.length > 0,
    `${key} must enumerate required evidence`,
  );
  assert(
    Array.isArray(channel.permissions_required) &&
      channel.permissions_required.length > 0,
    `${key} must list the permissions needed`,
  );
  assert(
    Array.isArray(channel.prices_and_terms) &&
      channel.prices_and_terms.length > 0,
    `${key} must document price/term checks`,
  );
  const resourceEntries = Object.entries(channel.resources ?? {});
  assert(resourceEntries.length >= 10, `${key} must cover the resource matrix`);
  for (const [resource, state] of resourceEntries) {
    assert(
      allowedResourceStates.has(state),
      `${key}/${resource} unsupported state`,
    );
    if (state === 'DECLARED_AND_TESTED') {
      declared += 1;
      assert(
        liveEvidence &&
          channel.authorization_status === 'AUTHORIZED' &&
          liveEvidence.resources?.includes(resource),
        `${key}/${resource} cannot be DECLARED_AND_TESTED without a live evidence ref`,
      );
    }
  }
  for (const code of atCodes) {
    const cell = channel.tests?.[code];
    assert(cell, `${key} missing cell ${code}`);
    assert(
      allowedTestStates.has(cell.status),
      `${key}/${code} unsupported status`,
    );
    if (cell.status === 'EXTERNAL_VERIFIED') {
      assert(
        typeof cell.test_run_id === 'string' && cell.test_run_id.trim(),
        `${key}/${code} test_run_id required`,
      );
      assert(
        liveEvidence && channel.authorization_status === 'AUTHORIZED',
        `${key}/${code} needs validated channel evidence`,
      );
      validateChannelEvidence(cell.evidence_ref, {
        provider_key: channel.provider_key,
        channel_key: key,
        environment: liveEvidence.environment,
        connection_id: liveEvidence.connection_id,
        profile: liveEvidence.profile,
        test_run_id: cell.test_run_id,
        at_code: code,
      });
    }
    if (cell.status === 'NOT_TESTED')
      assert(
        cell.evidence_ref === null && cell.test_run_id === null,
        `${key}/${code} NOT_TESTED cannot carry evidence`,
      );
  }
  lines.push(
    `${key}: status=${channel.status} authorization=${channel.authorization_status} ` +
      `resources=${resourceEntries.length} tests=${atCodes.length} declared=${resourceEntries.filter(([, state]) => state === 'DECLARED_AND_TESTED').length}`,
  );
}

if (emitDocs) {
  for (const key of channelKeys) {
    const channel = byKey.get(key);
    const docsPath = `docs/execution/channels/${key}.md`;
    const tests = atCodes
      .map((code) => {
        const cell = channel.tests[code];
        return `| ${code} | ${cell.status} | ${cell.evidence_ref ?? '—'} | ${cell.test_run_id ?? '—'} |`;
      })
      .join('\n');
    const resources = Object.entries(channel.resources)
      .map(([resource, state]) => `| ${resource} | ${state} |`)
      .join('\n');
    writeFileSync(
      docsPath,
      `# حزمة أدلة القناة: ${channel.display_name}

> مولّد من \`channel-readiness.json\` — كل الخلايا NOT_TESTED/NOT_DECLARED حتى دليل حي مخول.
> المحاكي أو قناة أخرى لا يملأ أي خلية ([docs/35](../../../docs/35_live_channels_runbook.md)).

- القناة: \`${channel.channel_key}\` · المزود: \`${channel.provider_key}\` · الحالة: **${channel.status}** · التفويض: **${channel.authorization_status}**
- أصل الدليل الحي (عند وجوده): \`${channel.live_evidence_ref ?? 'BLOCKED_EXTERNAL'}\`

## مصفوفة AT-C

| الاختبار | الحالة | evidence_ref | test_run_id |
|---|---|---|---|
${tests}

## الموارد

| النوع | الحالة |
|---|---|
${resources}

## الصلاحيات المطلوبة والاختبارات الخاصة

${channel.permissions_required.map((entry) => `- \`${entry}\``).join('\n')}

${channel.mapping_focus.map((entry) => `- ${entry}`).join('\n')}

## الأسعار/الشروط

${channel.prices_and_terms.map((entry) => `- ${entry}`).join('\n')}

## الدليل المطلوب للتفعيل

${channel.required_evidence.map((entry) => `- ${entry}`).join('\n')}
`,
    );
    log(`emitted ${docsPath}`);
  }
}

log(
  `channel readiness: ${channelKeys.length}/5 channels valid; DECLARED_AND_TESTED cells=${declared}`,
);
for (const line of lines) log(line);
log('live cells remain NOT_TESTED; no simulator evidence is accepted here.');
if (!existsSync(registryPath)) process.exit(1);
