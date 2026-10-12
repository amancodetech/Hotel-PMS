import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import {
  assertCode,
  assertName,
  assertOccupancy,
  assertProductMutable,
  assertProductTransition,
  assertPropertyConfigurable,
  isMealPlan,
  isProductStatus,
  isResourceKind,
  type MealPlan,
  type ProductStatus,
  type ResourceKind,
} from '../domain/lifecycle.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  findPool,
  countActivePoolMembers,
} from '../persistence/pool-repository.js';
import { countActiveCompositionVersions } from '../persistence/composition-repository.js';
import {
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import {
  countUsableCandidates,
  deleteProductCandidate,
  findProduct,
  insertProduct,
  insertProductCandidate,
  listProductCandidates,
  listProducts,
  updateProduct,
} from '../persistence/product-repository.js';
import {
  findResource,
  listParentResourceIds,
} from '../persistence/resource-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type { ProductCandidateRow, ProductRow } from '../persistence/types.js';

export interface ProductInput {
  code: string;
  name: string;
  kind: ResourceKind;
  adultsMin?: number;
  adultsMax?: number;
  childrenMax?: number;
  mealPlan?: MealPlan;
}

export interface ProductPatch {
  version: number;
  name?: string;
  adultsMin?: number;
  adultsMax?: number;
  childrenMax?: number;
  mealPlan?: MealPlan;
  poolId?: string | null;
  status?: ProductStatus;
}

function productAudit(product: ProductRow): Record<string, unknown> {
  return {
    code: product.code,
    name: product.name,
    kind: product.kind,
    occupancy_adults_min: product.occupancy_adults_min,
    occupancy_adults_max: product.occupancy_adults_max,
    occupancy_children_max: product.occupancy_children_max,
    meal_plan: product.meal_plan,
    pool_id: product.pool_id,
    status: product.status,
    version: product.version,
  };
}

export async function readProducts(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<ProductRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return listProducts(em, context.tenantId, propertyId);
    },
  );
}

export async function createProduct(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ProductInput,
): Promise<ProductRow> {
  const code = assertCode(input.code, 80);
  const name = assertName(input.name);
  if (!isResourceKind(input.kind))
    throw new PropertyError('INVALID_REQUEST', { field: 'kind' });
  const adultsMin = input.adultsMin ?? 1;
  const adultsMax = input.adultsMax ?? 2;
  const childrenMax = input.childrenMax ?? 0;
  const mealPlan = input.mealPlan ?? 'NONE';
  assertOccupancy({ adultsMin, adultsMax, childrenMax });
  if (!isMealPlan(mealPlan))
    throw new PropertyError('INVALID_REQUEST', { field: 'meal_plan' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const product = await translatePropertyWrite(() =>
        insertProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          code,
          name,
          kind: input.kind,
          adultsMin,
          adultsMax,
          childrenMax,
          mealPlan,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'product.created',
        resourceType: 'Product',
        resourceId: product.id,
        outcome: 'SUCCESS',
        afterSafe: productAudit(product),
        correlationId: context.correlationId,
      });
      return product;
    },
  );
}

