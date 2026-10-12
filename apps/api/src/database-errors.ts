export interface DatabaseFailure {
  status: 409 | 503;
  code: 'CONFLICT' | 'DEPENDENCY_UNAVAILABLE';
  reason: 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'CONNECTION_LOST';
}

const connectionLostSqlStates = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

const connectionLostDriverCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Maps PostgreSQL SQLSTATEs and connection-driver codes to the public error
 * contract: lock contention stays a 409, while statement and connection
 * failures surface as a retryable dependency outage instead of a raw 500.
 */
export function classifyDatabaseError(
  errorCode: string | null | undefined,
): DatabaseFailure | null {
  if (errorCode === '55P03')
    return { status: 409, code: 'CONFLICT', reason: 'LOCK_TIMEOUT' };
  if (errorCode === '57014')
    return {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'STATEMENT_TIMEOUT',
    };
  if (
    errorCode &&
    (connectionLostSqlStates.has(errorCode) ||
      connectionLostDriverCodes.has(errorCode))
  )
    return {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'CONNECTION_LOST',
    };
  return null;
}
