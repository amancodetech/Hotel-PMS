import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import {
  assertPeriod,
  assertPropertyConfigurable,
  periodWithin,
} from '../domain/lifecycle.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  activateCompositionVersion,
  findCompositionVersion,
  findPropertyLimits,
  insertCompositionEdge,
  insertCompositionLeaf,
  insertCompositionVersion,
  listCompositionEdges,
  listCompositionLeaves,
  listCompositionVersions,
  nextCompositionVersionNumber,
} from '../persistence/composition-repository.js';
import { findProduct } from '../persistence/product-repository.js';
import {
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import {
  findResource,
  listParentResourceIds,
} from '../persistence/resource-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type {
  CompositionEdgeRow,
  CompositionLeafRow,
  CompositionVersionRow,
} from '../persistence/types.js';

export interface CompositionInput {
  productId: string;
  effectiveFrom: string;
  effectiveTo: string;
  resourceIds: string[];
  nestedVersionIds: string[];
}

export interface CompositionDetail {
  composition: CompositionVersionRow;
  edges: CompositionEdgeRow[];
  leaves: CompositionLeafRow[];
}

function compositionAudit(
  version: CompositionVersionRow,
): Record<string, unknown> {
  return {
    product_id: version.product_id,
    version_number: version.version_number,
    effective_from: version.effective_from,
    effective_to: version.effective_to,
    status: version.status,
    version: version.version,
  };
}

export async function readCompositions(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<CompositionVersionRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return listCompositionVersions(em, context.tenantId, propertyId);
    },
  );
}

export async function createComposition(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: CompositionInput,
): Promise<CompositionVersionRow> {
  assertPeriod(input.effectiveFrom, input.effectiveTo);
  if (input.resourceIds.length + input.nestedVersionIds.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'edges' });
  if (new Set(input.resourceIds).size !== input.resourceIds.length)
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  if (new Set(input.nestedVersionIds).size !== input.nestedVersionIds.length)
    throw new PropertyError('INVALID_REQUEST', { field: 'nested_version_ids' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'composition.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        input.productId,
      );
      if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (product.status === 'RETIRED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: product.status,
          to: 'DRAFT',
        });
      for (const resourceId of input.resourceIds) {
        const resource = await findResource(
          em,
          context.tenantId,
          propertyId,
          resourceId,
        );
        if (!resource) throw new PropertyError('NOT_FOUND');
        if (resource.state === 'RETIRED')
          throw new PropertyError('RESOURCE_RETIRED');
      }
      const parents = await listParentResourceIds(
        em,
        context.tenantId,
        propertyId,
        input.resourceIds,
      );
      if (parents.size > 0)
        throw new PropertyError('RESOURCE_HAS_CHILDREN', {
          resource_ids: [...parents],
        });
      for (const nestedId of input.nestedVersionIds) {
        const nested = await findCompositionVersion(
          em,
          context.tenantId,
          propertyId,
          nestedId,
        );
        if (!nested) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (nested.status === 'RETIRED')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            from: nested.status,
            to: 'DRAFT',
          });
      }
      const versionNumber = await nextCompositionVersionNumber(
        em,
        context.tenantId,
        propertyId,
        input.productId,
      );
      const version = await translatePropertyWrite(() =>
        insertCompositionVersion(em, {
          tenantId: context.tenantId,
          propertyId,
          productId: input.productId,
          versionNumber,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
        }),
      );
      let position = 0;
      for (const resourceId of input.resourceIds) {
        const resource = await findResource(
          em,
          context.tenantId,
          propertyId,
          resourceId,
        );
        if (!resource) throw new PropertyError('NOT_FOUND');
        await insertCompositionEdge(em, {
          versionId: version.id,
          tenantId: context.tenantId,
          propertyId,
          position,
          childKind: 'RESOURCE',
          resourceId,
          childVersionId: null,
        });
        position += 1;
      }
      for (const nestedId of input.nestedVersionIds) {
        await insertCompositionEdge(em, {
          versionId: version.id,
          tenantId: context.tenantId,
          propertyId,
          position,
          childKind: 'COMPOSITION',
          resourceId: null,
          childVersionId: nestedId,
        });
        position += 1;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'composition.created',
        resourceType: 'CompositionVersion',
        resourceId: version.id,
        outcome: 'SUCCESS',
        afterSafe: compositionAudit(version),
        correlationId: context.correlationId,
      });
      return version;
    },
  );
}

interface PendingLeaf {
  resourceId: string;
  depth: number;
}

