import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import openapiTS, { astToString } from 'openapi-typescript';

const v1Path = 'docs/contracts/v1.openapi.json';
const phase3Path = 'docs/contracts/phase3.openapi.json';
const phase4Path = 'docs/contracts/phase4.openapi.json';
const phase5Path = 'docs/contracts/phase5.openapi.json';
const phase6Path = 'docs/contracts/phase6.openapi.json';
const phase7Path = 'docs/contracts/phase7.openapi.json';
const phase8Path = 'docs/contracts/phase8.openapi.json';
const phase9Path = 'docs/contracts/phase9.openapi.json';
const phase10Path = 'docs/contracts/phase10.openapi.json';
const phase11Path = 'docs/contracts/phase11.openapi.json';
const phase12Path = 'docs/contracts/phase12.openapi.json';
const setPath = 'docs/contracts/set.openapi.json';
await SwaggerParser.validate(v1Path);
await SwaggerParser.validate('docs/contracts/foundation.openapi.json');
await SwaggerParser.validate(phase3Path);
await SwaggerParser.validate(phase4Path);
await SwaggerParser.validate(phase5Path);
await SwaggerParser.validate(phase6Path);
await SwaggerParser.validate(phase7Path);
await SwaggerParser.validate(phase8Path);
await SwaggerParser.validate(phase9Path);
await SwaggerParser.validate(phase10Path);
await SwaggerParser.validate(phase11Path);
await SwaggerParser.validate(phase12Path);
await SwaggerParser.validate(setPath);

function implementedOperations(jsonPath, label) {
  const document = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const operations = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      )
      .map(([method, value]) => ({ method, path, ...value })),
  );
  assert.equal(
    new Set(operations.map((operation) => operation.operationId)).size,
    operations.length,
    `${label} operationIds must be unique`,
  );
  for (const operation of operations) {
    assert(
      typeof operation['x-permission'] === 'string',
      `${operation.operationId} must declare x-permission`,
    );
    if (['post', 'put', 'patch', 'delete'].includes(operation.method))
      assert(
        operation['x-csrf'] === true,
        `${operation.operationId} must declare x-csrf`,
      );
  }
  return operations;
}

const document = JSON.parse(readFileSync(v1Path, 'utf8'));
const operations = Object.values(document.paths).flatMap((item) =>
  Object.entries(item)
    .filter(([method]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    )
    .map(([, value]) => value),
);
assert.equal(
  new Set(operations.map((operation) => operation.operationId)).size,
  operations.length,
);
assert(operations.every((operation) => operation['x-permission']));

const phase3 = JSON.parse(readFileSync(phase3Path, 'utf8'));
const phase3Operations = Object.entries(phase3.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    )
    .map(([method, value]) => ({ method, path, ...value })),
);
assert.equal(
  new Set(phase3Operations.map((operation) => operation.operationId)).size,
  phase3Operations.length,
  'Phase 3 operationIds must be unique',
);
for (const operation of phase3Operations) {
  const publicOperation = operation['x-public'] === true;
  assert(
    publicOperation ||
      typeof operation['x-permission'] === 'string' ||
      operation['x-access'] === 'session',
    `${operation.operationId} must declare x-public, x-access or x-permission`,
  );
  if (['post', 'put', 'patch', 'delete'].includes(operation.method))
    assert(
      operation['x-csrf'] === true || publicOperation,
      `${operation.operationId} must declare x-csrf`,
    );
}

const phase4 = JSON.parse(readFileSync(phase4Path, 'utf8'));
const phase4Operations = Object.entries(phase4.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    )
    .map(([method, value]) => ({ method, path, ...value })),
);
assert.equal(
  new Set(phase4Operations.map((operation) => operation.operationId)).size,
  phase4Operations.length,
  'Phase 4 operationIds must be unique',
);
for (const operation of phase4Operations) {
  assert(
    typeof operation['x-permission'] === 'string',
    `${operation.operationId} must declare x-permission`,
  );
  if (['post', 'put', 'patch', 'delete'].includes(operation.method))
    assert(
      operation['x-csrf'] === true,
      `${operation.operationId} must declare x-csrf`,
    );
}

