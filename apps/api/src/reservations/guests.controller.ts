import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createGuest,
  getGuest,
  listGuests,
  PropertyError,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import { guestDto } from './dto.js';

const uuid = z.string().uuid();

const guestBody = z
  .object({
    full_name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).nullish(),
    phone: z.string().trim().min(1).max(40).nullish(),
    country_code: z.string().trim().length(2).nullish(),
    language: z.string().trim().min(2).max(16).nullish(),
    gender: z.enum(['FEMALE', 'MALE']).nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .strict();

const listQuery = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

@Controller('api/v1/tenants')
export class GuestsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('guest.read')
  @Get(':tenantId/guests')
  async listGuests(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Query() query: unknown,
  ) {
    const input = listQuery.parse(query);
    const result = await listGuests(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      {
        search: input.search ?? null,
        cursor: input.cursor ?? null,
        limit: input.limit,
      },
    );
    return {
      items: result.items.map(guestDto),
      next_cursor: result.next_cursor,
    };
  }

  @RequirePermission('guest.read')
  @Get(':tenantId/guests/:guestId')
  async getGuest(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('guestId') guestId: string,
  ) {
    const guest = await getGuest(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(guestId),
    );
    if (!guest) throw new PropertyError('NOT_FOUND');
    return { guest: guestDto(guest) };
  }

  @RequirePermission('guest.manage')
  @Post(':tenantId/guests')
  async createGuest(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = guestBody.parse(body);
    return createGuest(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      input,
      idempotencyKey ?? null,
    );
  }
}
