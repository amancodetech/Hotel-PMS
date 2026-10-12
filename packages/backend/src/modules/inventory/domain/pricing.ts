import { PropertyError } from '../../property/domain/errors.js';

const DECIMAL_SCALE = 6;
const FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const MONEY_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;
const NON_NEGATIVE_PATTERN = /^\d{1,18}(\.\d{1,6})?$/;

export const MAX_DECIMAL = FACTOR;

export function parseDecimal(
  value: string,
  field: string,
  options: { allowNegative?: boolean } = {},
): bigint {
  const pattern = options.allowNegative ? MONEY_PATTERN : NON_NEGATIVE_PATTERN;
  if (!pattern.test(value))
    throw new PropertyError('INVALID_REQUEST', { field });
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const [intRaw, fracRaw] = digits.split('.');
  const intPart = intRaw ?? '0';
  const fraction = ((fracRaw ?? '') + '0'.repeat(DECIMAL_SCALE)).slice(
    0,
    DECIMAL_SCALE,
  );
  const scaled = BigInt(intPart) * FACTOR + BigInt(fraction);
  return negative ? -scaled : scaled;
}

export function formatDecimal(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const intPart = absolute / FACTOR;
  const fraction = (absolute % FACTOR)
    .toString()
    .padStart(DECIMAL_SCALE, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${fraction ? `.${fraction}` : ''}`;
}

export function addDecimal(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

export function multiplyByQuantity(value: bigint, quantity: number): bigint {
  return value * BigInt(quantity);
}

export function roundHalfUp(scaled: bigint, digits: number): bigint {
  if (digits >= DECIMAL_SCALE) return scaled;
  const unit = 10n ** BigInt(DECIMAL_SCALE - digits);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const quotient = absolute / unit;
  const remainder = absolute % unit;
  const rounded = remainder * 2n >= unit ? quotient + 1n : quotient;
  return (negative ? -rounded : rounded) * unit;
}

export function hasFractionBeyond(scaled: bigint, digits: number): boolean {
  if (digits >= DECIMAL_SCALE) return false;
  const unit = 10n ** BigInt(DECIMAL_SCALE - digits);
  return scaled % unit !== 0n;
}

export function toMinorString(scaled: bigint): string {
  return formatDecimal(roundHalfUp(scaled, 2));
}

export function decimalToNumber(scaled: bigint): number {
  return Number(scaled) / Number(FACTOR);
}
