import { PropertyError } from '../domain/errors.js';

const uniqueViolation = '23505';
const foreignKeyViolation = '23503';
const checkViolation = '23514';
const exclusionViolation = '23P01';

export function databaseErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      typeof (current as { code?: unknown }).code === 'string'
    )
      return (current as { code: string }).code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export async function translatePropertyWrite<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === uniqueViolation) throw new PropertyError('CONFLICT');
    if (code === exclusionViolation) throw new PropertyError('CONFLICT');
    if (code === foreignKeyViolation)
      throw new PropertyError('CROSS_SCOPE_REFERENCE');
    if (code === checkViolation)
      throw new PropertyError('INVALID_REQUEST', {
        constraint:
          typeof (error as { constraint?: unknown }).constraint === 'string'
            ? (error as { constraint: string }).constraint
            : undefined,
      });
    throw error;
  }
}
