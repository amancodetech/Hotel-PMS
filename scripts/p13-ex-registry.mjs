import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const registryPath = 'docs/execution/channels/ex-registry.json';
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const allowedStatuses = new Set([
  'NOT_STARTED',
  'IN_PROGRESS_LOCAL',
  'BLOCKED_EXTERNAL',
  'SATISFIED',
]);
const requiredIds = ['EX-01', 'EX-02', 'EX-03', 'EX-04', 'EX-05'];

assert.equal(registry.registry_version, 1, 'registry_version must be 1');
assert(
  typeof registry.boundary === 'string' && registry.boundary.length > 0,
  'registry must declare its local-only boundary',
);

const byId = new Map();
for (const item of registry.items) {
  assert(
    !byId.has(item.id),
    `${item.id} appears more than once in the EX registry`,
  );
  byId.set(item.id, item);
}
assert.deepEqual(
  [...byId.keys()].sort(),
  [...requiredIds].sort(),
  'EX registry must cover EX-01..EX-05 exactly once',
);

const rows = [];
for (const id of requiredIds) {
  const item = byId.get(id);
  assert(item.id === id, `${id} fingerprint mismatch`);
  assert(
    typeof item.requirement === 'string' && item.requirement.length > 10,
    `${id} requirement is missing`,
  );
  assert(
    typeof item.owner_role === 'string' && item.owner_role.length > 0,
    `${id} owner_role is missing`,
  );
  assert(
    allowedStatuses.has(item.status),
    `${id} has unsupported status ${item.status}`,
  );
  assert(
    item.authorization_status === 'NOT_AUTHORIZED' || item.live_tested === true,
    `${id} cannot claim authorization without a live test record`,
  );
  assert(
    item.live_tested === false,
    `${id} must not claim a live test in local-only preparation`,
  );
  assert(
    Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0,
    `${id} must list existing evidence references`,
  );
  for (const ref of item.evidence_refs) {
    assert(existsSync(ref), `${id} evidence_ref does not exist: ${ref}`);
  }
  assert(
    Array.isArray(item.missing_evidence) && item.missing_evidence.length > 0,
    `${id} must enumerate missing evidence explicitly`,
  );
  assert(
    typeof item.next_step === 'string' && item.next_step.length > 0,
    `${id} must define the next step`,
  );
  assert(
    typeof item.owned_since === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(item.owned_since),
    `${id} owned_since must be an ISO date`,
  );
  if (item.status === 'SATISFIED') {
    assert(
      item.missing_evidence.length === 0,
      `${id} cannot be SATISFIED while evidence is missing`,
    );
  }
  if (item.status === 'BLOCKED_EXTERNAL')
    assert(
      item.authorization_status === 'NOT_AUTHORIZED',
      `${id} blocked items stay NOT_AUTHORIZED`,
    );
  rows.push([
    id,
    item.status,
    item.owner_role,
    item.evidence_refs.length,
    item.missing_evidence.length,
    item.next_step,
  ]);
}

const statusCounts = {};
for (const row of rows) statusCounts[row[1]] = (statusCounts[row[1]] ?? 0) + 1;

console.log(
  `EX registry check: ${rows.length}/5 items valid (${registryPath})`,
);
for (const [id, status, owner, refs, missing, next] of rows) {
  console.log(
    `- ${id} [${status}] owner=${owner} refs=${refs} missing=${missing}`,
  );
  console.log(`  next: ${next}`);
}
console.log(
  `Status summary: ${Object.entries(statusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')}`,
);
console.log(
  'No live evidence is claimed; all external actions remain NOT_AUTHORIZED until a separate authorization message.',
);
