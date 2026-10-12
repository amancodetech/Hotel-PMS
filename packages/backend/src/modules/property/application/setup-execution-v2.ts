import { setupBatchChunks } from '../domain/setup-batch-plan.js';
import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from '../../../persistence/sql.js';
import {
  buildSetupPlanV2,
  type SetupPlanReference,
} from '../domain/setup-plan-v2.js';
import type { SetupDraftInputV2 } from '../domain/setup-v2.js';
import { setupV2HashInput } from '../domain/setup-v2.js';
import { setupReadinessIssues, type SetupIssue } from '../domain/setup.js';
import { PropertyError } from '../domain/errors.js';
import type {
  PropertySetupDraftRow,
  ResourceRow,
} from '../persistence/types.js';
import {
  insertLocation,
  findLocation,
} from '../persistence/location-repository.js';
import {
  insertResource,
  findResource,
  findResourceByCode,
  listParentResourceIds,
} from '../persistence/resource-repository.js';
import {
  insertProduct,
  insertProductCandidate,
  updateProduct,
} from '../persistence/product-repository.js';
import {
  insertCompositionVersion,
  insertCompositionEdge,
  insertCompositionLeaf,
  activateCompositionVersion,
  findPropertyLimits,
} from '../persistence/composition-repository.js';
import {
  readSetupLimits,
  countPropertyResources,
  markSetupDraftCompleted,
  listSetupConflicts,
} from '../persistence/setup-repository.js';
import {
  bumpPropertyInventoryVersion,
  updatePropertyCoreFromSetup,
} from '../persistence/property-repository.js';
import { assertActiveLocation } from './location-tree-service.js';
import { authorize, auditActor, type ServiceContext } from './context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { storeIdempotency } from '../../reservations/application/idempotency-service.js';
import {
  insertRatePlan,
  insertPolicyVersion,
  upsertNightlyPrice,
} from '../../inventory/persistence/rate-repository.js';
import {
  findOperationsPolicy,
  insertOperationsPolicy,
  updateOperationsPolicy,
} from '../../operations/persistence/operations-repository.js';
import type {
  SetupApplyResult,
  SetupIfMatch,
  SetupPreviewResult,
} from './setup-service.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readinessV2(input: SetupDraftInputV2): SetupIssue[] {
  const common = setupReadinessIssues({ ...input, unit_groups: [] }).filter(
    (issue) => issue.code !== 'units_required',
  );
  for (const [index, g] of input.unit_groups.entries()) {
    if (
      ['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE', 'CONNECTED_UNITS'].includes(
        g.booking_mode ?? '',
      ) &&
      !g.effective_to
    )
      common.push({
        code: 'period_required',
        step: 'UNITS',
        field: `unit_groups.${index}.effective_to`,
        message: 'Composition end date is required',
      });
  }
  return [
    ...common,
    ...buildSetupPlanV2(input).blockers.map((issue) => ({
      code: issue.code,
      field: issue.field_path,
      step: 'UNITS' as const,
      group_index: input.unit_groups.findIndex(
        (g) => g.group_ref === issue.group_ref,
      ),
      message: issue.code,
    })),
  ];
}

/** Caller holds the property lock. Snapshot includes all mutable inputs to planning.
 * Hash rows inside PostgreSQL so guest or financial data never leave the database.
 */
async function stateFingerprint(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
) {
  // Limits profiles are read-only to the runtime role; no new UPDATE grant
  // is introduced merely to lock them. Property profile selection is locked.
  const parts: unknown[] = [];
  for (const table of [
    'location',
    'resource',
    'product',
    'plan_allocation',
    'inventory_block',
    'inventory_block_resource',
    'exposure_allocation',
    'composition_version',
    'composition_leaf',
    'property_operations_policy',
  ]) {
    parts.push(
      await one(
        em,
        `select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as hash from "${table}" t where tenant_id = ? and property_id = ?`,
        [context.tenantId, propertyId],
      ),
    );
  }
  parts.push(
    await one(
      em,
      'select to_jsonb(p) as value from property p where tenant_id = ? and id = ?',
      [context.tenantId, propertyId],
    ),
  );
  parts.push(await findPropertyLimits(em, context.tenantId, propertyId));
  return digest(parts);
}

