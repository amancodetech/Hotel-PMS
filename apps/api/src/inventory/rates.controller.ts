import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createRatePlan,
  readRateCalendar,
  readRatePlans,
  setRates,
  updateRatePlanById,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import { nightlyPriceDto, ratePlanDto } from './dto.js';

const uuid = z.string().uuid();
const code = z.string().trim().min(1).max(80);
const name = z.string().trim().min(1).max(160);
const currency = z.enum(['IDR', 'USD']);
const mealPlan = z.enum(['NONE', 'BREAKFAST']);
const version = z.number().int().min(1);
const occupancy = z.number().int().min(1).max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z
  .object({
    amount: z.string().regex(/^\d{1,18}(\.\d{1,6})?$/),
    currency,
  })
  .strict();

const ratePlanBody = z
  .object({
    code,
    name,
    product_id: uuid,
    currency,
    occupancy_basis: occupancy.optional(),
    meal_plan: mealPlan.optional(),
    inclusions: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    cancellation_policy: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    free_policy: z.boolean().optional(),
  })
  .strict();

const ratePlanPatch = z
  .object({
    version,
    name: name.optional(),
    occupancy_basis: occupancy.optional(),
    meal_plan: mealPlan.optional(),
    inclusions: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    cancellation_policy: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    free_policy: z.boolean().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED']).optional(),
  })
  .strict();

const rateBatch = z
  .object({
    cells: z
      .array(
        z
          .object({
            rate_plan_id: uuid,
            date: isoDate,
            occupancy,
            money,
            tax_policy_version: uuid.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

const calendarQuery = z.object({ from: isoDate, to: isoDate }).strict();

@Controller('api/v1/tenants')
export class RatesController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('rate.manage')
  @Get(':tenantId/properties/:propertyId/rate-plans')
  async listRatePlans(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const plans = await readRatePlans(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: plans.map(ratePlanDto) };
  }

  @RequirePermission('rate.manage')
  @Post(':tenantId/properties/:propertyId/rate-plans')
  async createRatePlan(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = ratePlanBody.parse(body);
    const plan = await createRatePlan(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        code: input.code,
        name: input.name,
        productId: uuid.parse(input.product_id),
        currency: input.currency,
        occupancyBasis: input.occupancy_basis,
        mealPlan: input.meal_plan,
        inclusions: input.inclusions,
        cancellationPolicy: input.cancellation_policy,
        freePolicy: input.free_policy,
      },
    );
    return { rate_plan: ratePlanDto(plan) };
  }

  @RequirePermission('rate.manage')
  @Patch(':tenantId/properties/:propertyId/rate-plans/:ratePlanId')
  async updateRatePlan(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body() body: unknown,
  ) {
    const patch = ratePlanPatch.parse(body);
    const plan = await updateRatePlanById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(ratePlanId),
      {
        version: patch.version,
        name: patch.name,
        occupancyBasis: patch.occupancy_basis,
        mealPlan: patch.meal_plan,
        inclusions: patch.inclusions,
        cancellationPolicy: patch.cancellation_policy,
        freePolicy: patch.free_policy,
        status: patch.status,
      },
    );
    return { rate_plan: ratePlanDto(plan) };
  }

  @RequirePermission('rate.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/rates/batch')
  async setRates(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = rateBatch.parse(body);
    const result = await setRates(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input.cells.map((cell) => ({
        ratePlanId: uuid.parse(cell.rate_plan_id),
        date: cell.date,
        occupancy: cell.occupancy,
        amount: cell.money.amount,
        currency: cell.money.currency,
      })),
    );
    return {
      updated: result.updated,
      inventory_version: result.inventoryVersion,
    };
  }

  @RequirePermission('rate.manage')
  @Get(':tenantId/properties/:propertyId/rates')
  async getRateCalendar(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const { from, to } = calendarQuery.parse(query);
    const calendar = await readRateCalendar(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      from,
      to,
    );
    return {
      inventory_version: calendar.inventoryVersion,
      plans: calendar.plans.map(ratePlanDto),
      prices: calendar.prices.map(nightlyPriceDto),
    };
  }
}
