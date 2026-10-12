import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { findPropertyScope } from '../../reservations/persistence/reservation-repository.js';
import * as repo from '../persistence/finance-repository.js';
import type { BusinessDayRow } from '../persistence/finance-repository.js';

export function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export async function getBusinessDay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  date?: string | null,
): Promise<Record<string, unknown>> {
  if (date) assertIsoDate(date, 'date');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'folio.read', propertyId);
      const property = await findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const current = date ?? businessToday(property.timezone);
      const day = date
        ? await repo.findBusinessDay(em, context.tenantId, propertyId, current)
        : await repo.findActiveBusinessDay(em, context.tenantId, propertyId);
      return {
        date: current,
        timezone: property.timezone,
        business_day: day ? repo.businessDayView(day) : null,
      };
    },
  );
}

/**
 * Returns the single active (non-CLOSED) business day of a property. When no
 * day exists yet the property-local current day is opened idempotently; a day
 * other than the property-local current one can never be opened lazily.
 * Callers inside a transaction keep the active row locked for update, which is
 * what serialises posting against the CLOSING barrier.
 */
export async function ensureOpenBusinessDay(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    date: string;
    timezone: string;
  },
): Promise<BusinessDayRow> {
  const active = await repo.findActiveBusinessDay(
    em,
    input.tenantId,
    input.propertyId,
    { forUpdate: true },
  );
  if (active) return active;
  if (input.date !== businessToday(input.timezone))
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: input.date,
      reason: 'not_property_local_today',
    });
  await translatePropertyWrite(() =>
    repo.insertBusinessDay(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      date: input.date,
    }),
  );
  const created = await repo.findActiveBusinessDay(
    em,
    input.tenantId,
    input.propertyId,
    { forUpdate: true },
  );
  if (!created)
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: input.date,
    });
  return created;
}

export async function requireOpenBusinessDay(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    date: string;
    timezone: string;
  },
): Promise<BusinessDayRow> {
  const day = await ensureOpenBusinessDay(em, input);
  if (day.business_date !== input.date) {
    const closed = await repo.findBusinessDay(
      em,
      input.tenantId,
      input.propertyId,
      input.date,
    );
    if (closed)
      throw new PropertyError('BUSINESS_DAY_CLOSED', {
        business_date: input.date,
      });
    throw new PropertyError('BUSINESS_DAY_NOT_OPEN', {
      business_date: input.date,
      active_business_date: day.business_date,
    });
  }
  if (day.state === 'CLOSING')
    throw new PropertyError('BUSINESS_DAY_BUSY', {
      business_date: input.date,
      state: day.state,
    });
  if (day.state === 'CLOSED')
    throw new PropertyError('BUSINESS_DAY_CLOSED', {
      business_date: input.date,
    });
  return day;
}
