import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { phase3Operations } from '../../apps/api/dist/identity/operations.js';

const contract = JSON.parse(
  readFileSync('docs/contracts/phase3.openapi.json', 'utf8'),
);

function contractOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const entry = {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: `/api/v1${path}`,
        access: operation['x-public']
          ? 'public'
          : operation['x-permission']
            ? 'permission'
            : 'session',
      };
      if (operation['x-permission'])
        entry.permission = operation['x-permission'];
      if (operation['x-csrf']) entry.csrf = true;
      operations.push(entry);
    }
  }
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

test('implemented route manifest matches the Phase 3 contract', () => {
  const fromContract = contractOperations();
  const fromCode = [...phase3Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(fromCode).toEqual(fromContract);
});

test('mutating contract operations require CSRF unless public', () => {
  for (const operation of contractOperations()) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)) {
      if (!operation.csrf && operation.access !== 'public')
        throw new Error(`${operation.operationId} must declare x-csrf`);
    }
  }
});

test('every implemented operation is session-scoped or explicitly public', () => {
  for (const operation of phase3Operations.sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  )) {
    expect(['public', 'session', 'permission']).toContain(operation.access);
    if (operation.access === 'permission')
      expect(typeof operation.permission).toBe('string');
  }
});
