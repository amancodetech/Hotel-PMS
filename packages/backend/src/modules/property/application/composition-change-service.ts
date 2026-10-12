import { createHash } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import { assertPropertyConfigurable } from '../domain/lifecycle.js';
import { businessToday } from '../../front-office/application/front-office-service.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  activateCompositionVersion,
  closeActiveCompositionVersion,
  findCompositionVersion,
  findPropertyLimits,
  insertCompositionEdge,
  insertCompositionLeaf,
  insertCompositionVersion,
  listActiveCompositionVersionsForProduct,
  listCompositionLeaves,
  listResourceAllocations,
  listResourceBlocks,
  nextCompositionVersionNumber,
  retireActiveCompositionVersion,
} from '../persistence/composition-repository.js';
import { findProduct } from '../persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import {
  findResource,
  listParentResourceIds,
} from '../persistence/resource-repository.js';
import {
  listResourceIds,
  readMigrationCounts,
} from '../persistence/setup-insights-repository.js';
import { buildFlattening } from './composition-service.js';
import type {
  CompositionVersionRow,
  ProductRow,
  ResourceAllocationRow,
  ResourceBlockRow,
} from '../persistence/types.js';

export interface CompositionChangeInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  resourceIds: string[];
  previewFingerprint?: string | null;
  idempotencyKey?: string | null;
}

export interface CompositionLeafView {
  resource_id: string;
  code: string;
  resource_type: string;
}

export interface CompositionChangeImpact {
  verdict: 'SAFE' | 'BLOCKED';
  fingerprint: string;
  product_id: string;
  product_code: string;
  composition_id: string;
  current: {
    composition: CompositionVersionRow;
    leaves: CompositionLeafView[];
  };
  proposed: {
    effective_from: string;
    effective_to: string | null;
    leaves: CompositionLeafView[];
  };
  conflicts: ResourceAllocationRow[];
  retained_commitments: ResourceAllocationRow[];
  removed_leaves: CompositionLeafView[];
  intersecting_blocks: ResourceBlockRow[];
}

export interface MigrationInput {
  productId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  resourceIds: string[];
  previewFingerprint?: string | null;
  idempotencyKey?: string | null;
}

export interface MigrationCounts {
  resources: number;
  future_commitments: number;
  active_compositions: number;
  product_active_versions: number;
}

export interface MigrationPreview {
  verdict: 'SAFE' | 'BLOCKED';
  fingerprint: string;
  product_id: string;
  product_code: string;
  effective_from: string;
  effective_to: string | null;
  leaves: CompositionLeafView[];
  conflicts: ResourceAllocationRow[];
  intersecting_blocks: ResourceBlockRow[];
  before: MigrationCounts;
  after: MigrationCounts;
}

export interface MigrationReconciliation {
  before: MigrationCounts;
  after: MigrationCounts;
  resource_ids_preserved: boolean;
  resource_ids: string[];
}

export interface MigrationResult {
  composition: CompositionVersionRow;
  reconciliation: MigrationReconciliation;
  fingerprint: string;
  replayed?: boolean;
}

