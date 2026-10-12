import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { authorize, type ServiceContext } from './context.js';
import { PropertyError } from '../domain/errors.js';
import { assertIsoDate } from '../domain/lifecycle.js';
import { lockProperty } from '../persistence/property-repository.js';
import { findProduct } from '../persistence/product-repository.js';
import { findLimitsProfile } from '../../inventory/persistence/rate-repository.js';
import {
  resolveAvailabilityForProduct,
  searchBudgetForProperty,
} from '../../inventory/application/availability-service.js';

/** Read-only inventory simulation. Does not create holds, quotes, expire records or open sales. */
export async function simulateSetupProduct(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    productId: string;
    from: string;
    to: string;
    adults: number;
    quantity: number;
  },
) {
  assertIsoDate(input.from, 'from');
  assertIsoDate(input.to, 'to');
  if (
    input.to <= input.from ||
    !Number.isInteger(input.adults) ||
    input.adults < 1 ||
    input.adults > 100 ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 20
  )
    throw new PropertyError('INVALID_REQUEST');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      if (!['SETUP', 'ACTIVE'].includes(property.status))
        throw new PropertyError('INVALID_STATE_TRANSITION');
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        input.productId,
      );
      if (!product) throw new PropertyError('NOT_FOUND');
      const limits = await findLimitsProfile(em, context.tenantId, propertyId);
      if (
        !limits ||
        (Date.parse(input.to) - Date.parse(input.from)) / 86400000 >
          Math.min(limits.horizon_nights, limits.max_stay_nights)
      )
        throw new PropertyError('LIMIT_EXCEEDED');
      const resolved = await resolveAvailabilityForProduct(em, {
        tenantId: context.tenantId,
        propertyId,
        product,
        period: { arrival: input.from, departure: input.to },
        occupancy: { adults: input.adults, childAges: [] },
        quantity: input.quantity,
        budget: await searchBudgetForProperty(em, context.tenantId, propertyId),
      });
      return {
        result: resolved.result,
        reason_codes: resolved.reasonCodes,
        units: resolved.units.map((unit) => ({
          resources: unit.resources.map((resource) => ({
            code: resource.code,
          })),
        })),
        inventory_version: Number(property.inventory_version),
        checked_at: new Date().toISOString(),
      };
    },
  );
}
