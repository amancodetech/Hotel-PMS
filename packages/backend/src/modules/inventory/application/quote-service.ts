import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import {
  addDecimal,
  formatDecimal,
  multiplyByQuantity,
  parseDecimal,
} from '../domain/pricing.js';
import { expireDueHolds } from '../persistence/guarantee-repository.js';
import {
  findLimitsProfile,
  findPolicyByNumber,
  insertPriceQuote,
  listNightlyPrices,
  listRatePlans,
} from '../persistence/rate-repository.js';
import {
  resolveAvailabilityForProduct,
  type OccupancyInput,
  type PeriodInput,
} from './availability-service.js';

export interface QuoteInput {
  productId: string;
  ratePlanId?: string;
  period: PeriodInput;
  occupancy: OccupancyInput;
  quantity: number;
}

function nights(period: PeriodInput): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${period.arrival}T00:00:00Z`);
  const end = new Date(`${period.departure}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function quoteStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: QuoteInput,
) {
  assertIsoDate(input.period.arrival, 'period.arrival');
  assertIsoDate(input.period.departure, 'period.departure');
  if (input.period.departure <= input.period.arrival)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.read', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      if (expired > 0)
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const inventoryVersion =
        property.inventory_version + (expired > 0 ? 1 : 0);
      const limits = await findLimitsProfile(em, context.tenantId, propertyId);
      const budget = {
        deadline: Date.now() + (limits?.search_budget_ms ?? 500),
      };
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        input.productId,
      );
      if (!product) throw new PropertyError('NOT_FOUND');
      const resolved = await resolveAvailabilityForProduct(em, {
        tenantId: context.tenantId,
        propertyId,
        product,
        period: input.period,
        occupancy: input.occupancy,
        quantity: input.quantity,
        budget,
      });
      if (resolved.result === 'UNDETERMINED')
        throw new PropertyError('LIMIT_EXCEEDED', {
          field: 'search_budget',
        });
      if (resolved.result !== 'AVAILABLE')
        throw new PropertyError('RESOURCE_UNAVAILABLE', {
          reason_codes: resolved.reasonCodes,
        });
      const plans = await listRatePlans(em, context.tenantId, propertyId);
      const candidates = plans.filter(
        (plan) =>
          plan.product_id === product.id &&
          plan.status === 'ACTIVE' &&
          (input.ratePlanId === undefined || plan.id === input.ratePlanId),
      );
      if (input.ratePlanId !== undefined && candidates.length === 0)
        throw new PropertyError('CROSS_SCOPE_REFERENCE');
      const plan = candidates[0];
      if (!plan)
        throw new PropertyError('RATE_INCOMPLETE', { product_id: product.id });
      const policy = await findPolicyByNumber(
        em,
        context.tenantId,
        propertyId,
        plan.id,
        plan.policy_version,
      );
      if (!policy) throw new Error('Rate plan policy snapshot missing');
      const dates = nights(input.period);
      const prices = await listNightlyPrices(
        em,
        context.tenantId,
        propertyId,
        input.period.arrival,
        dates[dates.length - 1] ?? input.period.arrival,
      );
      const priceByDate = new Map<string, string>();
      for (const price of prices) {
        if (
          price.rate_plan_id === plan.id &&
          price.occupancy === input.occupancy.adults
        )
          priceByDate.set(price.stay_date, price.amount);
      }
      const cells: Array<{
        date: string;
        occupancy: number;
        amount: string;
        quantity: number;
        line_total: string;
      }> = [];
      const lineTotals: bigint[] = [];
      for (const date of dates) {
        const amount = priceByDate.get(date);
        if (!amount)
          throw new PropertyError('RATE_MISSING', {
            date,
            occupancy: input.occupancy.adults,
            rate_plan_id: plan.id,
          });
        const scaled = parseDecimal(amount, 'amount');
        const lineTotal = multiplyByQuantity(scaled, input.quantity);
        lineTotals.push(lineTotal);
        cells.push({
          date,
          occupancy: input.occupancy.adults,
          amount,
          quantity: input.quantity,
          line_total: formatDecimal(lineTotal),
        });
      }
      const total = addDecimal(lineTotals);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const quote = await insertPriceQuote(em, {
        tenantId: context.tenantId,
        propertyId,
        ratePlanId: plan.id,
        policyVersionId: policy.id,
        productId: product.id,
        currency: plan.currency,
        startDate: input.period.arrival,
        endDate: input.period.departure,
        quantity: input.quantity,
        adults: input.occupancy.adults,
        childAges: input.occupancy.childAges,
        totalAmount: formatDecimal(total),
        cells,
        inventoryVersion,
        expiresAt,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'quote.created',
        resourceType: 'PriceQuote',
        resourceId: quote.id,
        outcome: 'SUCCESS',
        afterSafe: {
          product_id: product.id,
          rate_plan_id: plan.id,
          total_amount: quote.total_amount,
          currency: quote.currency,
          inventory_version: quote.inventory_version,
        },
        correlationId: context.correlationId,
      });
      return quote;
    },
  );
}
