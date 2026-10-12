import {
  Body,
  Controller,
  Get,
  Headers,
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
  cancelItem,
  confirmReservation,
  createGroupAllotment,
  createReservationDraft,
  getReservation,
  importReservationsIdempotent,
  listChannelExceptions,
  listReservations,
  markItemNoShow,
  modifyReservation,
  pickupGroupAllotment,
  PropertyError,
  reprocessChannelRevision,
  splitReservationItem,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import { reservationDetailDto, reservationSummaryDto } from './dto.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const occupancy = z
  .object({
    adults: z.number().int().min(1).max(20),
    child_ages: z.array(z.number().int().min(0).max(17)).max(20),
  })
  .strict();

const draftItem = z
  .object({
    product_id: uuid.nullish(),
    period: z.object({ arrival: isoDate, departure: isoDate }).strict(),
    occupancy,
    quantity: z.number().int().min(1).max(20).optional(),
    owner_stay: z.boolean().optional(),
  })
  .strict();

const draftGuest = z
  .object({
    guest_id: uuid,
    role: z.enum(['LEAD', 'ACCOMPANYING']).optional(),
  })
  .strict();

const draftBody = z
  .object({
    source: z.enum(['DIRECT', 'OTA', 'IMPORT']).optional(),
    channel_connection_id: uuid.nullish(),
    external_booking_key: z.string().trim().min(1).max(200).nullish(),
    items: z.array(draftItem).min(1).max(20),
    guests: z.array(draftGuest).max(20).optional(),
  })
  .strict();

const listQuery = z
  .object({
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const confirmBody = z
  .object({
    reservation_id: uuid,
    inventory_version: z.number().int().min(1),
    items: z
      .array(z.object({ item_id: uuid, price_snapshot_id: uuid }).strict())
      .min(1)
      .max(20),
  })
  .strict();

const modifyItem = z
  .object({
    item_id: uuid,
    period: z
      .object({ arrival: isoDate, departure: isoDate })
      .strict()
      .optional(),
    occupancy: occupancy.optional(),
    quantity: z.number().int().min(1).max(20).optional(),
    price_snapshot_id: uuid.optional(),
  })
  .strict();

const modifyBody = z
  .object({
    version: z.number().int().min(1),
    items: z.array(modifyItem).min(1).max(20),
  })
  .strict();

const cancelBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const groupBody = z
  .object({
    product_id: uuid,
    period: z.object({ arrival: isoDate, departure: isoDate }).strict(),
    quantity: z.number().int().min(1).max(20),
    inventory_version: z.number().int().min(1),
  })
  .strict();

const pickupBody = z
  .object({ item_id: uuid, price_snapshot_id: uuid })
  .strict();

const splitBody = z
  .object({
    version: z.number().int().min(1),
    split_date: isoDate,
    first_price_snapshot_id: uuid,
    second_price_snapshot_id: uuid,
  })
  .strict();

const importBody = z
  .object({
    mode: z.enum(['DRY_RUN', 'APPLY']),
    source: z.enum(['UPLOAD', 'FEED']),
    file_name: z.string().trim().min(1).max(200),
    content_type: z.string().trim().min(3).max(64),
    content: z.string().min(1),
    external_id: z.string().trim().min(1).max(120).nullish(),
  })
  .strict();

const noShowBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

@Controller('api/v1/tenants')
export class ReservationsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('reservation.read')
  @Get(':tenantId/properties/:propertyId/reservations')
  async listReservations(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listQuery.parse(query);
    const result = await listReservations(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { cursor: input.cursor ?? null, limit: input.limit },
    );
    return {
      items: result.items.map(reservationSummaryDto),
      next_cursor: result.next_cursor,
    };
  }

  @RequirePermission('reservation.read')
  @Get(':tenantId/properties/:propertyId/reservations/:reservationId')
  async getReservation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
  ) {
    const result = await getReservation(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
    );
    if (!result) throw new PropertyError('NOT_FOUND');
    return reservationDetailDto(result);
  }

  @RequirePermission('reservation.create')
  @Post(':tenantId/properties/:propertyId/reservations/drafts')
  async createDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = draftBody.parse(body);
    return createReservationDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        source: input.source,
        channel_connection_id: input.channel_connection_id ?? null,
        external_booking_key: input.external_booking_key ?? null,
        items: input.items.map((item) => ({
          product_id: item.product_id ?? null,
          period: item.period,
          occupancy: item.occupancy,
          quantity: item.quantity,
          owner_stay: item.owner_stay,
        })),
        guests: input.guests,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('reservation.create')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reservations')
  async confirmReservation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = confirmBody.parse(body);
    return confirmReservation(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        reservationId: input.reservation_id,
        inventoryVersion: input.inventory_version,
        items: input.items,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('reservation.modify')
  @Patch(':tenantId/properties/:propertyId/reservations/:reservationId')
  async modifyReservation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = modifyBody.parse(body);
    return modifyReservation(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      {
        version: input.version,
        items: input.items,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('reservation.create')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/imports')
  async importReservations(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = importBody.parse(body);
    return importReservationsIdempotent(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        mode: input.mode,
        source: input.source,
        file_name: input.file_name,
        content_type: input.content_type,
        content: input.content,
        external_id: input.external_id ?? null,
      },
      idempotencyKey ?? null,
    );
  }

  @RequirePermission('channel.reprocess')
  @Get(':tenantId/properties/:propertyId/inbox/exceptions')
  async listChannelExceptions(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return listChannelExceptions(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('channel.reprocess')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/inbox/:revisionId/reprocess')
  async reprocessChannelRevision(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('revisionId') revisionId: string,
  ) {
    return reprocessChannelRevision(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(revisionId),
    );
  }

  @RequirePermission('reservation.modify')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/group-allotment',
  )
  async createGroupAllotment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Body() body: unknown,
  ) {
    const input = groupBody.parse(body);
    return createGroupAllotment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      {
        product_id: input.product_id,
        period: input.period,
        quantity: input.quantity,
        inventory_version: input.inventory_version,
      },
    );
  }

  @RequirePermission('reservation.modify')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/group-allotment/pickup',
  )
  async pickupGroupAllotment(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Body() body: unknown,
  ) {
    const input = pickupBody.parse(body);
    return pickupGroupAllotment(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      {
        item_id: input.item_id,
        price_snapshot_id: input.price_snapshot_id,
      },
    );
  }

  @RequirePermission('reservation.modify')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reservation-items/:itemId/split')
  async splitReservationItem(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    const input = splitBody.parse(body);
    return splitReservationItem(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(itemId),
      {
        version: input.version,
        split_date: input.split_date,
        first_price_snapshot_id: input.first_price_snapshot_id,
        second_price_snapshot_id: input.second_price_snapshot_id,
      },
    );
  }

  @RequirePermission('reservation.cancel')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reservation-items/:itemId/no-show')
  async markItemNoShow(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    const input = noShowBody.parse(body);
    return markItemNoShow(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(itemId),
      { version: input.version, reason: input.reason },
    );
  }

  @RequirePermission('reservation.cancel')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reservation-items/:itemId/cancel')
  async cancelItem(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = cancelBody.parse(body);
    return cancelItem(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(itemId),
      {
        version: input.version,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }
}