export interface CompositionChangeResult {
  composition: CompositionVersionRow;
  superseded: CompositionVersionRow;
  fingerprint: string;
  replayed?: boolean;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const OP_CHANGE = 'composition.change.apply';
const OP_MIGRATION = 'setup.migration.apply';

function assertIsoDate(value: string, field: string): void {
  if (!isoDate.test(value) || value.startsWith('0000'))
    throw new PropertyError('INVALID_REQUEST', { field });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new PropertyError('INVALID_REQUEST', { field });
}

export function assertNotBackdated(
  effectiveFrom: string,
  today: string,
  field = 'effective_from',
): void {
  if (effectiveFrom < today)
    throw new PropertyError('INVALID_REQUEST', { field });
}

function previousDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function fingerprintOf(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function windowsOverlap(
  left: { from: string; to: string | null },
  right: { from: string; to: string | null },
): boolean {
  if (left.to !== null && left.to < right.from) return false;
  if (right.to !== null && right.to < left.from) return false;
  return true;
}

async function resolveProduct(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<ProductRow> {
  const product = await findProduct(em, tenantId, propertyId, productId);
  if (!product) throw new PropertyError('NOT_FOUND');
  if (product.status === 'RETIRED')
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      from: product.status,
      to: 'ACTIVE',
    });
  return product;
}

async function resolveLeaves(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: string[],
  maxLeaves: number,
): Promise<CompositionLeafView[]> {
  if (resourceIds.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  if (new Set(resourceIds).size !== resourceIds.length)
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  if (resourceIds.length > maxLeaves)
    throw new PropertyError('LIMIT_EXCEEDED', {
      limit: 'max_leaves_per_product',
    });
  const resolved: CompositionLeafView[] = [];
  for (const resourceId of resourceIds) {
    const resource = await findResource(em, tenantId, propertyId, resourceId);
    if (!resource) throw new PropertyError('NOT_FOUND');
    if (resource.state === 'RETIRED')
      throw new PropertyError('RESOURCE_RETIRED');
    resolved.push({
      resource_id: resource.id,
      code: resource.code,
      resource_type: resource.resource_type,
    });
  }
  const parents = await listParentResourceIds(
    em,
    tenantId,
    propertyId,
    resourceIds,
  );
  if (parents.size > 0)
    throw new PropertyError('RESOURCE_HAS_CHILDREN', {
      resource_ids: [...parents],
    });
  return resolved;
}

async function leafViews(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  versionId: string,
): Promise<CompositionLeafView[]> {
  const leaves = await listCompositionLeaves(em, versionId);
  const views: CompositionLeafView[] = [];
  for (const leaf of leaves) {
    const resource = await findResource(
      em,
      tenantId,
      propertyId,
      leaf.resource_id,
    );
    views.push({
      resource_id: leaf.resource_id,
      code: resource?.code ?? leaf.resource_id,
      resource_type: resource?.resource_type ?? 'ROOM',
    });
  }
  return views;
}

interface Impact {
  conflicts: ResourceAllocationRow[];
  retained: ResourceAllocationRow[];
  blocks: ResourceBlockRow[];
}

async function impactOf(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  input: {
    productId: string;
    leaves: CompositionLeafView[];
    removed: CompositionLeafView[];
    effectiveFrom: string;
    effectiveTo: string | null;
  },
): Promise<Impact> {
  const to = input.effectiveTo ?? '9999-12-31';
  const proposedIds = input.leaves.map((leaf) => leaf.resource_id);
  const removedIds = input.removed.map((leaf) => leaf.resource_id);
  const considered = [...new Set([...proposedIds, ...removedIds])];
  const allocations = await listResourceAllocations(em, {
    tenantId: context.tenantId,
    propertyId,
    resourceIds: considered,
    from: input.effectiveFrom,
    to,
  });
  const proposedSet = new Set(proposedIds);
  const conflicts = allocations.filter((row) => {
    if (!proposedSet.has(row.resource_id)) return false;
    if (row.source_kind === 'HOLD') return true;
    return row.product_id !== input.productId;
  });
  const retained = allocations.filter(
    (row) =>
      !proposedSet.has(row.resource_id) && row.product_id === input.productId,
  );
  const blocks = await listResourceBlocks(em, {
    tenantId: context.tenantId,
    propertyId,
    resourceIds: considered,
    from: input.effectiveFrom,
    to,
  });
  return { conflicts, retained, blocks };
}

function assertNoWindowOverlap(
  windows: CompositionVersionRow[],
  proposed: { from: string; to: string | null },
): void {
  for (const other of windows) {
    if (
      windowsOverlap(proposed, {
        from: other.effective_from,
        to: other.effective_to,
      })
    )
      throw new PropertyError('COMPOSITION_WINDOW_CONFLICT', {
        composition_id: other.id,
        effective_from: other.effective_from,
        effective_to: other.effective_to,
      });
  }
}

function effectSnapshot(impact: Impact) {
  return {
    conflicts: impact.conflicts.map((row) => [
      row.commitment_id,
      row.resource_id,
      row.start_date,
      row.end_date,
      row.source_kind,
      row.product_id,
    ]),
    retained: impact.retained.map((row) => [
      row.commitment_id,
      row.resource_id,
      row.start_date,
      row.end_date,
    ]),
    blocks: impact.blocks.map((row) => [
      row.block_id,
      row.resource_id,
      row.mode,
      row.start_date,
      row.end_date,
    ]),
  };
}

async function writeVersionLeaves(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  version: CompositionVersionRow,
  resourceIds: string[],
): Promise<void> {
  let position = 0;
  for (const resourceId of resourceIds) {
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
  const leaves = await buildFlattening(em, context, propertyId, version);
  for (const leaf of leaves) {
    await insertCompositionLeaf(em, {
      versionId: version.id,
      tenantId: context.tenantId,
      propertyId,
      resourceId: leaf.resourceId,
      depth: leaf.depth,
    });
  }
}

async function planCompositionChange(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  compositionId: string,
  input: CompositionChangeInput,
  now: { today: string; inventoryVersion: number },
): Promise<CompositionChangeImpact> {
  const version = await findCompositionVersion(
    em,
    context.tenantId,
    propertyId,
    compositionId,
  );
  if (!version) throw new PropertyError('NOT_FOUND');
  if (version.status !== 'ACTIVE')
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      from: version.status,
      to: 'ACTIVE',
    });
  const product = await resolveProduct(
    em,
    context.tenantId,
    propertyId,
    version.product_id,
  );
  assertIsoDate(input.effectiveFrom, 'effective_from');
  assertNotBackdated(input.effectiveFrom, now.today);
  if (input.effectiveFrom < version.effective_from)
    throw new PropertyError('INVALID_REQUEST', { field: 'effective_from' });
  if (input.effectiveTo !== null)
    assertIsoDate(input.effectiveTo, 'effective_to');
  const effectiveTo = input.effectiveTo ?? version.effective_to;
  if (effectiveTo !== null && effectiveTo < input.effectiveFrom)
    throw new PropertyError('INVALID_REQUEST', { field: 'effective_to' });
  const limits = await findPropertyLimits(em, context.tenantId, propertyId);
  if (!limits) throw new PropertyError('NOT_FOUND');
  const leaves = await resolveLeaves(
    em,
    context.tenantId,
    propertyId,
    input.resourceIds,
    limits.max_leaves_per_product,
  );
  const currentLeaves = await leafViews(
    em,
    context.tenantId,
    propertyId,
    version.id,
  );
  const proposedSet = new Set(leaves.map((leaf) => leaf.resource_id));
  const removed = currentLeaves.filter(
    (leaf) => !proposedSet.has(leaf.resource_id),
  );
  const others = await listActiveCompositionVersionsForProduct(
    em,
    context.tenantId,
    propertyId,
    version.product_id,
    version.id,
  );
  assertNoWindowOverlap(others, {
    from: input.effectiveFrom,
    to: effectiveTo,
  });
  const impact = await impactOf(em, context, propertyId, {
    productId: version.product_id,
    leaves,
    removed,
    effectiveFrom: input.effectiveFrom,
    effectiveTo,
  });
  const fingerprint = fingerprintOf({
    kind: 'composition_change',
    inventory_version: now.inventoryVersion,
    composition_id: version.id,
    product_id: version.product_id,
    current: {
      version_number: version.version_number,
      effective_from: version.effective_from,
      effective_to: version.effective_to,
      status: version.status,
      version: version.version,
      leaf_ids: currentLeaves.map((leaf) => leaf.resource_id).sort(),
    },
    proposed: {
      effective_from: input.effectiveFrom,
      effective_to: effectiveTo,
      leaf_ids: [...input.resourceIds].sort(),
    },
    effect: effectSnapshot(impact),
  });
  return {
    verdict: impact.conflicts.length > 0 ? 'BLOCKED' : 'SAFE',
    fingerprint,
    product_id: product.id,
    product_code: product.code,
    composition_id: version.id,
    current: { composition: version, leaves: currentLeaves },
    proposed: {
      effective_from: input.effectiveFrom,
      effective_to: effectiveTo,
      leaves,
    },
    conflicts: impact.conflicts,
    retained_commitments: impact.retained,
    removed_leaves: removed,
    intersecting_blocks: impact.blocks,
  };
}

export async function previewCompositionChange(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  compositionId: string,
  input: CompositionChangeInput,
): Promise<CompositionChangeImpact> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return planCompositionChange(
        em,
        context,
        propertyId,
        compositionId,
        input,
        {
          today: businessToday(property.timezone),
          inventoryVersion: property.inventory_version,
        },
      );
    },
  );
}

