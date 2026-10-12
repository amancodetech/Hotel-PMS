import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Patch,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createProperty,
  createPropertyGroup,
  IdentityError,
  readProperties,
  readProperty,
  readPropertyGroups,
  readResourceTypes,
  updatePropertyById,
  updatePropertyGroupById,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { requestCorrelation } from '../identity/http.js';
import { propertyDto, propertyGroupDto, resourceTypeDto } from './dto.js';

const uuid = z.string().uuid();
const code = z.string().trim().min(1).max(40);
const name = z.string().trim().min(1).max(160);
const timezone = z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']);
const currency = z.enum(['IDR', 'USD']);
const version = z.number().int().min(1);

const groupBody = z.object({ code, name }).strict();
const groupPatch = z
  .object({
    version,
    name: name.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
const propertyBody = z
  .object({
    code,
    name,
    timezone,
    base_currency: currency.optional(),
    group_id: uuid.nullable().optional(),
  })
  .strict();
const propertyPatch = z
  .object({
    version,
    name: name.optional(),
    group_id: uuid.nullable().optional(),
    status: z.enum(['SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  })
  .strict();

export function serviceContext(request: AuthedRequest, tenantId: string) {
  const auth = request.auth;
  if (!auth) throw new IdentityError('AUTH_REQUIRED');
  return {
    actor: auth.actor,
    tenantId,
    correlationId: requestCorrelation(request),
  };
}

@Controller('api/v1/tenants')
export class PropertiesController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/property-groups')
  async listGroups(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const groups = await readPropertyGroups(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
    );
    return { items: groups.map(propertyGroupDto) };
  }

  @RequirePermission('property.manage')
  @Post(':tenantId/property-groups')
  async createGroup(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const input = groupBody.parse(body);
    const group = await createPropertyGroup(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      input,
    );
    return { group: propertyGroupDto(group) };
  }

  @RequirePermission('property.manage')
  @Patch(':tenantId/property-groups/:groupId')
  async updateGroup(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ) {
    const patch = groupPatch.parse(body);
    const group = await updatePropertyGroupById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(groupId),
      patch,
    );
    return { group: propertyGroupDto(group) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties')
  async listProperties(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const properties = await readProperties(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
    );
    return { items: properties.map(propertyDto) };
  }

  @RequirePermission('property.manage')
  @Post(':tenantId/properties')
  async createProperty(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const input = propertyBody.parse(body);
    const property = await createProperty(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      {
        code: input.code,
        name: input.name,
        timezone: input.timezone,
        baseCurrency: input.base_currency ?? 'IDR',
        groupId: input.group_id ?? null,
      },
    );
    return { property: propertyDto(property) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId')
  async getProperty(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const property = await readProperty(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { property: propertyDto(property) };
  }

  @RequirePermission('property.manage')
  @Patch(':tenantId/properties/:propertyId')
  async updateProperty(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const patch = propertyPatch.parse(body);
    const property = await updatePropertyById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      patch,
    );
    return { property: propertyDto(property) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/resource-types')
  async listResourceTypes(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const types = await readResourceTypes(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
    );
    return { items: types.map(resourceTypeDto) };
  }
}