export async function buildFlattening(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  version: CompositionVersionRow,
): Promise<PendingLeaf[]> {
  const limits = await findPropertyLimits(em, context.tenantId, propertyId);
  if (!limits) throw new PropertyError('NOT_FOUND');
  const edges = await listCompositionEdges(em, version.id);
  if (edges.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'edges' });
  const collected: PendingLeaf[] = [];
  const seen = new Map<string, number>();
  const add = (resourceId: string, depth: number) => {
    if (seen.has(resourceId)) throw new PropertyError('DUPLICATE_LEAF');
    if (depth > limits.max_composition_depth)
      throw new PropertyError('LIMIT_EXCEEDED', {
        limit: 'max_composition_depth',
      });
    if (seen.size >= limits.max_leaves_per_product)
      throw new PropertyError('LIMIT_EXCEEDED', {
        limit: 'max_leaves_per_product',
      });
    seen.set(resourceId, depth);
    collected.push({ resourceId, depth });
  };
  for (const edge of edges) {
    if (edge.child_kind === 'RESOURCE') {
      if (!edge.resource_id)
        throw new PropertyError('INVALID_REQUEST', { field: 'edges' });
      const resource = await findResource(
        em,
        context.tenantId,
        propertyId,
        edge.resource_id,
      );
      if (!resource) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (resource.state === 'RETIRED')
        throw new PropertyError('RESOURCE_RETIRED');
      const parents = await listParentResourceIds(
        em,
        context.tenantId,
        propertyId,
        [edge.resource_id],
      );
      if (parents.has(edge.resource_id))
        throw new PropertyError('RESOURCE_HAS_CHILDREN', {
          resource_id: edge.resource_id,
        });
      add(edge.resource_id, 1);
      continue;
    }
    if (!edge.child_version_id)
      throw new PropertyError('INVALID_REQUEST', { field: 'edges' });
    const child = await findCompositionVersion(
      em,
      context.tenantId,
      propertyId,
      edge.child_version_id,
    );
    if (!child) throw new PropertyError('CROSS_SCOPE_REFERENCE');
    if (child.status !== 'ACTIVE')
      throw new PropertyError('INVALID_STATE_TRANSITION', {
        from: child.status,
        to: 'ACTIVE',
      });
    if (
      !periodWithin(
        { from: child.effective_from, to: child.effective_to },
        { from: version.effective_from, to: version.effective_to },
      )
    )
      throw new PropertyError('INVALID_REQUEST', {
        field: 'effective_period',
      });
    const childLeaves = await listCompositionLeaves(em, child.id);
    if (childLeaves.length === 0)
      throw new PropertyError('INVALID_REQUEST', { field: 'nested_leaves' });
    for (const leaf of childLeaves) add(leaf.resource_id, leaf.depth + 1);
  }
  return collected;
}

export async function activateCompositionById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  compositionId: string,
  reason: string | null,
): Promise<CompositionDetail> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'composition.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const version = await findCompositionVersion(
        em,
        context.tenantId,
        propertyId,
        compositionId,
      );
      if (!version) throw new PropertyError('NOT_FOUND');
      if (version.status !== 'DRAFT')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: version.status,
          to: 'ACTIVE',
        });
      const leaves = await buildFlattening(em, context, propertyId, version);
      for (const leaf of leaves) {
        try {
          await insertCompositionLeaf(em, {
            versionId: version.id,
            tenantId: context.tenantId,
            propertyId,
            resourceId: leaf.resourceId,
            depth: leaf.depth,
          });
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? (error as { code?: string }).code
              : null;
          if (code === '23505') throw new PropertyError('DUPLICATE_LEAF');
          throw error;
        }
      }
      const activated = await activateCompositionVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        versionId: version.id,
        version: version.version,
      });
      if (!activated) throw new PropertyError('STALE_VERSION');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'composition.activated',
        resourceType: 'CompositionVersion',
        resourceId: version.id,
        outcome: 'SUCCESS',
        beforeSafe: compositionAudit(version),
        afterSafe: {
          ...compositionAudit(activated),
          leaf_count: leaves.length,
        },
        reason,
        correlationId: context.correlationId,
      });
      return {
        composition: activated,
        edges: await listCompositionEdges(em, version.id),
        leaves: await listCompositionLeaves(em, version.id),
      };
    },
  );
}

export async function readCompositionDetail(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  compositionId: string,
): Promise<CompositionDetail> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const version = await findCompositionVersion(
        em,
        context.tenantId,
        propertyId,
        compositionId,
      );
      if (!version) throw new PropertyError('NOT_FOUND');
      return {
        composition: version,
        edges: await listCompositionEdges(em, version.id),
        leaves: await listCompositionLeaves(em, version.id),
      };
    },
  );
}
