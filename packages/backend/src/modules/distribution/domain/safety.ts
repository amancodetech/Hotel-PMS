import { createHash } from 'node:crypto';

export const maxSafeWarningCodes = 20;

export const safeWarningCatalog: ReadonlySet<string> = new Set([
  'CELL_DELAYED',
  'PARTIAL_CELL_PROCESSING',
  'CHANNEL_EVIDENCE_UNAVAILABLE',
  'READBACK_UNAVAILABLE',
  'PROVIDER_WARNING',
]);

export const unrecognizedWarningCode = 'UNRECOGNIZED_PROVIDER_WARNING';

const refTokenPattern = /^ref-[0-9a-f]{16}$/;

export function sanitizeWarningCodes(
  value: unknown,
  limit = maxSafeWarningCodes,
): string[] {
  const list = Array.isArray(value) ? value : [];
  const codes: string[] = [];
  for (const item of list) {
    const code =
      typeof item === 'string' && safeWarningCatalog.has(item)
        ? item
        : unrecognizedWarningCode;
    if (!codes.includes(code)) codes.push(code);
    if (codes.length >= limit) break;
  }
  return codes;
}

export function toSafeRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    return null;
  if (refTokenPattern.test(value)) return value;
  return `ref-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