export async function applyCompositionChange(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  compositionId: string,
  input: CompositionChangeInput & { previewFingerprint: string },
): Promise<CompositionChangeResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: OP_CHANGE,
    composition_id: compositionId,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    resource_ids: [...input.resourceIds].sort(),
    preview_fingerprint: input.previewFingerprint,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'composition.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const replayed = await checkIdempotency(
        em,
        context,
        OP_CHANGE,
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed as unknown as CompositionChangeResult;
      const plan = await planCompositionChange(
        em,
        context,
        propertyId,
        compositionId,
        input,
        {
          today: businessToday(property.timezone),
          inventoryVersion: property.inventory_version,
        },
      );
      if (plan.verdict === 'BLOCKED')
        throw new PropertyError('COMPOSITION_CHANGE_CONFLICT', {
          conflicts: plan.conflicts,
        });
      if (input.previewFingerprint !== plan.fingerprint)
        throw new PropertyError('PREVIEW_STALE', {
          expected: plan.fingerprint,
        });
      const current = plan.current.composition;
      const retired = input.effectiveFrom === current.effective_from;
      const superseded = retired
        ? await retireActiveCompositionVersion(em, {
            tenantId: context.tenantId,
            propertyId,
            versionId: current.id,
          })
        : await closeActiveCompositionVersion(em, {
            tenantId: context.tenantId,
            propertyId,
            versionId: current.id,
            effectiveTo: previousDay(input.effectiveFrom),
          });
      if (!superseded)
        throw new PropertyError('COMPOSITION_WINDOW_CONFLICT', {
          composition_id: current.id,
        });
      const versionNumber = await nextCompositionVersionNumber(
        em,
        context.tenantId,
        propertyId,
        current.product_id,
      );
      const inserted = await insertCompositionVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        productId: current.product_id,
        versionNumber,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: plan.proposed.effective_to,
      });
      await writeVersionLeaves(
        em,
        context,
        propertyId,
        inserted,
        plan.proposed.leaves.map((leaf) => leaf.resource_id),
      );
      const activated = await activateCompositionVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        versionId: inserted.id,
        version: inserted.version,
      });
      if (!activated) throw new PropertyError('STALE_VERSION');
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'composition.superseded',
        resourceType: 'CompositionVersion',
        resourceId: activated.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          composition_id: current.id,
          version_number: current.version_number,
          effective_from: current.effective_from,
          effective_to: current.effective_to,
          status: current.status,
          leaf_ids: plan.current.leaves.map((leaf) => leaf.resource_id).sort(),
        },
        afterSafe: {
          composition_id: activated.id,
          version_number: activated.version_number,
          effective_from: activated.effective_from,
          effective_to: activated.effective_to,
          status: activated.status,
          retired,
          superseded_effective_to: superseded.effective_to,
          leaf_ids: plan.proposed.leaves.map((leaf) => leaf.resource_id).sort(),
        },
        correlationId: context.correlationId,
      });
      const response: CompositionChangeResult = {
        composition: activated,
        superseded,
        fingerprint: plan.fingerprint,
        replayed: false,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: OP_CHANGE,
        key,
        requestHash,
        response: response as unknown as Record<string, unknown>,
        resourceId: activated.id,
      });
      return response;
    },
  );
}

