import { IdentityError } from '../../identity/domain/errors.js';
import {
  formatDecimal,
  parseDecimal,
  roundHalfUp,
} from '../../inventory/domain/pricing.js';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const METRIC_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^\d{1,16}(\.\d{1,6})?$/;

export function assertPlanCode(value: unknown, field = 'code'): string {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value))
    throw new IdentityError('INVALID_REQUEST', { field });
  return value;
}

export function assertMetric(value: unknown, field = 'metric'): string {
  if (typeof value !== 'string' || !METRIC_PATTERN.test(value))
    throw new IdentityError('INVALID_REQUEST', { field });
  return value;
}

export function assertLabel(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string')
    throw new IdentityError('INVALID_REQUEST', { field });
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > max)
    throw new IdentityError('INVALID_REQUEST', { field });
  return trimmed;
}

export function assertReason(value: unknown, field = 'reason'): string {
  if (typeof value !== 'string')
    throw new IdentityError('INVALID_REQUEST', { field });
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 500)
    throw new IdentityError('INVALID_REQUEST', { field });
  return trimmed;
}

export function assertIdempotencyKey(
  value: unknown,
  field = 'idempotency_key',
): string {
  if (typeof value !== 'string')
    throw new IdentityError('INVALID_REQUEST', { field });
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 200)
    throw new IdentityError('INVALID_REQUEST', { field });
  return trimmed;
}

export function assertPlatformIsoDate(value: unknown, field = 'date'): string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value))
    throw new IdentityError('INVALID_REQUEST', { field });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new IdentityError('INVALID_REQUEST', { field });
  return value;
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function assertInteger(
  value: unknown,
  field: string,
  min = 0,
  max = 1_000_000,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new IdentityError('INVALID_REQUEST', { field });
  return value;
}

/**
 * Parses a non-negative decimal string with at most six places into a scaled
 * bigint (six-place representation, the shared domain primitive).
 */
export function parseNonNegativeDecimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value))
    throw new IdentityError('INVALID_REQUEST', { field });
  return parseDecimal(value, field);
}

export function multiplyDecimal(a: bigint, b: bigint): bigint {
  const product = a * b;
  const scale = 10n ** 6n;
  const remainder = product % scale;
  const quotient = product / scale;
  if (remainder === 0n) return quotient;
  const doubled = remainder * 2n;
  if (doubled >= scale) return quotient + 1n;
  if (doubled <= -scale) return quotient - 1n;
  return quotient;
}

export function formatDecimalMoney(scaled: bigint): string {
  return formatDecimal(roundHalfUp(scaled, 6));
}

export function formatPostingMoney(scaled: bigint): string {
  return formatDecimal(roundHalfUp(scaled, 2));
}

export function normalizePosting(value: string): string {
  return formatDecimal(roundHalfUp(parseDecimal(value, 'amount'), 2));
}

export function toBigInt(value: bigint | number | string | null): bigint {
  if (value === null) return 0n;
  return BigInt(value);
}

export function toNumber(value: bigint | number | string | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}
