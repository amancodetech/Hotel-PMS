import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// Structural validation only: the reviewer must independently verify provider
// provenance. No local fixture is itself evidence of a live channel.
export function validateChannelEvidence(ref, expected, root = process.cwd()) {
  assert(typeof ref === 'string' && ref.trim(), 'evidence_ref must be a path');
  const base = realpathSync(root);
  const path = realpathSync(resolve(base, ref));
  assert(
    path.startsWith(`${base}${sep}`),
    'evidence must be inside repository',
  );
  assert(statSync(path).isFile(), 'evidence must be a regular file');
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(evidence.evidence_version, 1, 'unsupported evidence version');
  assert.equal(
    evidence.kind,
    'official-channel-test',
    'official evidence required',
  );
  assert.equal(evidence.provider_key, 'channex', 'real provider required');
  for (const field of [
    'provider_key',
    'channel_key',
    'environment',
    'connection_id',
    'profile',
    'test_run_id',
  ]) {
    assert(
      typeof evidence[field] === 'string' && evidence[field].trim(),
      `${field} required`,
    );
    if (Object.hasOwn(expected, field)) {
      assert(
        typeof expected[field] === 'string' && expected[field].trim(),
        `${field} binding required`,
      );
      assert.equal(evidence[field], expected[field], `${field} mismatch`);
    }
  }
  assert(
    ['staging', 'production'].includes(evidence.environment),
    'live environment required',
  );
  assert.equal(evidence.profile, evidence.environment, 'profile mismatch');
  assert.match(
    evidence.connection_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'connection UUID required',
  );
  assert.equal(evidence.synthetic, false, 'synthetic evidence forbidden');
  assert.equal(evidence.live_tested, true, 'live test required');
  assert.equal(
    evidence.authorization_status,
    'AUTHORIZED',
    'authorization required',
  );
  assert(
    typeof evidence.authorization_ref === 'string' &&
      evidence.authorization_ref.trim(),
    'authorization ref required',
  );
  assert(
    typeof evidence.adapter_version === 'string' &&
      evidence.adapter_version.trim(),
    'adapter version required',
  );
  assert(
    typeof evidence.checked_at === 'string' &&
      Number.isFinite(Date.parse(evidence.checked_at)) &&
      Date.parse(evidence.checked_at) <= Date.now(),
    'valid checked_at required',
  );
  assert(
    Array.isArray(evidence.at_codes) &&
      evidence.at_codes.length > 0 &&
      evidence.at_codes.every((code) => /^AT-C(0[1-9]|10)$/.test(code)),
    'test capabilities required',
  );
  if (expected.at_code)
    assert(
      evidence.at_codes.includes(expected.at_code),
      'test capability missing',
    );
  const authorization = realpathSync(resolve(base, evidence.authorization_ref));
  assert(
    authorization.startsWith(`${base}${sep}`) &&
      statSync(authorization).isFile(),
    'authorization artifact required',
  );
  const provenance = evidence.provenance;
  assert(
    provenance && provenance.kind === 'official-provider',
    'official provenance required',
  );
  const url = new URL(provenance.evidence_url);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'channex.io' || url.hostname.endsWith('.channex.io')),
    'official provider URL required',
  );
  assert(
    typeof provenance.artifact_ref === 'string' &&
      provenance.artifact_ref.trim(),
    'artifact ref required',
  );
  const artifact = realpathSync(
    resolve(dirname(path), provenance.artifact_ref),
  );
  assert(
    artifact.startsWith(`${base}${sep}`) && statSync(artifact).isFile(),
    'artifact must exist inside repository',
  );
  assert.match(
    provenance.sha256 ?? '',
    /^[0-9a-f]{64}$/,
    'artifact hash required',
  );
  assert.equal(
    createHash('sha256').update(readFileSync(artifact)).digest('hex'),
    provenance.sha256,
    'artifact hash mismatch',
  );
  return evidence;
}
