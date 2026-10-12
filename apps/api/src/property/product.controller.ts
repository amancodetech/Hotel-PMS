import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Patch,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  addPoolMember,
  addProductCandidate,
  createPool,
  createProduct,
  endPoolMemberById,
  readPoolMembers,
  readPools,
  readProductCandidates,
  readProducts,
  removeProductCandidate,
  updatePoolById,
  updateProductById,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import {
  poolDto,
  poolMemberDto,
  productCandidateDto,
  productDto,
} from './dto.js';
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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const occupancy = z.number().int().min(0).max(100);

const productBody = z
  .object({
    code,
    name,
    kind: resourceKind,
    occupancy_adults_min: occupancy.optional(),
    occupancy_adults_max: occupancy.optional(),
    occupancy_children_max: occupancy.optional(),
    meal_plan: z.enum(['NONE', 'BREAKFAST']).optional(),
  })
  .strict();
const productPatch = z
  .object({
    version,
    name: name.optional(),
    occupancy_adults_min: occupancy.optional(),
    occupancy_adults_max: occupancy.optional(),
    occupancy_children_max: occupancy.optional(),
    meal_plan: z.enum(['NONE', 'BREAKFAST']).optional(),
    pool_id: uuid.nullable().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED']).optional(),
  })
  .strict();
const candidateBody = z.object({ resource_id: uuid }).strict();
const poolBody = z.object({ code, name, resource_type: resourceKind }).strict();
const poolPatch = z
  .object({
    version,
    name: name.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();
const memberBody = z
  .object({ resource_id: uuid, effective_from: isoDate.optional() })
  .strict();
const memberPatch = z.object({ effective_to: isoDate }).strict();

@Controller('api/v1/tenants')
export class ProductsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/products')
  async listProducts(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const products = await readProducts(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: products.map(productDto) };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/products')
  async createProduct(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = productBody.parse(body);
    const product = await createProduct(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        code: input.code,
        name: input.name,
        kind: input.kind,
        adultsMin: input.occupancy_adults_min,
        adultsMax: input.occupancy_adults_max,
        childrenMax: input.occupancy_children_max,
        mealPlan: input.meal_plan,
      },
    );
    return { product: productDto(product) };
  }

  @RequirePermission('property.resource.manage')
  @Patch(':tenantId/properties/:propertyId/products/:productId')
  async updateProduct(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    const patch = productPatch.parse(body);
    const product = await updateProductById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(productId),
      {
        version: patch.version,
        name: patch.name,
        adultsMin: patch.occupancy_adults_min,
        adultsMax: patch.occupancy_adults_max,
        childrenMax: patch.occupancy_children_max,
        mealPlan: patch.meal_plan,
        poolId: patch.pool_id,
        status: patch.status,
      },
    );
    return { product: productDto(product) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/products/:productId/candidates')
  async listCandidates(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('productId') productId: string,
  ) {
    const candidates = await readProductCandidates(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(productId),
    );
    return { items: candidates.map(productCandidateDto) };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/products/:productId/candidates')
  async addCandidate(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    const input = candidateBody.parse(body);
    const candidate = await addProductCandidate(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(productId),
      uuid.parse(input.resource_id),
    );
    return { candidate: productCandidateDto(candidate) };
  }

  @RequirePermission('property.resource.manage')
  @Delete(
    ':tenantId/properties/:propertyId/products/:productId/candidates/:resourceId',
  )
  async removeCandidate(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('productId') productId: string,
    @Param('resourceId') resourceId: string,
  ) {
    await removeProductCandidate(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(productId),
      uuid.parse(resourceId),
    );
    return { removed: true };
  }
}

@Controller('api/v1/tenants')
export class PoolsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/pools')
  async listPools(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const pools = await readPools(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: pools.map(poolDto) };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/pools')
  async createPool(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = poolBody.parse(body);
    const pool = await createPool(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        code: input.code,
        name: input.name,
        resourceType: input.resource_type,
      },
    );
    return { pool: poolDto(pool) };
  }

  @RequirePermission('property.resource.manage')
  @Patch(':tenantId/properties/:propertyId/pools/:poolId')
  async updatePool(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
  ) {
    const patch = poolPatch.parse(body);
    const pool = await updatePoolById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(poolId),
      patch,
    );
    return { pool: poolDto(pool) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/pools/:poolId/members')
  async listMembers(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('poolId') poolId: string,
  ) {
    const members = await readPoolMembers(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(poolId),
    );
    return { items: members.map(poolMemberDto) };
  }

  @RequirePermission('property.resource.manage')
  @Post(':tenantId/properties/:propertyId/pools/:poolId/members')
  async addMember(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('poolId') poolId: string,
    @Body() body: unknown,
  ) {
    const input = memberBody.parse(body);
    const member = await addPoolMember(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(poolId),
      {
        resourceId: uuid.parse(input.resource_id),
        effectiveFrom: input.effective_from,
      },
    );
    return { member: poolMemberDto(member) };
  }

  @RequirePermission('property.resource.manage')
  @Patch(':tenantId/properties/:propertyId/pools/:poolId/members/:resourceId')
  async endMember(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('poolId') poolId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: unknown,
  ) {
    const patch = memberPatch.parse(body);
    const member = await endPoolMemberById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(poolId),
      uuid.parse(resourceId),
      patch.effective_to,
    );
    return { member: poolMemberDto(member) };
  }
}
