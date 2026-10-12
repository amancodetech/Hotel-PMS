import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { phase5Operations } from '../../apps/api/dist/inventory/operations.js';

const contract = JSON.parse(
  readFileSync('docs/contracts/phase5.openapi.json', 'utf8'),
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
        access: 'permission',
        permission: operation['x-permission'],
      };
      if (operation['x-csrf']) entry.csrf = true;
      operations.push(entry);
    }
  }
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

test('implemented route manifest matches the Phase 5 contract', () => {
  const fromContract = contractOperations();
  const fromCode = [...phase5Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(fromCode).toEqual(fromContract);
});

test('mutating Phase 5 operations require CSRF and a permission', () => {
  for (const operation of contractOperations()) {
    expect(typeof operation.permission).toBe('string');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method))
      expect(operation.csrf).toBe(true);
  }
});