const phase5Operations = implementedOperations(phase5Path, 'Phase 5');
const phase6Operations = implementedOperations(phase6Path, 'Phase 6');
const phase7Operations = implementedOperations(phase7Path, 'Phase 7');
assert.equal(
  phase7Operations.length,
  10,
  'Phase 7 contract must declare the 10 implemented operations (P07-01 + P07-02 + P07-03 + F7 exceptions list)',
);
const phase8Operations = implementedOperations(phase8Path, 'Phase 8');
assert.equal(
  phase8Operations.length,
  35,
  'Phase 8 contract must declare the P08-01..P08-06 implemented operations (business day, journals, folios, charges, routing, schedules, packages, deposits, payments, refunds, corrections, FX snapshots, invoices, cashier sessions and financial clearance/external settlements)',
);
const phase9Operations = implementedOperations(phase9Path, 'Phase 9');
assert.equal(
  phase9Operations.length,
  22,
  'Phase 9 contract must declare the P09-01..P09-03 implemented operations (tasks, DND, operations policy, work orders and the operations board/shift handover/internal notifications)',
);
const phase10Operations = implementedOperations(phase10Path, 'Phase 10');
assert.equal(
  phase10Operations.length,
  5,
  'Phase 10 contract must declare the P10-01..P10-03 implemented operations (night audit overview, run list, queue, retry and exception resolution)',
);
const phase11Operations = implementedOperations(phase11Path, 'Phase 11');
assert.equal(
  phase11Operations.length,
  9,
  'Phase 11 contract must declare the P11-01..P11-03 implemented operations (report queries, pickup snapshots and the short-lived export lifecycle)',
);
const phase12Operations = implementedOperations(phase12Path, 'Phase 12');
assert.equal(
  phase12Operations.length,
  25,
  'Phase 12 contract must declare the P12-01..P12-03 implemented operations (plans, dated policy versions, subscriptions, entitlements, usage, administrative billing, the customer lifecycle and the platform directory/audit/temporary-support access)',
);
const setOperations = implementedOperations(setPath, 'SET');
// v2 setup execution is implemented locally; activation/addition remain separately gated.
const setDocument = JSON.parse(readFileSync(setPath, 'utf8'));
assert.equal(setDocument['x-psr-v2'].runtime_accepts_v2, true);
for (const [name, schema] of Object.entries(setDocument.components.schemas)) {
  if (!name.endsWith('V2')) continue;
  assert.equal(schema['x-implementation-status'], 'IMPLEMENTED_LOCAL');
  if (schema.type === 'object')
    assert.equal(schema.additionalProperties, false);
}
const saveSetupOperation = setOperations.find(
  (op) => op.operationId === 'SaveSetupDraft',
);
assert.equal(
  saveSetupOperation.requestBody.content['application/json'].schema.$ref,
  '#/components/schemas/VersionedSetupDraftInput',
);
assert.deepEqual(setDocument.components.schemas.SetupDraftInputV2.required, [
  'schema_version',
  'property',
  'locations',
  'unit_groups',
  'operations',
]);
assert(
  !('completed' in setDocument.components.schemas.SetupDraftInputV2.properties),
);
assert.equal(
  setOperations.length,
  22,
  'SET design contract must declare the implemented setup operations (templates, draft read/save/discard, preview, apply, readiness, sale simulation, unit import, settings/change log, reconciliation, dated composition change isolated migration, independent additions and product simulation)',
);

async function generate(path, target) {
  const generated = astToString(
    await openapiTS(new URL(`../${path}`, import.meta.url)),
  );
  const existing = readFileSync(target, 'utf8');
  assert(
    existing.endsWith(generated),
    `Regenerate transport types with pnpm contracts:generate (${target})`,
  );
}
await generate(v1Path, 'packages/contracts/src/v1.generated.ts');
await generate(phase3Path, 'packages/contracts/src/phase3.generated.ts');
await generate(phase4Path, 'packages/contracts/src/phase4.generated.ts');
await generate(phase5Path, 'packages/contracts/src/phase5.generated.ts');
await generate(phase6Path, 'packages/contracts/src/phase6.generated.ts');
await generate(phase7Path, 'packages/contracts/src/phase7.generated.ts');
await generate(phase8Path, 'packages/contracts/src/phase8.generated.ts');
await generate(phase9Path, 'packages/contracts/src/phase9.generated.ts');
await generate(phase10Path, 'packages/contracts/src/phase10.generated.ts');
await generate(phase11Path, 'packages/contracts/src/phase11.generated.ts');
await generate(phase12Path, 'packages/contracts/src/phase12.generated.ts');
await generate(setPath, 'packages/contracts/src/set.generated.ts');
console.log(
  `OpenAPI validated; ${operations.length} planned V1 operations, ${phase3Operations.length} implemented Phase 3 operations, ${phase4Operations.length} implemented Phase 4 operations and ${phase5Operations.length} implemented Phase 5 operations and ${phase6Operations.length} implemented Phase 6 operations and ${phase7Operations.length} implemented Phase 7 operations and ${phase8Operations.length} implemented Phase 8 operations and ${phase9Operations.length} implemented Phase 9 operations and ${phase10Operations.length} implemented Phase 10 operations and ${phase11Operations.length} implemented Phase 11 operations and ${phase12Operations.length} implemented Phase 12 operations and ${setOperations.length} design SET setup operations; generated types match.`,
);