export async function updateProductById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  productId: string,
  patch: ProductPatch,
): Promise<ProductRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.status !== undefined && !isProductStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (patch.mealPlan !== undefined && !isMealPlan(patch.mealPlan))
    throw new PropertyError('INVALID_REQUEST', { field: 'meal_plan' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findProduct(
        em,
        context.tenantId,
        propertyId,
        productId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      assertProductMutable(current.status);
      const adultsMin = patch.adultsMin ?? current.occupancy_adults_min;
      const adultsMax = patch.adultsMax ?? current.occupancy_adults_max;
      const childrenMax = patch.childrenMax ?? current.occupancy_children_max;
      if (
        patch.adultsMin !== undefined ||
        patch.adultsMax !== undefined ||
        patch.childrenMax !== undefined
      )
        assertOccupancy({ adultsMin, adultsMax, childrenMax });
      if (patch.poolId) {
        const pool = await findPool(
          em,
          context.tenantId,
          propertyId,
          patch.poolId,
        );
        if (!pool) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (pool.resource_type !== current.kind)
          throw new PropertyError('TYPE_MISMATCH', {
            product_kind: current.kind,
            pool_type: pool.resource_type,
          });
      }
      if (patch.status !== undefined)
        assertProductTransition(current.status, patch.status);
      if (patch.status === 'ACTIVE') {
        const candidates = await countUsableCandidates(
          em,
          context.tenantId,
          propertyId,
          productId,
        );
        let poolMembers = 0;
        const poolRef = patch.poolId ?? current.pool_id;
        if (poolRef)
          poolMembers = await countActivePoolMembers(
            em,
            context.tenantId,
            propertyId,
            poolRef,
          );
        const compositions = await countActiveCompositionVersions(
          em,
          context.tenantId,
          propertyId,
          productId,
        );
        if (candidates + poolMembers + compositions === 0)
          throw new PropertyError('PRODUCT_INCOMPLETE');
      }
      const updated = await updateProduct(em, {
        tenantId: context.tenantId,
        propertyId,
        productId,
        version: patch.version,
        name,
        adultsMin: patch.adultsMin,
        adultsMax: patch.adultsMax,
        childrenMax: patch.childrenMax,
        mealPlan: patch.mealPlan,
        poolId: patch.poolId,
        status: patch.status,
      });
      if (!updated) throw new PropertyError('STALE_VERSION');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'product.updated',
        resourceType: 'Product',
        resourceId: productId,
        outcome: 'SUCCESS',
        beforeSafe: productAudit(current),
        afterSafe: productAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function readProductCandidates(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  productId: string,
): Promise<ProductCandidateRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        productId,
      );
      if (!product) throw new PropertyError('NOT_FOUND');
      return listProductCandidates(em, context.tenantId, propertyId, productId);
    },
  );
}

export async function addProductCandidate(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  productId: string,
  resourceId: string,
): Promise<ProductCandidateRow> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        productId,
      );
      if (!product) throw new PropertyError('NOT_FOUND');
      assertProductMutable(product.status);
      const resource = await findResource(
        em,
        context.tenantId,
        propertyId,
        resourceId,
      );
      if (!resource) throw new PropertyError('NOT_FOUND');
      if (resource.state === 'RETIRED')
        throw new PropertyError('RESOURCE_RETIRED');
      if (resource.resource_type !== product.kind)
        throw new PropertyError('TYPE_MISMATCH', {
          product_kind: product.kind,
          resource_type: resource.resource_type,
        });
      const parents = await listParentResourceIds(
        em,
        context.tenantId,
        propertyId,
        [resourceId],
      );
      if (parents.has(resourceId))
        throw new PropertyError('RESOURCE_HAS_CHILDREN', {
          resource_id: resourceId,
        });
      const candidate = await translatePropertyWrite(() =>
        insertProductCandidate(em, {
          tenantId: context.tenantId,
          propertyId,
          productId,
          resourceId,
          resourceType: resource.resource_type,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'product.candidate_added',
        resourceType: 'Product',
        resourceId: productId,
        outcome: 'SUCCESS',
        afterSafe: {
          resource_id: resourceId,
          resource_type: resource.resource_type,
        },
        correlationId: context.correlationId,
      });
      return candidate;
    },
  );
}

export async function removeProductCandidate(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  productId: string,
  resourceId: string,
): Promise<void> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        productId,
      );
      if (!product) throw new PropertyError('NOT_FOUND');
      assertProductMutable(product.status);
      const removed = await deleteProductCandidate(em, {
        tenantId: context.tenantId,
        propertyId,
        productId,
        resourceId,
      });
      if (!removed) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'product.candidate_removed',
        resourceType: 'Product',
        resourceId: productId,
        outcome: 'SUCCESS',
        beforeSafe: { resource_id: resourceId },
        correlationId: context.correlationId,
      });
    },
  );
}
