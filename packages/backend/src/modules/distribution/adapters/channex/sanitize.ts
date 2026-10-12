import { createHash } from 'node:crypto';

export { toSafeRef, sanitizeWarningCodes } from '../../domain/safety.js';

const sensitiveTokens = new Set([
  'card',
  'cardnumber',
  'cardnumbers',
  'cvv',
  'cvc',
  'cvc2',
  'securitycode',
  'iban',
  'bankaccount',
  'accountnumber',
  'password',
  'secret',
  'token',
  'accesstoken',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'address',
  'firstname',
  'lastname',
  'fullname',
  'guestname',
  'passport',
  'passportnumber',
  'identitynumber',
  'nationalid',
  'pan',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (sensitiveTokens.has(normalized)) return true;
  return /^(card|cvv|cvc|passport|identity|iban|bank)/.test(normalized);
}

export function containsSensitiveKey(key: string): boolean {
  return isSensitiveKey(key);
}

const keptScalarKeys = new Set([
  'id',
  'booking_id',
  'revision_id',
  'status',
  'property_id',
  'ota_name',
  'ota_reservation_code',
  'amount',
  'currency',
  'commission',
  'taxes',
  'total',
  'meal_plan',
  'occupancy',
  'adults',
  'children',
  'room_type_id',
  'rate_plan_id',
  'checkin_date',
  'checkout_date',
  'arrival_date',
  'departure_date',
  'created_at',
  'updated_at',
  'inserted_at',
]);

const keptArrayKeys = new Set(['rooms', 'values', 'services', 'addons']);
const guestContainerKeys = new Set([
  'customer',
  'guest',
  'guests',
  'traveler',
  'traveller',
  'travellers',
]);

export interface SanitizeResult {
  safe: Record<string, unknown>;
  removedFields: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

export function sanitizeProviderPayload(input: unknown): SanitizeResult {
  const removedFields: string[] = [];

  function walk(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((item) => walk(item, path));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (guestContainerKeys.has(normalizedKey)) {
        removedFields.push(`${childPath}.identity_fields`);
        const container = Array.isArray(item) ? item : [item];
        output[key] = container
          .map((entry) => asRecord(entry))
          .filter((entry) => entry !== null)
          .map((entry) => ({
            ref:
              entry.id === undefined
                ? null
                : createHash('sha256')
                    .update(JSON.stringify(entry.id))
                    .digest('hex')
                    .slice(0, 24),
            adults: asCount(entry.adults),
            children: asCount(entry.children),
          }));
        continue;
      }
      if (isSensitiveKey(key)) {
        if (key.toLowerCase().includes('id')) {
          output[`${key}_ref`] = createHash('sha256')
            .update(JSON.stringify(item ?? null))
            .digest('hex')
            .slice(0, 24);
        }
        removedFields.push(childPath);
        continue;
      }
      const isRoot = path === '';
      if (
        isRoot &&
        !keptScalarKeys.has(key) &&
        !keptArrayKeys.has(key) &&
        key !== 'attributes' &&
        key !== 'meta' &&
        key !== 'data'
      ) {
        removedFields.push(childPath);
        continue;
      }
      output[key] = walk(item, childPath);
    }
    return output;
  }

  const safe = (walk(input, '') ?? {}) as Record<string, unknown>;
  return { safe, removedFields };
}

export function containsSensitiveLeak(value: unknown): boolean {
  const text = JSON.stringify(value ?? null);
  return /(card_number|cvv|security_code|passport|bank_account)/i.test(text);
}
