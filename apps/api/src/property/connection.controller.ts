import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createConnectionDraft,
  readConnectionCapabilities,
  readConnectionMappings,
  readConnections,
  saveMappingDraft,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { capabilityDto, connectionDto, mappingDto } from './dto.js';
import { serviceContext } from './property.controller.js';

const uuid = z.string().uuid();
const connectionBody = z
  .object({
    provider_key: z.string().trim().min(2).max(64),
    environment: z.string().trim().min(2).max(32),
    channel_key: z.string().trim().min(2).max(64),
    external_property_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional(),
    secret_ref: z.string().trim().min(3).max(200),
  })
  .strict();
const mappingBody = z
  .object({
    channel_key: z.string().trim().min(2).max(64),
    external_room_ref: z.string().trim().min(1).max(200),
    external_rate_ref: z.string().trim().min(1).max(200),
    occupancy: z.number().int().min(1).max(100),
    meal_plan_ref: z.string().trim().min(1).max(200).nullable().optional(),
    internal_product_ref: uuid.nullable().optional(),
    internal_rate_ref: uuid.nullable().optional(),
  })
  .strict();

@Controller('api/v1/tenants')
export class ConnectionDraftsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('channel.read')
  @Get(':tenantId/properties/:propertyId/connections')
  async listConnections(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const connections = await readConnections(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: connections.map(connectionDto) };
  }

  @RequirePermission('channel.connection.manage')
  @Post(':tenantId/properties/:propertyId/connections')
  async createConnection(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = connectionBody.parse(body);
    const connection = await createConnectionDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        providerKey: input.provider_key,
        environment: input.environment,
        channelKey: input.channel_key,
        externalPropertyId: input.external_property_id ?? null,
        secretRef: input.secret_ref,
      },
    );
    return { connection: connectionDto(connection) };
  }

  @RequirePermission('channel.read')
  @Get(
    ':tenantId/properties/:propertyId/connections/:connectionId/capabilities',
  )
  async listCapabilities(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const capabilities = await readConnectionCapabilities(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(connectionId),
    );
    return { items: capabilities.map(capabilityDto) };
  }

  @RequirePermission('channel.read')
  @Get(':tenantId/properties/:propertyId/connections/:connectionId/mappings')
  async listMappings(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const mappings = await readConnectionMappings(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(connectionId),
    );
    return { items: mappings.map(mappingDto) };
  }

  @RequirePermission('channel.mapping.manage')
  @Put(':tenantId/properties/:propertyId/connections/:connectionId/mapping')
  async saveMapping(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    const input = mappingBody.parse(body);
    const mapping = await saveMappingDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(connectionId),
      {
        channelKey: input.channel_key,
        externalRoomRef: input.external_room_ref,
        externalRateRef: input.external_rate_ref,
        occupancy: input.occupancy,
        mealPlanRef: input.meal_plan_ref ?? null,
        internalProductRef: input.internal_product_ref ?? null,
        internalRateRef: input.internal_rate_ref ?? null,
      },
    );
    return { mapping: mappingDto(mapping) };
  }
}
