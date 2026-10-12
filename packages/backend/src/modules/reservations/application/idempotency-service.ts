import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertSafeText } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  findIdempotencyKey,
  insertIdempotencyKey,
} from '../persistence/idempotency-repository.js';

export function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeIdempotencyKey(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function requireIdempotencyKey(
  value: string | null | undefined,
): string {
  const key = normalizeIdempotencyKey(value);
  if (!key)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'idempotency_key',
      reason: 'required',
    });
  const safe = assertSafeText(key, 'idempotency_key', 128);
  if (safe.length < 16)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'idempotency_key',
      reason: 'too_short',
    });
  return safe;
}

export async function checkIdempotency(
  em: EntityManager,
  context: ServiceContext,
  operation: string,
  key: string | null,
  requestHash: string,
  propertyId: string | null = null,
): Promise<Record<string, unknown> | null> {
  if (!key) return null;
  const existing = await findIdempotencyKey(em, {
    tenantId: context.tenantId,
    propertyId,
    operation,
    key,
  });
  if (!existing) return null;
  if (existing.request_hash !== requestHash)
    throw new PropertyError('CONFLICT', {
      reason: 'idempotency_key_reused',
      operation,
    });
  return { ...existing.response_safe, replayed: true };
}

export async function storeIdempotency(
  em: EntityManager,
  context: ServiceContext,
  input: {
    propertyId: string | null;
    operation: string;
    key: string | null;
    requestHash: string;
    response: Record<string, unknown>;
    resourceId: string | null;
  },
): Promise<void> {
  const key = input.key;
  if (!key) return;
  const stored = await translatePropertyWrite(() =>
    insertIdempotencyKey(em, {
      id: randomUUID(),
      tenantId: context.tenantId,
      propertyId: input.propertyId,
      operation: input.operation,
      key,
      requestHash: input.requestHash,
      responseSafe: input.response,
      resourceId: input.resourceId,
    }),
  );
  if (!stored.inserted && stored.row.request_hash !== input.requestHash)
    throw new PropertyError('CONFLICT', {
      reason: 'idempotency_key_reused',
      operation: input.operation,
    });
}
