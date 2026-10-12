import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  assignRoom,
  checkInStay,
  checkOutStay,
  earlyDepartureStay,
  extendStay,
  getFrontDeskBoard,
  moveStay,
  partialDepartureStay,
  splitStay,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import {
  assignRoomBody,
  boardQuery,
  checkInBody,
  checkOutBody,
  earlyDepartureBody,
  extendBody,
  moveBody,
  partialDepartureBody,
  splitBody,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1/tenants')
export class FrontDeskController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('frontdesk.read')
  @Get(':tenantId/properties/:propertyId/front-desk/board')
  async getFrontDeskBoard(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = boardQuery.parse(query);
    return getFrontDeskBoard(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input.date ?? null,
    );
  }

  @RequirePermission('assignment.manage')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/assignments',
  )
  async assignRoom(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = assignRoomBody.parse(body);
    return assignRoom(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        resource_id: input.resource_id,
        start_date: input.start_date,
        end_date: input.end_date,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.checkin')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/check-in',
  )
  async checkInStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = checkInBody.parse(body);
    return checkInStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        resource_id: input.resource_id ?? null,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.move')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/move',
  )
  async moveStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = moveBody.parse(body);
    return moveStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        to_resource_id: input.to_resource_id,
        effective_date: input.effective_date,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.move')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/extend',
  )
  async extendStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = extendBody.parse(body);
    return extendStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        new_departure: input.new_departure,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.move')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/split',
  )
  async splitStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = splitBody.parse(body);
    return splitStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        at_date: input.at_date,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.move')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/early-departure',
  )
  async earlyDepartureStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = earlyDepartureBody.parse(body);
    return earlyDepartureStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        effective_date: input.effective_date,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.checkout')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/partial-departure',
  )
  async partialDepartureStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = partialDepartureBody.parse(body);
    return partialDepartureStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        guest_ids: input.guest_ids,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('stay.checkout')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/reservations/:reservationId/items/:itemId/check-out',
  )
  async checkOutStay(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('itemId') itemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = checkOutBody.parse(body);
    return checkOutStay(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(reservationId),
      uuid.parse(itemId),
      {
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }
}