async function planMigration(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  input: MigrationInput,
  now: { today: string; inventoryVersion: number },
): Promise<MigrationPreview> {
  const product = await resolveProduct(
    em,
    context.tenantId,
    propertyId,
    input.productId,
  );
  assertIsoDate(input.effectiveFrom, 'effective_from');
  assertNotBackdated(input.effectiveFrom, now.today);
  if (input.effectiveTo !== null)
    assertIsoDate(input.effectiveTo, 'effective_to');
  if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom)
    throw new PropertyError('INVALID_REQUEST', { field: 'effective_to' });
  const limits = await findPropertyLimits(em, context.tenantId, propertyId);
  if (!limits) throw new PropertyError('NOT_FOUND');
  const leaves = await resolveLeaves(
    em,
    context.tenantId,
    propertyId,
    input.resourceIds,
    limits.max_leaves_per_product,
  );
  const windows = await listActiveCompositionVersionsForProduct(
    em,
    context.tenantId,
    propertyId,
    product.id,
    null,
  );
  assertNoWindowOverlap(windows, {
    from: input.effectiveFrom,
    to: input.effectiveTo,
  });
  const impact = await impactOf(em, context, propertyId, {
    productId: product.id,
    leaves,
    removed: [],
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  });
  const before = await readMigrationCounts(
    em,
    context.tenantId,
    propertyId,
    product.id,
  );
  const after: MigrationCounts = {
    ...before,
    active_compositions: before.active_compositions + 1,
    product_active_versions: before.product_active_versions + 1,
  };
  const fingerprint = fingerprintOf({
    kind: 'setup_migration',
    inventory_version: now.inventoryVersion,
    product_id: product.id,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    leaf_ids: [...input.resourceIds].sort(),
    before,
    effect: effectSnapshot(impact),
  });
  return {
    verdict: impact.conflicts.length > 0 ? 'BLOCKED' : 'SAFE',
    fingerprint,
    product_id: product.id,
    product_code: product.code,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    leaves,
    conflicts: impact.conflicts,
    intersecting_blocks: impact.blocks,
    before,
    after,
  };
}