async function assertNoInventoryTransformation(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  plan: ReturnType<typeof buildSetupPlanV2>,
): Promise<void> {
  const roots = plan.resources.filter(
    (resource) =>
      resource.parentCode === null &&
      ['VILLA', 'APARTMENT', 'HOUSE'].includes(resource.kind),
  );
  const matches = [];
  for (const root of roots) {
    const existing = await findResourceByCode(
      em,
      context.tenantId,
      propertyId,
      root.code,
    );
    if (existing?.resource_type === root.kind) matches.push({ root, existing });
  }
  const parents = await listParentResourceIds(
    em,
    context.tenantId,
    propertyId,
    matches.map(({ existing }) => existing.id),
  );
  for (const { root, existing } of matches) {
    const requestedParts = plan.resources.some(
      (resource) => resource.parentCode === root.code,
    );
    if (parents.has(existing.id) !== requestedParts)
      throw new PropertyError('INVENTORY_TRANSFORMATION_REQUIRED', {
        resource_id: existing.id,
        code: existing.code,
      });
  }
}

export async function previewV2(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  draft: Pick<PropertySetupDraftRow, 'id' | 'revision' | 'completed'>,
  input: SetupDraftInputV2,
  options: { addition?: boolean } = {},
): Promise<SetupPreviewResult> {
  const state = await stateFingerprint(em, context, propertyId);
  const plan = buildSetupPlanV2(input);
  if (options.addition)
    await assertNoInventoryTransformation(em, context, propertyId, plan);
  const limits = await readSetupLimits(em, context.tenantId, propertyId);
  if (!limits) throw new PropertyError('NOT_FOUND');
  const count = await countPropertyResources(em, context.tenantId, propertyId);
  const blockers = readinessV2(input);
  // Apply consumes this same preview, so known execution limits must also
  // be visible before the user confirms the plan.
  const compositionLimits = await findPropertyLimits(
    em,
    context.tenantId,
    propertyId,
  );
  if (!compositionLimits) throw new PropertyError('NOT_FOUND');
  const limitIssue = (field: string, message: string) =>
    blockers.push({
      code: 'LIMIT_EXCEEDED',
      step: field.startsWith('pricing.') ? 'PRICING' : 'UNITS',
      field,
      message,
    });
  if (
    plan.products.some(
      (p) => p.leaves.length > compositionLimits.max_leaves_per_product,
    )
  )
    limitIssue('unit_groups', 'Composition leaf limit exceeded');
  if (
    input.pricing &&
    !input.pricing.postponed &&
    input.pricing.sell_from &&
    input.pricing.sell_to
  ) {
    const nights =
      (Date.parse(input.pricing.sell_to) -
        Date.parse(input.pricing.sell_from)) /
      86400000;
    if (nights < 1 || nights > limits.horizon_nights)
      limitIssue('pricing.sell_to', 'Pricing horizon exceeded');
  }
  const locationsByRef = new Map(input.locations.map((l) => [l.client_ref, l]));
  for (const location of input.locations) {
    let depth = 1;
    let parent = location.parent_ref;
    while (parent && depth <= 32) {
      depth++;
      parent = locationsByRef.get(parent)?.parent_ref;
    }
    if (depth > 32) {
      limitIssue('locations', 'Location depth exceeds 32');
      break;
    }
  }
  const capacity = Math.max(0, limits.max_resources - count);
  const writes =
    plan.counts.resources +
    plan.counts.products +
    plan.counts.leaves +
    input.locations.filter((l) => !l.existing_location_id).length;
  if (writes > limits.max_setup_units_inline)
    blockers.push({
      code: 'SETUP_BATCH_TASK_REQUIRED',
      step: 'UNITS',
      message: 'Inline write budget exceeded',
    });
  if (plan.counts.resources > capacity)
    blockers.push({
      code: 'LIMIT_EXCEEDED',
      step: 'UNITS',
      message: 'Resource capacity exceeded',
    });
  await validateReferences(em, context, propertyId, input);
  return {
    batch_plan:
      writes > limits.max_setup_units_inline &&
      blockers.every((b) => b.code === 'SETUP_BATCH_TASK_REQUIRED')
        ? (() => {
            const chunks = setupBatchChunks(
              input,
              limits.max_setup_units_inline,
            );
            return chunks ? { total_batches: chunks.length } : null;
          })()
        : null,
    preview_version: digest({
      scope: [context.tenantId, propertyId],
      draft: [draft.id, Number(draft.revision)],
      input: setupV2HashInput(input),
      state,
    }),
    draft_revision: Number(draft.revision),
    inventory_version: Number(limits.inventory_version),
    generated: {
      total_units: plan.counts.resources,
      codes_preview: plan.resources.slice(0, 50).map((r) => r.code),
      excluded_codes: input.unit_groups.flatMap((g) => g.exclusions ?? []),
      by_template: input.unit_groups.map((g) => {
        const resources = plan.resources.filter(
          (r) => r.groupRef === g.group_ref,
        );
        return {
          template_code: g.physical_template,
          parts: resources.filter(
            (r) => r.parentCode !== null && r.kind === 'ROOM',
          ).length,
          compositions: plan.products.filter(
            (p) => p.groupRef === g.group_ref && p.leaves.length > 0,
          ).length,
          units: resources.length,
          rooms: resources.filter((r) => r.kind === 'ROOM' && r.sellable)
            .length,
          beds: resources.filter((r) => r.kind === 'BED').length,
          sites: resources.filter((r) => r.kind === 'SITE').length,
        };
      }),
    },
    limits: {
      max_units_inline: Number(limits.max_setup_units_inline),
      resource_capacity_remaining: capacity,
    },
    blockers,
    warnings: [],
  };
}

