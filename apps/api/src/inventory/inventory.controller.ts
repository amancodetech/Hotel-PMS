import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createBlock,
  createHold,
  quoteStay,
  readBlocks,
  readHolds,
  releaseBlock,
  releaseHold,
  searchAvailability,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import { blockDto, disruptionDto, holdDto, priceQuoteDto } from './dto.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const occupancy = z
  .object({
    adults: z.number().int().min(0).max(100),
    child_ages: z.array(z.number().int().min(0).max(17)).max(100),
  })
  .strict();
const period = z.object({ arrival: isoDate, departure: isoDate }).strict();

const searchBody = z
  .object({
    product_ids: z.array(uuid).min(1).max(100),
    period,
    occupancy,
    quantity: z.number().int().min(1).max(20),
  })
  .strict();

const quoteBody = z
  .object({
    product_id: uuid,
    rate_plan_id: uuid.optional(),
    period,
    occupancy,
    quantity: z.number().int().min(1).max(20),
  })
  .strict();

const item = z
  .object({
    product_id: uuid,
    period,
    occupancy,
    quantity: z.number().int().min(1).max(20),
    price_snapshot_id: uuid.nullable().optional(),
  })
  .strict();

const holdBody = z
  .object({
    items: z.array(item).min(1).max(20),
    inventory_version: z.number().int().min(1),
    ttl_seconds: z.number().int().min(30).max(900),
  })
  .strict();

const blockBody = z
  .object({
    resource_ids: z.array(uuid).min(1).max(100),
    period,
    reason: z.string().trim().min(1).max(1000),
    mode: z.enum(['PLANNED', 'EMERGENCY']),
  })
  .strict();

const reasonBody = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

@Controller('api/v1/tenants')
export class AvailabilityController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('reservation.read')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/availability/search')
  async search(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = searchBody.parse(body);
    const result = await searchAvailability(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        productIds: input.product_ids,
        period: input.period,
        occupancy: {
          adults: input.occupancy.adults,
          childAges: input.occupancy.child_ages,
        },
        quantity: input.quantity,
      },
    );
    return {
      inventory_version: result.inventoryVersion,
      offers: result.offers.map((offer) => ({
        product_id: offer.productId,
        result: offer.result,
        reason_codes: offer.reasonCodes,
      })),
      guaranteed: false,
    };
  }

  @RequirePermission('reservation.read')
  @HttpCode(201)
  @Post(':tenantId/properties/:propertyId/quotes')
  async quote(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = quoteBody.parse(body);
    const quote = await quoteStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        productId: input.product_id,
        ratePlanId: input.rate_plan_id,
        period: input.period,
        occupancy: {
          adults: input.occupancy.adults,
          childAges: input.occupancy.child_ages,
        },
        quantity: input.quantity,
      },
    );
    return { quote: priceQuoteDto(quote) };
  }
}

@Controller('api/v1/tenants')
export class HoldsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('reservation.create')
  @Post(':tenantId/properties/:propertyId/holds')
  async create(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = holdBody.parse(body);
    const result = await createHold(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        items: input.items.map((entry) => ({
          productId: entry.product_id,
          period: entry.period,
          occupancy: {
            adults: entry.occupancy.adults,
            childAges: entry.occupancy.child_ages,
          },
          quantity: entry.quantity,
          priceSnapshotId: entry.price_snapshot_id ?? null,
        })),
        inventoryVersion: input.inventory_version,
        ttlSeconds: input.ttl_seconds,
      },
    );
    return { hold: holdDto(result.commitment, result.allocations) };
  }

  @RequirePermission('reservation.read')
  @Get(':tenantId/properties/:propertyId/holds')
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const holds = await readHolds(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return {
      items: holds.map((hold) => holdDto(hold, hold.allocations)),
    };
  }

  @RequirePermission('reservation.create')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/holds/:holdId/release')
  async release(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('holdId') holdId: string,
  ) {
    const commitment = await releaseHold(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(holdId),
    );
    return { hold: holdDto(commitment, []) };
  }
}

@Controller('api/v1/tenants')
export class BlocksController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('inventory.block')
  @Post(':tenantId/properties/:propertyId/blocks')
  async create(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = blockBody.parse(body);
    const result = await createBlock(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        resourceIds: input.resource_ids,
        period: input.period,
        reason: input.reason,
        mode: input.mode,
      },
    );
    return {
      block: blockDto(result.block, input.resource_ids),
      disruptions: result.disruptions.map(disruptionDto),
    };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/blocks')
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const result = await readBlocks(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return {
      items: result.blocks.map((block) => blockDto(block, block.resource_ids)),
      disruptions: result.disruptions.map(disruptionDto),
    };
  }

  @RequirePermission('inventory.block')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/blocks/:blockId/release')
  async release(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('blockId') blockId: string,
    @Body() body: unknown,
  ) {
    const { reason } = reasonBody.parse(body);
    const block = await releaseBlock(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(blockId),
      reason,
    );
    return { block: blockDto(block, []) };
  }
}
