import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  createLocation,
  createResource,
  readLocations,
  readLocationTree,
  readResources,
  setResourceMaintenanceState,
  updateLocationById,
  updateResourceById,
  previewArchiveImpact,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { locationDto, resourceDto } from './dto.js';
import { serviceContext } from './property.controller.js';

const uuid = z.string().uuid();
const code = z.string().trim().min(1).max(80);
const name = z.string().trim().min(1).max(160);
const version = z.number().int().min(1);
const resourceKind = z.enum([
  'ROOM',
  'BED',
  'VILLA',
  'APARTMENT',
  'HOUSE',
  'SITE',
  'TENT',
  'CABIN',
]);

const locationFields = {
  parent_id: uuid.nullable().optional(),
  kind: z
    .enum(['ZONE', 'BUILDING', 'WING', 'FLOOR', 'CLUSTER', 'SERVICE_AREA'])
    .nullable()
    .optional(),
  display_order: z.number().int().min(0).max(2147483647).optional(),
};
const unitFields = {
  display_label: z.string().trim().min(1).max(160).nullable().optional(),
  unit_details: z
    .object({
      bedrooms_count: z.number().int().min(0).max(100).optional(),
      bathrooms_count: z.number().int().min(0).max(100).optional(),
      notes: z.string().max(1000).optional(),
    })
    .strict()
    .optional(),
};
const locationBody = z
  .object({ code: code.max(40), name, ...locationFields })
  .strict();
const locationQuery = z
  .object({
    tree: z.literal('true').optional(),
    parent_id: z.union([uuid, z.literal('root')]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().max(2048).optional(),
    q: z.string().trim().max(100).optional(),
    kind: z
      .enum(['ZONE', 'BUILDING', 'WING', 'FLOOR', 'CLUSTER', 'SERVICE_AREA'])
      .optional(),
    sort: z.enum(['display_order', 'code', 'name']).optional(),
  })
  .strict()
  .refine(
    (q) =>
      q.tree ||
      (q.parent_id === undefined &&
        q.limit === undefined &&
        q.cursor === undefined &&
        q.q === undefined &&
        q.kind === undefined &&
        q.sort === undefined),
  );
const locationPatch = z
  .object({
    version,
    name: name.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    ...locationFields,
  })
  .strict();
const resourceBody = z
  .object({
    code,
    type: resourceKind,
    ...unitFields,
    capacity: z.number().int().min(1).max(100),
    location_id: uuid.nullable().optional(),
    parent_resource_id: uuid.nullable().optional(),
  })
  .strict();
const resourcePatch = z
  .object({
    version,
    capacity: z.number().int().min(1).max(100).optional(),
    location_id: uuid.nullable().optional(),
    state: z.enum(['ACTIVE', 'INACTIVE', 'RETIRED']).optional(),
    ...unitFields,
  })
  .strict();
const maintenanceBody = z
  .object({
    version,
    state: z.enum(['NONE', 'OOO', 'OOS']),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(1600).optional(),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(['code', 'label', 'capacity']).optional(),
    type: z
      .enum([
        'ROOM',
        'VILLA',
        'APARTMENT',
        'HOUSE',
        'BED',
        'SITE',
        'CABIN',
        'TENT',
      ])
      .optional(),
    min_capacity: z.coerce.number().int().min(1).max(100).optional(),
    bedrooms_count: z.coerce.number().int().min(0).max(100).optional(),
    bathrooms_count: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

@Controller('api/v1/tenants')
export class ResourcesController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/locations/:locationId/archive-preview')
  async locationArchivePreview(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('locationId') locationId: string,
  ) {
    return previewArchiveImpact(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      'LOCATION',
      uuid.parse(locationId),
    );
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/resources/:resourceId/archive-preview')
  async resourceArchivePreview(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return previewArchiveImpact(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      'RESOURCE',
      uuid.parse(resourceId),
    );
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/locations')
  async listLocations(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const options = locationQuery.parse(query);
    if (options.tree) {
      const page = await readLocationTree(
        this.runtime.orm,
        serviceContext(request, uuid.parse(tenantId)),
        uuid.parse(propertyId),
        {
          ...options,
          parent_id: options.parent_id === 'root' ? null : options.parent_id,
        },
      );
      return {
        ...page,
        items: page.items.map(locationDto),
        ancestors: page.ancestors.map(locationDto),
      };
    }
    const locations = await readLocations(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: locations.map(locationDto) };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/locations')
  async createLocation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    const input = locationBody.parse(body);
    const location = await createLocation(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input,
      key,
    );
    return { location: locationDto(location) };
  }

  @RequirePermission('property.resource.manage')
  @Patch(':tenantId/properties/:propertyId/locations/:locationId')
  async updateLocation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('locationId') locationId: string,
    @Body() body: unknown,
  ) {
    const patch = locationPatch.parse(body);
    const location = await updateLocationById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(locationId),
      patch,
    );
    return { location: locationDto(location) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/resources')
  async listResources(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const filters = listQuery.parse(query);
    const page = await readResources(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      filters,
    );
    return {
      items: page.items.map(resourceDto),
      next_cursor: page.next_cursor,
    };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/resources')
  async createResource(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const input = resourceBody.parse(body);
    const resource = await createResource(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        code: input.code,
        type: input.type,
        capacity: input.capacity,
        locationId: input.location_id ?? null,
        parentResourceId: input.parent_resource_id,
        display_label: input.display_label,
        unit_details: input.unit_details,
      },
      key,
    );
    return { resource: resourceDto(resource) };
  }

  @RequirePermission('property.resource.manage')
  @Patch(':tenantId/properties/:propertyId/resources/:resourceId')
  async updateResource(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: unknown,
  ) {
    const patch = resourcePatch.parse(body);
    const resource = await updateResourceById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(resourceId),
      { ...patch, locationId: patch.location_id },
    );
    return { resource: resourceDto(resource) };
  }

  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/resources/:resourceId/maintenance')
  async setResourceMaintenance(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: unknown,
  ) {
    const input = maintenanceBody.parse(body);
    const resource = await setResourceMaintenanceState(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(resourceId),
      input,
    );
    return { resource: resourceDto(resource) };
  }
}