async function validateReferences(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  input: SetupDraftInputV2,
) {
  for (const location of input.locations) {
    if (!location.existing_location_id) continue;
    await assertActiveLocation(
      em,
      context.tenantId,
      propertyId,
      location.existing_location_id,
    );
    const row = await findLocation(
      em,
      context.tenantId,
      propertyId,
      location.existing_location_id,
    );
    const expectedParent =
      input.locations.find((l) => l.client_ref === location.parent_ref)
        ?.existing_location_id ?? null;
    if (
      !row ||
      row.code !== location.code ||
      row.name !== location.name ||
      row.kind !== location.kind ||
      row.display_order !== location.display_order ||
      row.parent_id !== expectedParent
    )
      throw new PropertyError('CONFLICT', {
        reason: 'existing_location_edit_requires_patch',
      });
  }
  for (const group of input.unit_groups) {
    const ids = group.connected_resource_ids ?? [];
    for (const id of ids) {
      const row = await findResource(em, context.tenantId, propertyId, id);
      if (!row) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (row.state !== 'ACTIVE' || row.maintenance_state !== 'NONE')
        throw new PropertyError('RESOURCE_UNAVAILABLE');
    }
    if (
      (await listParentResourceIds(em, context.tenantId, propertyId, ids)).size
    )
      throw new PropertyError('RESOURCE_HAS_CHILDREN');
    if (ids.length && group.effective_from && group.effective_to) {
      const end = new Date(`${group.effective_to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const conflicts = await listSetupConflicts(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds: ids,
        arrival: group.effective_from,
        departure: end.toISOString().slice(0, 10),
      });
      if (conflicts.length) throw new PropertyError('RESOURCE_UNAVAILABLE');
    }
  }
}

/** Uses the outer ApplySetupDraft transaction; never opens a nested transaction. */
export async function applyV2(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  draft: Pick<PropertySetupDraftRow, 'id' | 'revision' | 'completed'>,
  input: SetupDraftInputV2,
  previewVersion: string,
  options: {
    ifMatch: SetupIfMatch | null;
    key: string;
    requestHash: string;
    addition?: boolean;
    deferCompletion?: boolean;
  },
): Promise<{ result: SetupApplyResult; replayed: boolean }> {
  if (
    !options.ifMatch ||
    options.ifMatch.draftId !== draft.id ||
    options.ifMatch.revision !== Number(draft.revision)
  )
    throw new PropertyError('SETUP_DRAFT_STALE');
  if (draft.completed)
    throw new PropertyError('CONFLICT', { reason: 'draft_completed' });
  const expected = digest({
    scope: [context.tenantId, propertyId],
    draft: [draft.id, Number(draft.revision)],
    input: setupV2HashInput(input),
    state: await stateFingerprint(em, context, propertyId),
  });
  if (previewVersion !== expected) throw new PropertyError('PREVIEW_STALE');
  const preview = await previewV2(em, context, propertyId, draft, input, {
    addition: options.addition,
  });
  if (previewVersion !== preview.preview_version)
    throw new PropertyError('PREVIEW_STALE');
  if (preview.blockers.length) {
    const limit = preview.blockers.find(
      (b) =>
        b.code === 'SETUP_BATCH_TASK_REQUIRED' || b.code === 'LIMIT_EXCEEDED',
    );
    if (limit)
      throw new PropertyError(
        limit.code as 'SETUP_BATCH_TASK_REQUIRED' | 'LIMIT_EXCEEDED',
      );
    throw new PropertyError('SETUP_READINESS_BLOCKED', {
      issues: preview.blockers,
    });
  }
  const plan = buildSetupPlanV2(input);
  const limits = (await readSetupLimits(em, context.tenantId, propertyId))!;
  const compositionLimits = (await findPropertyLimits(
    em,
    context.tenantId,
    propertyId,
  ))!;
  for (const p of plan.products) {
    if (p.leaves.length > compositionLimits.max_leaves_per_product)
      throw new PropertyError('LIMIT_EXCEEDED');
    if (p.leaves.length && !p.effectiveTo)
      throw new PropertyError('SETUP_READINESS_BLOCKED', {
        reason: 'effective_to_required',
      });
  }
  const scope = { tenantId: context.tenantId, propertyId };
  const locations = new Map<string, string>();
  const pending = [...input.locations];
  while (pending.length) {
    const index = pending.findIndex(
      (l) => !l.parent_ref || locations.has(l.parent_ref),
    );
    if (index < 0) throw new PropertyError('INVALID_REQUEST');
    const location = pending.splice(index, 1)[0]!;
    const row = location.existing_location_id
      ? { id: location.existing_location_id }
      : await insertLocation(em, {
          ...scope,
          code: location.code,
          name: location.name,
          kind: location.kind,
          display_order: location.display_order,
          parent_id: location.parent_ref
            ? locations.get(location.parent_ref)!
            : null,
        });
    locations.set(location.client_ref, row.id);
  }
  const resources = new Map<string, ResourceRow>();
  for (const r of plan.resources) {
    const row = await insertResource(em, {
      ...scope,
      code: r.code,
      resourceType: r.kind,
      capacity: r.capacity,
      locationId: r.locationRef ? locations.get(r.locationRef)! : null,
      parentResourceId: r.parentCode ? resources.get(r.parentCode)!.id : null,
      display_label: r.displayLabel,
      unit_details: r.details,
    });
    resources.set(r.code, row);
  }
  const resolve = async (ref: SetupPlanReference) => {
    const row =
      'code' in ref
        ? resources.get(ref.code)
        : await findResource(
            em,
            context.tenantId,
            propertyId,
            ref.existingResourceId,
          );
    if (!row) throw new PropertyError('CROSS_SCOPE_REFERENCE');
    return row;
  };
  const productIds: string[] = [];
  for (const p of plan.products) {
    const code = `PSR-${digest([draft.id, p.key]).slice(0, 32)}`;
    const references = p.leaves.length ? p.leaves : p.candidates;
    const resolvedNames: string[] = [];
    for (const reference of references) {
      const resource = await resolve(reference);
      resolvedNames.push(
        resource.display_label && resource.display_label !== resource.code
          ? `${resource.display_label} (${resource.code})`
          : resource.code,
      );
    }
    const unitCode = p.key.slice(p.groupRef.length + 1).split(':')[0]!;
    const container = resources.get(unitCode);
    const productName = container
      ? container.display_label && container.display_label !== container.code
        ? `${container.display_label} (${container.code})`
        : container.code
      : resolvedNames.join(p.leaves.length ? ' + ' : ' / ');
    const product = await insertProduct(em, {
      ...scope,
      code,
      name: productName.slice(0, 120),
      kind: p.kind,
      adultsMin: 1,
      adultsMax: p.capacity,
      childrenMax: 0,
      mealPlan: 'NONE',
      sharingScope: p.sharingScope,
    });
    productIds.push(product.id);
    for (const ref of p.candidates) {
      const r = await resolve(ref);
      await insertProductCandidate(em, {
        ...scope,
        productId: product.id,
        resourceId: r.id,
        resourceType: r.resource_type,
      });
    }
    if (p.leaves.length) {
      const version = await insertCompositionVersion(em, {
        ...scope,
        productId: product.id,
        versionNumber: 1,
        effectiveFrom: p.effectiveFrom!,
        effectiveTo: p.effectiveTo!,
      });
      for (const [position, ref] of p.leaves.entries()) {
        const r = await resolve(ref);
        await insertCompositionEdge(em, {
          ...scope,
          versionId: version.id,
          position,
          childKind: 'RESOURCE',
          resourceId: r.id,
          childVersionId: null,
        });
        await insertCompositionLeaf(em, {
          ...scope,
          versionId: version.id,
          resourceId: r.id,
          depth: 1,
        });
      }
      if (
        !(await activateCompositionVersion(em, {
          ...scope,
          versionId: version.id,
          version: version.version,
        }))
      )
        throw new PropertyError('STALE_VERSION');
    }
    if (
      !(await updateProduct(em, {
        ...scope,
        productId: product.id,
        version: product.version,
        status: 'ACTIVE',
      }))
    )
      throw new PropertyError('STALE_VERSION');
  }
  if (!options.addition && !options.deferCompletion)
    await updatePropertyCoreFromSetup(em, {
      ...scope,
      name: input.property.name!.trim(),
      timezone: input.property.timezone!,
      baseCurrency: input.property.base_currency!,
    });
  let createdRatePlan: string | null = null;
  if (input.pricing && !input.pricing.postponed) {
    const pricing = input.pricing;
    const nights =
      (Date.parse(pricing.sell_to!) - Date.parse(pricing.sell_from!)) /
      86400000;
    if (nights < 1 || nights > limits.horizon_nights)
      throw new PropertyError('LIMIT_EXCEEDED');
    for (const [i, productId] of productIds.entries()) {
      const rate = await insertRatePlan(em, {
        ...scope,
        productId,
        code: `PSR-${productId}`,
        name: `${pricing.plan_name!} ${i + 1}`,
        currency: input.property.base_currency!,
        occupancyBasis: 1,
        mealPlan: 'NONE',
        inclusions: [],
        cancellationPolicy: {},
        freePolicy: false,
      });
      const policy = await insertPolicyVersion(em, {
        ...scope,
        ratePlanId: rate.id,
        versionNumber: 1,
        occupancyBasis: 1,
        mealPlan: 'NONE',
        inclusions: [],
        cancellationPolicy: {},
        freePolicy: false,
      });
      for (let day = 0; day < nights; day++) {
        const stayDate = new Date(
          Date.parse(pricing.sell_from!) + day * 86400000,
        )
          .toISOString()
          .slice(0, 10);
        await upsertNightlyPrice(em, {
          ...scope,
          ratePlanId: rate.id,
          policyVersionId: policy.id,
          stayDate,
          occupancy: 1,
          amount: pricing.base_price!,
          currency: input.property.base_currency!,
        });
      }
      createdRatePlan ??= rate.id;
    }
  }
  if (
    !options.addition &&
    !options.deferCompletion &&
    typeof input.operations.inspection_required === 'boolean'
  ) {
    const policy = await findOperationsPolicy(em, context.tenantId, propertyId);
    if (policy) {
      if (
        !(await updateOperationsPolicy(em, {
          ...scope,
          version: policy.version,
          inspectionRequired: input.operations.inspection_required,
          longStayCleanIntervalDays: policy.long_stay_clean_interval_days,
        }))
      )
        throw new PropertyError('STALE_VERSION');
    } else
      await insertOperationsPolicy(em, {
        ...scope,
        inspectionRequired: input.operations.inspection_required,
        longStayCleanIntervalDays: null,
      });
  }
  await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
  if (!options.addition && !options.deferCompletion)
    await markSetupDraftCompleted(em, context.tenantId, propertyId, true);
  const followUpTasks = options.addition ? [] : ['operations_policy_follow_up'];
  if (!input.pricing || input.pricing.postponed)
    followUpTasks.push('rate_plan_follow_up');
  if (input.unit_groups.some((g) => g.guaranteed_specs?.length))
    followUpTasks.push('unit_setup_specs_follow_up');
  const result: SetupApplyResult = {
    property_id: propertyId,
    created_units: plan.counts.resources,
    created_products: plan.counts.products,
    created_compositions: plan.counts.compositions,
    created_rate_plan: createdRatePlan,
    inventory_version: preview.inventory_version + 1,
    applied_at: new Date().toISOString(),
    follow_up_tasks: followUpTasks,
  };
  await storeIdempotency(em, context, {
    propertyId,
    operation: options.addition ? 'ApplySetupUnitAddition' : 'ApplySetupDraft',
    key: options.key,
    requestHash: options.requestHash,
    response: { result },
    resourceId: options.addition ? propertyId : draft.id,
  });
  await recordAudit(em, {
    ...scope,
    ...auditActor(context),
    action: options.addition ? 'setup_units.added' : 'setup_draft.applied',
    resourceType: options.addition ? 'Property' : 'PropertySetupDraft',
    resourceId: options.addition ? propertyId : draft.id,
    outcome: 'SUCCESS',
    correlationId: context.correlationId,
    afterSafe: { schema_version: 2, ...plan.counts },
  });
  return { result, replayed: false };
}

export async function authorizeV2Apply(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  input: SetupDraftInputV2,
) {
  await authorize(em, context, 'property.manage', propertyId);
  if (typeof input.operations.inspection_required === 'boolean')
    await authorize(em, context, 'task.manage', propertyId);
  if (
    input.unit_groups.some((g) =>
      ['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE', 'CONNECTED_UNITS'].includes(
        g.booking_mode ?? '',
      ),
    )
  )
    await authorize(em, context, 'composition.manage', propertyId);
  if (input.pricing && !input.pricing.postponed)
    await authorize(em, context, 'rate.manage', propertyId);
}