export async function previewSetupMigration(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: MigrationInput,
): Promise<MigrationPreview> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return planMigration(em, context, propertyId, input, {
        today: businessToday(property.timezone),
        inventoryVersion: property.inventory_version,
      });
    },
  );
}

export async function applySetupMigration(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: MigrationInput & { previewFingerprint: string },
): Promise<MigrationResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: OP_MIGRATION,
    product_id: input.productId,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    resource_ids: [...input.resourceIds].sort(),
    preview_fingerprint: input.previewFingerprint,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'composition.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const replayed = await checkIdempotency(
        em,
        context,
        OP_MIGRATION,
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed as unknown as MigrationResult;
      const plan = await planMigration(em, context, propertyId, input, {
        today: businessToday(property.timezone),
        inventoryVersion: property.inventory_version,
      });
      if (plan.verdict === 'BLOCKED')
        throw new PropertyError('COMPOSITION_CHANGE_CONFLICT', {
          conflicts: plan.conflicts,
        });
      if (input.previewFingerprint !== plan.fingerprint)
        throw new PropertyError('PREVIEW_STALE', {
          expected: plan.fingerprint,
        });
      const resourceIdsBefore = (
        await listResourceIds(em, context.tenantId, propertyId)
      ).sort();
      const versionNumber = await nextCompositionVersionNumber(
        em,
        context.tenantId,
        propertyId,
        plan.product_id,
      );
      const inserted = await insertCompositionVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        productId: plan.product_id,
        versionNumber,
        effectiveFrom: plan.effective_from,
        effectiveTo: plan.effective_to,
      });
      await writeVersionLeaves(
        em,
        context,
        propertyId,
        inserted,
        plan.leaves.map((leaf) => leaf.resource_id),
      );
      const activated = await activateCompositionVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        versionId: inserted.id,
        version: inserted.version,
      });
      if (!activated) throw new PropertyError('STALE_VERSION');
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const after = await readMigrationCounts(
        em,
        context.tenantId,
        propertyId,
        plan.product_id,
      );
      const resourceIdsAfter = (
        await listResourceIds(em, context.tenantId, propertyId)
      ).sort();
      const leafRows = await listCompositionLeaves(em, activated.id);
      const expectedLeaves = plan.leaves.map((leaf) => leaf.resource_id).sort();
      const writtenLeaves = leafRows.map((leaf) => leaf.resource_id).sort();
      const preservation =
        plan.before.resources === after.resources &&
        plan.before.future_commitments === after.future_commitments &&
        resourceIdsBefore.length === resourceIdsAfter.length &&
        resourceIdsBefore.every(
          (id, index) => id === resourceIdsAfter[index],
        ) &&
        expectedLeaves.length === writtenLeaves.length &&
        expectedLeaves.every((id, index) => id === writtenLeaves[index]);
      const reconciliation: MigrationReconciliation = {
        before: plan.before,
        after,
        resource_ids_preserved: preservation,
        resource_ids: plan.leaves.map((leaf) => leaf.resource_id),
      };
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'setup_migration.applied',
        resourceType: 'CompositionVersion',
        resourceId: activated.id,
        outcome: 'SUCCESS',
        afterSafe: {
          product_id: plan.product_id,
          version_number: activated.version_number,
          effective_from: activated.effective_from,
          effective_to: activated.effective_to,
          leaf_count: plan.leaves.length,
          resource_ids_preserved: reconciliation.resource_ids_preserved,
          before: plan.before,
          after,
        },
        correlationId: context.correlationId,
      });
      const response: MigrationResult = {
        composition: activated,
        reconciliation,
        fingerprint: plan.fingerprint,
        replayed: false,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: OP_MIGRATION,
        key,
        requestHash,
        response: response as unknown as Record<string, unknown>,
        resourceId: activated.id,
      });
      return response;
    },
  );
}
