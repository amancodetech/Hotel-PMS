import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertSafeText } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import * as repo from '../persistence/guest-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from './idempotency-service.js';

export interface GuestInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  country_code?: string | null;
  language?: string | null;
  gender?: 'FEMALE' | 'MALE' | null;
  notes?: string | null;
}

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeGuest(input: GuestInput) {
  const fullName = assertSafeText(input.full_name, 'full_name', 200);
  const email =
    input.email === undefined || input.email === null
      ? null
      : assertSafeText(input.email, 'email', 320);
  if (email && !emailPattern.test(email))
    throw new PropertyError('INVALID_REQUEST', { field: 'email' });
  const phone =
    input.phone === undefined || input.phone === null
      ? null
      : assertSafeText(input.phone, 'phone', 40);
  const countryCode =
    input.country_code === undefined || input.country_code === null
      ? null
      : assertSafeText(input.country_code, 'country_code', 2);
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode))
    throw new PropertyError('INVALID_REQUEST', { field: 'country_code' });
  const language =
    input.language === undefined || input.language === null
      ? null
      : assertSafeText(input.language, 'language', 16);
  const gender = input.gender ?? null;
  if (gender !== null && gender !== 'FEMALE' && gender !== 'MALE')
    throw new PropertyError('INVALID_REQUEST', { field: 'gender' });
  const notes =
    input.notes === undefined || input.notes === null
      ? null
      : assertSafeText(input.notes, 'notes', 2000);
  return { fullName, email, phone, countryCode, language, gender, notes };
}

export async function createGuest(
  orm: MikroORM,
  context: ServiceContext,
  input: GuestInput,
  idempotencyKey?: string | null,
): Promise<Record<string, unknown>> {
  const normalized = normalizeGuest(input);
  const key = requireIdempotencyKey(idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CreateGuest',
    ...normalized,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'guest.manage', null);
      const replayed = await checkIdempotency(
        em,
        context,
        'CreateGuest',
        key,
        requestHash,
      );
      if (replayed) return replayed;
      const guest = await translatePropertyWrite(() =>
        repo.insertGuest(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          ...normalized,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId: null,
        ...auditActor(context),
        action: 'guest.created',
        resourceType: 'Guest',
        resourceId: guest.id,
        outcome: 'SUCCESS',
        afterSafe: { full_name: guest.full_name },
        correlationId: context.correlationId,
      });
      const response = {
        guest: {
          id: guest.id,
          full_name: guest.full_name,
          email: guest.email,
          phone: guest.phone,
          version: guest.version,
          country_code: guest.country_code,
          language: guest.language,
          gender: guest.gender,
          notes: guest.notes,
        },
      };
      await storeIdempotency(em, context, {
        propertyId: null,
        operation: 'CreateGuest',
        key,
        requestHash,
        response,
        resourceId: guest.id,
      });
      return response;
    },
  );
}

export async function listGuests(
  orm: MikroORM,
  context: ServiceContext,
  query: { search: string | null; cursor: string | null; limit: number },
): Promise<{ items: repo.GuestSummaryRow[]; next_cursor: string | null }> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'guest.read', null);
      const items = await repo.listGuestRows(em, context.tenantId, query);
      return {
        items,
        next_cursor:
          items.length === query.limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
  );
}

export async function getGuest(
  orm: MikroORM,
  context: ServiceContext,
  guestId: string,
): Promise<repo.GuestRow | null> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'guest.read', null);
      return repo.findGuest(em, context.tenantId, guestId);
    },
  );
}
