import { expect, test } from '@jest/globals';
import { classifyDatabaseError } from '../apps/api/src/database-errors.js';

test('database failures keep the public error contract', () => {
  expect(classifyDatabaseError('55P03')).toEqual({
    status: 409,
    code: 'CONFLICT',
    reason: 'LOCK_TIMEOUT',
  });
  expect(classifyDatabaseError('57014')).toEqual({
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    reason: 'STATEMENT_TIMEOUT',
  });
  for (const code of [
    '08000',
    '08001',
    '08003',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03',
    '53300',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])
    expect(classifyDatabaseError(code)).toEqual({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'CONNECTION_LOST',
    });
  expect(classifyDatabaseError('23505')).toBeNull();
  expect(classifyDatabaseError('42P01')).toBeNull();
  expect(classifyDatabaseError(null)).toBeNull();
  expect(classifyDatabaseError(undefined)).toBeNull();
});
