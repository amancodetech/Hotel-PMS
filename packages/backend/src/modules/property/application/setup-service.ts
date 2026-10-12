import { assertNoSetupBatch } from '../persistence/setup-batch-repository.js';
import {
  previewV2,
  applyV2,
  authorizeV2Apply,
  readinessV2,
} from './setup-execution-v2.js';
import { assertActiveLocation } from './location-tree-service.js';
import {
  isSetupV2,
  setupV2HashInput,
  parseSetupV2,
  requireLegacySetup,
  type VersionedSetupInput,
} from '../domain/setup-v2.js';
import { findLocation } from '../persistence/location-repository.js';
import { createHash } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { PropertyError } from '../domain/errors.js';
import {
  assertPropertyConfigurable,
  isResourceKind,
} from '../domain/lifecycle.js';
import type { ResourceKind } from '../domain/lifecycle.js';
import {
  SETUP_TEMPLATES,
  expandAllSetupUnits,
  expandSetupGroup,
  normalizeSetupDraftInput,
  setupPreviewWarnings,
  setupReadinessIssues,
  setupTemplateFor,
  validateSetupDraftInput,
} from '../domain/setup.js';
import type {
  SetupDraftInput,
  SetupIssue,
  SetupTemplate,
} from '../domain/setup.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  bumpPropertyInventoryVersion,
  findPropertyView,
  lockProperty,
  updatePropertyCoreFromSetup,
} from '../persistence/property-repository.js';
import {
  insertPolicyVersion,
  insertRatePlan,
  upsertNightlyPrice,
} from '../../inventory/persistence/rate-repository.js';
import {
  findOperationsPolicy,
  insertOperationsPolicy,
  updateOperationsPolicy,
} from '../../operations/persistence/operations-repository.js';
import {
  findResource,
  findResourceByCode,
  insertResource,
  listChildResources,
  listDescendantResources,
  listParentResourceIds,
} from '../persistence/resource-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import {
  findProduct,
  findProductBySetupUnitCode,
  insertProduct,
  insertProductCandidate,
  updateProduct,
} from '../persistence/product-repository.js';
import {
  activateCompositionVersion,
  findPropertyLimits,
  insertCompositionEdge,
  insertCompositionLeaf,
  insertCompositionVersion,
  listActiveCompositionLeafResources,
  listActiveCompositionSiblings,
} from '../persistence/composition-repository.js';
import {
  countPropertyResources,
  deleteSetupDraft,
  findLocationByCode,
  findSetupDraft,
  insertSetupDraft,
  listExistingProductCodes,
  listExistingResourceCodes,
  listAvailableResourceCodes,
  listResourcesByCodes,
  markSetupDraftCompleted,
  readSetupLimits,
  updateSetupDraft,
  listSetupConflicts,
} from '../persistence/setup-repository.js';
import type {
  PropertySetupDraftRow,
  ResourceRow,
} from '../persistence/types.js';

export interface SetupDraftView {
  draft_id: string;
  property_id: string;
  revision: number;
  updated_at: string;
  updated_by_user_id: string | null;
  completed: boolean;
  input: VersionedSetupInput;
}

export interface SetupDraftSaveResult {
  draft: SetupDraftView;
  replayed: boolean;
}

export function setupDraftView(row: PropertySetupDraftRow): SetupDraftView {
  return {
    draft_id: row.id,
    property_id: row.property_id,
    revision: Number(row.revision),
    updated_at: row.updated_at,
    updated_by_user_id: row.updated_by_user_id,
    completed: row.completed,
    input: row.input,
  };
}

export interface SetupIfMatch {
  draftId: string;
  revision: number;
}

export function parseSetupIfMatch(
  value: string | undefined,
): SetupIfMatch | null {
  if (value === undefined) return null;
  const trimmed = value.trim().replace(/^"|"$/g, '');
  if (trimmed === '') return null;
  const match = /^([0-9a-fA-F-]{36}):([0-9]+)$/.exec(trimmed);
  if (!match)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'if-match',
      reason: 'format',
    });
  return { draftId: match[1]!, revision: Number(match[2]) };
}

export async function listSetupTemplates(
  orm: MikroORM,
  context: ServiceContext,
): Promise<readonly SetupTemplate[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', null);
      return SETUP_TEMPLATES;
    },
  );
}

export async function readSetupDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<SetupDraftView | null> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      assertPropertyConfigurable(property.status);
      const row = await findSetupDraft(em, context.tenantId, propertyId);
      return row ? setupDraftView(row) : null;
    },
  );
}

function assertInput(input: SetupDraftInput): SetupDraftInput {
  const issues: SetupIssue[] = validateSetupDraftInput(input);
  if (issues.length > 0)
    throw new PropertyError('SETUP_DRAFT_INVALID', { issues });
  return input;
}

export async function saveSetupDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: VersionedSetupInput,
  options: {
    idempotencyKey: string | null | undefined;
    ifMatch: SetupIfMatch | null;
  },
): Promise<SetupDraftSaveResult> {
  const key = requireIdempotencyKey(options.idempotencyKey);
  const normalized = isSetupV2(input)
    ? parseSetupV2(input)
    : normalizeSetupDraftInput(assertInput(input));
  const requestHash = hashRequest({
    operation: 'SaveSetupDraft',
    property_id: propertyId,
    if_match: options.ifMatch,
    input: isSetupV2(normalized) ? setupV2HashInput(normalized) : normalized,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      await assertNoSetupBatch(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      if (isSetupV2(normalized) && property.status !== 'SETUP')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'v2_setup_only',
        });
      const currentDraft = await findSetupDraft(
        em,
        context.tenantId,
        propertyId,
      );
      if (currentDraft?.completed)
        throw new PropertyError('CONFLICT', { reason: 'draft_completed' });
      if (
        currentDraft &&
        isSetupV2(currentDraft.input) &&
        !isSetupV2(normalized)
      )
        throw new PropertyError('CONFLICT', { reason: 'schema_downgrade' });
      if (isSetupV2(normalized)) {
        for (const location of normalized.locations) {
          if (
            location.existing_location_id &&
            !(await findLocation(
              em,
              context.tenantId,
              propertyId,
              location.existing_location_id,
            ))
          )
            throw new PropertyError('CROSS_SCOPE_REFERENCE');
        }
        for (const group of normalized.unit_groups) {
          for (const id of group.connected_resource_ids ?? []) {
            if (!(await findResource(em, context.tenantId, propertyId, id)))
              throw new PropertyError('CROSS_SCOPE_REFERENCE');
          }
        }
      }
      const replayed = await checkIdempotency(
        em,
        context,
        'SaveSetupDraft',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) {
        const current = await findSetupDraft(em, context.tenantId, propertyId);
        const draft = replayed.draft as SetupDraftView;
        if (!current)
          throw new PropertyError('CONFLICT', { reason: 'draft_discarded' });
        if (current.id !== draft.draft_id)
          throw new PropertyError('CONFLICT', {
            reason: 'draft_generation_changed',
          });
        return { draft, replayed: true };
      }
      const existing = await findSetupDraft(em, context.tenantId, propertyId);
      let row: PropertySetupDraftRow;
      if (existing) {
        if (
          options.ifMatch === null ||
          options.ifMatch.draftId !== existing.id ||
          options.ifMatch.revision !== Number(existing.revision)
        )
          throw new PropertyError('SETUP_DRAFT_STALE', {
            current_revision: Number(existing.revision),
            reason:
              options.ifMatch === null
                ? 'if_match_required'
                : options.ifMatch.draftId !== existing.id
                  ? 'generation_mismatch'
                  : 'revision_mismatch',
            current_etag: `${existing.id}:${Number(existing.revision)}`,
          });
        const updated = await updateSetupDraft(em, {
          tenantId: context.tenantId,
          propertyId,
          revision: Number(existing.revision),
          draft: normalized,
          updatedByUserId: context.actor.userId,
        });
        if (!updated)
          throw new PropertyError('SETUP_DRAFT_STALE', {
            current_revision: Number(existing.revision),
            reason: 'concurrent_update',
          });
        row = updated;
      } else {
        if (options.ifMatch !== null)
          throw new PropertyError('SETUP_DRAFT_STALE', {
            current_revision: null,
            reason: 'draft_missing',
          });
        row = await insertSetupDraft(em, {
          tenantId: context.tenantId,
          propertyId,
          draft: normalized,
          updatedByUserId: context.actor.userId,
        });
      }
      const draft = setupDraftView(row);
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'SaveSetupDraft',
        key,
        requestHash,
        response: { draft },
        resourceId: row.id,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'setup_draft.saved',
        resourceType: 'PropertySetupDraft',
        resourceId: row.id,
        outcome: 'SUCCESS',
        correlationId: context.correlationId,
        afterSafe: {
          revision: draft.revision,
          completed: draft.completed,
          groups: draft.input.unit_groups?.length ?? 0,
        },
      });
      return { draft, replayed: false };
    },
  );
}

export async function discardSetupDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  options: { ifMatch: SetupIfMatch | null },
): Promise<{ removed: boolean; replayed: false }> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      await assertNoSetupBatch(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const existing = await findSetupDraft(em, context.tenantId, propertyId);
      if (existing) {
        if (
          options.ifMatch === null ||
          options.ifMatch.draftId !== existing.id ||
          options.ifMatch.revision !== Number(existing.revision)
        )
          throw new PropertyError('SETUP_DRAFT_STALE', {
            current_revision: Number(existing.revision),
            reason:
              options.ifMatch === null
                ? 'if_match_required'
                : options.ifMatch.draftId !== existing.id
                  ? 'generation_mismatch'
                  : 'revision_mismatch',
            current_etag: `${existing.id}:${Number(existing.revision)}`,
          });
      }
      if (existing?.completed)
        throw new PropertyError('CONFLICT', { reason: 'draft_completed' });
      const removed = await deleteSetupDraft(em, context.tenantId, propertyId);
      if (removed)
        await recordAudit(em, {
          tenantId: context.tenantId,
          propertyId,
          ...auditActor(context),
          action: 'setup_draft.discarded',
          resourceType: 'PropertySetupDraft',
          resourceId: null,
          outcome: 'SUCCESS',
          correlationId: context.correlationId,
        });
      return { removed, replayed: false };
    },
  );
}

export interface SetupPreviewResult {
  batch_plan?: { total_batches: number } | null;
  preview_version: string;
  draft_revision: number;
  inventory_version: number;
  generated: {
    total_units: number;
    by_template: Array<{
      template_code: string;
      units: number;
      rooms: number;
      beds: number;
      sites: number;
    }>;
    codes_preview: string[];
    excluded_codes: string[];
  };
  limits: {
    max_units_inline: number;
    resource_capacity_remaining: number;
  };
  blockers: SetupIssue[];
  warnings: SetupIssue[];
}

export interface SetupApplyResult {
  property_id: string;
  created_units: number;
  created_products: number;
  created_compositions: number;
  created_rate_plan: string | null;
  inventory_version: number;
  applied_at: string;
  follow_up_tasks: string[];
}

function previewDigest(
  draftId: string,
  revision: number,
  input: SetupDraftInput,
  inventoryVersion: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        draft_id: draftId,
        revision,
        input,
        inventory_version: inventoryVersion,
      }),
    )
    .digest('hex');
}

export async function previewSetupDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<SetupPreviewResult> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      assertPropertyConfigurable(property.status);
      const draft = await findSetupDraft(em, context.tenantId, propertyId);
      if (!draft) throw new PropertyError('SETUP_DRAFT_MISSING');
      if (isSetupV2(draft.input)) {
        await lockProperty(em, context.tenantId, propertyId);
        const current = (await findSetupDraft(
          em,
          context.tenantId,
          propertyId,
        ))!;
        if (!current || !isSetupV2(current.input))
          throw new PropertyError('SETUP_DRAFT_STALE');
        return previewV2(em, context, propertyId, current, current.input);
      }
      requireLegacySetup(draft.input);
      const limits = await readSetupLimits(em, context.tenantId, propertyId);
      const resourceCount = await countPropertyResources(
        em,
        context.tenantId,
        propertyId,
      );
      const expanded = expandAllSetupUnits(draft.input);
      const inventoryVersion = Number(
        limits?.inventory_version ?? property.inventory_version,
      );
      return {
        preview_version: previewDigest(
          draft.id,
          Number(draft.revision),
          draft.input,
          inventoryVersion,
        ),
        draft_revision: Number(draft.revision),
        inventory_version: inventoryVersion,
        generated: {
          total_units: expanded.totalUnits,
          by_template: expanded.byTemplate.map((entry) => ({
            template_code: entry.templateCode,
            units: entry.units,
            rooms: entry.rooms,
            beds: entry.beds,
            sites: entry.sites,
            parts: entry.parts,
            compositions: entry.compositions,
          })),
          codes_preview: expanded.codes.slice(0, 50),
          excluded_codes: expanded.excluded,
        },
        limits: {
          max_units_inline: Number(limits?.max_setup_units_inline ?? 20),
          resource_capacity_remaining: Math.max(
            0,
            Number(limits?.max_resources ?? 0) - resourceCount,
          ),
        },
        blockers: setupReadinessIssues(draft.input),
        warnings: setupPreviewWarnings(draft.input),
      };
    },
  );
}

export async function applySetupDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  previewVersion: string,
  options: {
    idempotencyKey: string | null | undefined;
    ifMatch: SetupIfMatch | null;
  },
): Promise<{ result: SetupApplyResult; replayed: boolean }> {
  const key = requireIdempotencyKey(options.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ApplySetupDraft',
    property_id: propertyId,
    preview_version: previewVersion,
    if_match: options.ifMatch,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      await assertNoSetupBatch(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      if (property.status !== 'SETUP')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: property.status,
          to: 'APPLY',
        });
      const currentDraft = await findSetupDraft(
        em,
        context.tenantId,
        propertyId,
      );
      if (currentDraft && isSetupV2(currentDraft.input))
        await authorizeV2Apply(em, context, propertyId, currentDraft.input);
      const replayed = await checkIdempotency(
        em,
        context,
        'ApplySetupDraft',
        key,
        requestHash,
        propertyId,
      );
      if (replayed)
        return {
          result: replayed.result as SetupApplyResult,
          replayed: true,
        };
      const draft = await findSetupDraft(em, context.tenantId, propertyId);
      if (!draft) throw new PropertyError('SETUP_DRAFT_MISSING');
      if (isSetupV2(draft.input))
        return translatePropertyWrite(() =>
          applyV2(
            em,
            context,
            propertyId,
            draft,
            draft.input as import('../domain/setup-v2.js').SetupDraftInputV2,
            previewVersion,
            { ifMatch: options.ifMatch, key, requestHash },
          ),
        );
      requireLegacySetup(draft.input);
      if (
        options.ifMatch === null ||
        options.ifMatch.draftId !== draft.id ||
        options.ifMatch.revision !== Number(draft.revision)
      )
        throw new PropertyError('SETUP_DRAFT_STALE', {
          current_revision: Number(draft.revision),
          reason:
            options.ifMatch === null
              ? 'if_match_required'
              : options.ifMatch.draftId !== draft.id
                ? 'generation_mismatch'
                : 'revision_mismatch',
          current_etag: `${draft.id}:${Number(draft.revision)}`,
        });
      if (draft.completed)
        throw new PropertyError('CONFLICT', { reason: 'draft_completed' });
      const input = draft.input;
      const issues = setupReadinessIssues(input);
      const unsupported = issues.filter(
        (entry) => entry.code === 'mode_not_supported',
      );
      const blocking = issues.filter(
        (entry) => entry.code !== 'mode_not_supported',
      );
      if (blocking.length > 0)
        throw new PropertyError('SETUP_READINESS_BLOCKED', {
          issues: blocking,
        });
      if (unsupported.length > 0)
        throw new PropertyError('SETUP_MODE_UNSUPPORTED', {
          issues: unsupported,
        });
      const limits = await readSetupLimits(em, context.tenantId, propertyId);
      if (!limits) throw new PropertyError('NOT_FOUND');
      const inventoryVersion = Number(limits.inventory_version);
      const expectedPreview = previewDigest(
        draft.id,
        Number(draft.revision),
        input,
        inventoryVersion,
      );
      if (previewVersion !== expectedPreview)
        throw new PropertyError('PREVIEW_STALE', {
          current_revision: Number(draft.revision),
          current_preview_version: expectedPreview,
        });
      const expanded = expandAllSetupUnits(input);
      const plannedWrites = expanded.totalUnits + expanded.totalCompositions;
      if (plannedWrites > limits.max_setup_units_inline)
        throw new PropertyError('SETUP_BATCH_TASK_REQUIRED', {
          total_units: plannedWrites,
          max_units_inline: limits.max_setup_units_inline,
        });
      const existingResources = await countPropertyResources(
        em,
        context.tenantId,
        propertyId,
      );
      if (existingResources + expanded.totalUnits > limits.max_resources)
        throw new PropertyError('LIMIT_EXCEEDED', {
          reason: 'max_resources',
          max_resources: limits.max_resources,
          current_resources: existingResources,
        });
      const existingCodes = await listExistingResourceCodes(
        em,
        context.tenantId,
        propertyId,
        expanded.codes,
      );
      if (existingCodes.length > 0)
        throw new PropertyError('CONFLICT', {
          reason: 'setup_codes_exist',
          codes: existingCodes,
        });
      const compositionLimits = await findPropertyLimits(
        em,
        context.tenantId,
        propertyId,
      );
      if (!compositionLimits) throw new PropertyError('NOT_FOUND');

      const locationByGroup = new Map<number, string | null>();
      const connectedByGroup = new Map<number, ResourceRow[]>();
      for (const [index, group] of input.unit_groups.entries()) {
        let locationId: string | null = null;
        if (group.location_code) {
          const location = await findLocationByCode(
            em,
            context.tenantId,
            propertyId,
            group.location_code,
          );
          if (!location)
            throw new PropertyError('CROSS_SCOPE_REFERENCE', {
              field: 'location_code',
              code: group.location_code,
            });
          await assertActiveLocation(
            em,
            context.tenantId,
            propertyId,
            location.id,
          );
          locationId = location.id;
        }
        locationByGroup.set(index, locationId);
        if (group.template_code !== 'SUITE') continue;
        const codes = [
          ...new Set((group.connected_codes ?? []).map((code) => code.trim())),
        ];
        const found = await listResourcesByCodes(
          em,
          context.tenantId,
          propertyId,
          codes,
        );
        const byCode = new Map(found.map((row) => [row.code, row]));
        const missing = codes.filter((code) => !byCode.has(code));
        if (missing.length > 0)
          throw new PropertyError('CROSS_SCOPE_REFERENCE', {
            field: 'connected_codes',
            codes: missing,
          });
        if (found.some((row) => row.state === 'RETIRED'))
          throw new PropertyError('RESOURCE_RETIRED');
        const parents = await listParentResourceIds(
          em,
          context.tenantId,
          propertyId,
          found.map((row) => row.id),
        );
        if (parents.size > 0)
          throw new PropertyError('RESOURCE_HAS_CHILDREN', {
            resource_ids: [...parents],
          });
        connectedByGroup.set(index, found);
      }

      const resourcesByCode = new Map<
        string,
        { id: string; code: string; resourceType: ResourceKind }
      >();
      let createdUnits = 0;
      for (const [index, group] of input.unit_groups.entries()) {
        const template = setupTemplateFor(group.template_code);
        if (!template) throw new PropertyError('INVALID_REQUEST');
        const locationId = locationByGroup.get(index) ?? null;
        const groupCapacity = group.capacity ?? template.defaultCapacity ?? 2;
        const codes = expandSetupGroup(group).codes;
        const insertUnit = async (
          code: string,
          resourceType: ResourceKind,
          capacity: number,
          parentResourceId: string | null = null,
        ) => {
          const resource = await insertResource(em, {
            tenantId: context.tenantId,
            propertyId,
            code,
            resourceType,
            capacity,
            locationId,
            parentResourceId,
          });
          resourcesByCode.set(code, {
            id: resource.id,
            code: resource.code,
            resourceType: resource.resource_type,
          });
          createdUnits += 1;
          return resource;
        };
        if (
          (group.template_code === 'VILLA' ||
            group.template_code === 'APARTMENT') &&
          group.rental_mode === 'WHOLE_OR_PARTS'
        ) {
          const parts = group.parts ?? [];
          for (const code of codes)
            for (const part of parts)
              await insertUnit(
                `${code}-${part.label}`,
                'ROOM',
                part.capacity ?? groupCapacity,
              );
          continue;
        }
        if (group.template_code === 'DORM' && group.rental_mode === 'BEDS') {
          const beds = group.beds_per_unit ?? 0;
          for (const code of codes) {
            const parent = await insertUnit(code, 'ROOM', beds);
            for (let position = 1; position <= beds; position += 1)
              await insertUnit(`${code}-B${position}`, 'BED', 1, parent.id);
          }
          continue;
        }
        if (group.template_code === 'SUITE') continue;
        if (!isResourceKind(template.resourceType))
          throw new PropertyError('SETUP_MODE_UNSUPPORTED', {
            reason: 'template_not_implemented',
          });
        for (const code of codes)
          await insertUnit(code, template.resourceType, groupCapacity);
      }

      interface PlannedProduct {
        code: string;
        name: string;
        kind: ResourceKind;
        adultsMax: number;
        sharingScope: 'MIXED' | 'FEMALE' | 'MALE' | null;
        setupUnitCode?: string | null;
        candidates: Array<{ id: string; resourceType: ResourceKind }>;
        leaves: Array<{ id: string; code: string }>;
      }
      const plannedProducts: PlannedProduct[] = [];
      for (const [index, group] of input.unit_groups.entries()) {
        const template = setupTemplateFor(group.template_code);
        if (!template) throw new PropertyError('INVALID_REQUEST');
        const groupCapacity = group.capacity ?? template.defaultCapacity ?? 2;
        const codes = expandSetupGroup(group).codes;
        if (
          (group.template_code === 'VILLA' ||
            group.template_code === 'APARTMENT') &&
          group.rental_mode === 'WHOLE_OR_PARTS'
        ) {
          const parts = group.parts ?? [];
          for (const code of codes) {
            const partResources = parts.map((part) =>
              resourcesByCode.get(`${code}-${part.label}`)!,
            );
            plannedProducts.push({
              code: `SETUP-${group.template_code}-${code}`.slice(0, 80),
              name: `Setup ${group.template_code} ${code}`,
              kind: template.resourceType,
              adultsMax: groupCapacity,
              sharingScope: null,
              setupUnitCode: code,
              candidates: [],
              leaves: partResources,
            });
            parts.forEach((part, partIndex) => {
              const resource = partResources[partIndex]!;
              plannedProducts.push({
                code: `SETUP-${group.template_code}-${code}-${part.label}`.slice(
                  0,
                  80,
                ),
                name: `Setup ${group.template_code} ${code} ${part.label}`,
                kind: 'ROOM',
                adultsMax: part.capacity ?? groupCapacity,
                sharingScope: null,
                candidates: [resource],
                leaves: [],
              });
            });
          }
          continue;
        }
        if (group.template_code === 'DORM' && group.rental_mode === 'BEDS') {
          const beds = group.beds_per_unit ?? 0;
          const first = codes[0] ?? `G${index + 1}`;
          const sharingScope = group.sharing_scope ?? null;
          const allBeds = codes.flatMap((code) =>
            Array.from({ length: beds }, (_, position) =>
              resourcesByCode.get(`${code}-B${position + 1}`)!,
            ),
          );
          plannedProducts.push({
            code: `SETUP-BED-${first}`.slice(0, 80),
            name: `Setup BED ${first}`,
            kind: 'BED',
            adultsMax: 1,
            sharingScope,
            candidates: allBeds,
            leaves: [],
          });
          for (const code of codes) {
            const bedResources = Array.from({ length: beds }, (_, position) =>
              resourcesByCode.get(`${code}-B${position + 1}`)!,
            );
            plannedProducts.push({
              code: `SETUP-DORM-${code}`.slice(0, 80),
              name: `Setup DORM ${code}`,
              kind: 'ROOM',
              adultsMax: beds,
              sharingScope,
              setupUnitCode: code,
              candidates: [],
              leaves: bedResources,
            });
          }
          continue;
        }
        if (group.template_code === 'SUITE') {
          const connected = (connectedByGroup.get(index) ?? []).map((row) => ({
            id: row.id,
            code: row.code,
          }));
          for (const code of codes)
            plannedProducts.push({
              code: `SETUP-SUITE-${code}`.slice(0, 80),
              name: `Setup SUITE ${code}`,
              kind: 'ROOM',
              adultsMax: groupCapacity,
              sharingScope: null,
              setupUnitCode: code,
              candidates: [],
              leaves: connected,
            });
          continue;
        }
        const first = codes[0] ?? `G${index + 1}`;
        plannedProducts.push({
          code: `SETUP-${group.template_code}-${first}`.slice(0, 80),
          name: `Setup ${group.template_code} ${index + 1}`,
          kind: template.resourceType,
          adultsMax: groupCapacity,
          sharingScope:
            group.rental_mode === 'BEDS' ? (group.sharing_scope ?? null) : null,
          candidates: codes.map((code) => resourcesByCode.get(code)!),
          leaves: [],
        });
      }
      for (const plan of plannedProducts) {
        if (plan.leaves.length > compositionLimits.max_leaves_per_product)
          throw new PropertyError('LIMIT_EXCEEDED', {
            reason: 'max_leaves_per_product',
            max_leaves_per_product: compositionLimits.max_leaves_per_product,
          });
      }
      const existingProducts = await listExistingProductCodes(
        em,
        context.tenantId,
        propertyId,
        plannedProducts.map((plan) => plan.code),
      );
      if (existingProducts.length > 0)
        throw new PropertyError('CONFLICT', {
          reason: 'setup_product_codes_exist',
          codes: existingProducts,
        });
      await updatePropertyCoreFromSetup(em, {
        tenantId: context.tenantId,
        propertyId,
        name: input.property.name!.trim(),
        timezone: input.property.timezone!,
        baseCurrency: input.property.base_currency!,
      });
      const effectiveFrom = new Date().toISOString().slice(0, 10);
      const horizonDate = new Date();
      horizonDate.setUTCDate(horizonDate.getUTCDate() + limits.horizon_nights);
      const effectiveTo = horizonDate.toISOString().slice(0, 10);
      let createdProducts = 0;
      let createdCompositions = 0;
      const productIds: string[] = [];
      for (const plan of plannedProducts) {
        const product = await insertProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          code: plan.code,
          name: plan.name,
          kind: plan.kind,
          adultsMin: 1,
          adultsMax: plan.adultsMax,
          childrenMax: 0,
          mealPlan: 'NONE',
          sharingScope: plan.sharingScope,
          setupUnitCode: plan.setupUnitCode ?? null,
        });
        productIds.push(product.id);
        createdProducts += 1;
        for (const candidate of plan.candidates)
          await insertProductCandidate(em, {
            tenantId: context.tenantId,
            propertyId,
            productId: product.id,
            resourceId: candidate.id,
            resourceType: candidate.resourceType,
          });
        if (plan.leaves.length > 0) {
          const version = await translatePropertyWrite(() =>
            insertCompositionVersion(em, {
              tenantId: context.tenantId,
              propertyId,
              productId: product.id,
              versionNumber: 1,
              effectiveFrom,
              effectiveTo,
            }),
          );
          let position = 0;
          for (const leaf of plan.leaves) {
            await insertCompositionEdge(em, {
              versionId: version.id,
              tenantId: context.tenantId,
              propertyId,
              position,
              childKind: 'RESOURCE',
              resourceId: leaf.id,
              childVersionId: null,
            });
            position += 1;
          }
          for (const leaf of plan.leaves)
            await insertCompositionLeaf(em, {
              versionId: version.id,
              tenantId: context.tenantId,
              propertyId,
              resourceId: leaf.id,
              depth: 1,
            });
          const activated = await activateCompositionVersion(em, {
            tenantId: context.tenantId,
            propertyId,
            versionId: version.id,
            version: version.version,
          });
          if (!activated) throw new PropertyError('STALE_VERSION');
          createdCompositions += 1;
        }
        const activatedProduct = await updateProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          productId: product.id,
          version: product.version,
          status: 'ACTIVE',
        });
        if (!activatedProduct)
          throw new PropertyError('CONFLICT', {
            reason: 'setup_product_activation',
          });
      }
      let createdRatePlan: string | null = null;
      if (input.pricing && !input.pricing.postponed) {
        await authorize(em, context, 'rate.manage', propertyId);
        const planName = input.pricing.plan_name!.trim();
        const sellFrom = input.pricing.sell_from!;
        const sellTo = input.pricing.sell_to!;
        const nights = Math.round(
          (Date.parse(`${sellTo}T00:00:00Z`) -
            Date.parse(`${sellFrom}T00:00:00Z`)) /
            86_400_000,
        );
        if (nights < 1 || nights > limits.horizon_nights)
          throw new PropertyError('LIMIT_EXCEEDED', {
            reason: 'horizon_nights',
            horizon_nights: limits.horizon_nights,
          });
        for (const [index, productId] of productIds.entries()) {
          const plan = await translatePropertyWrite(() =>
            insertRatePlan(em, {
              tenantId: context.tenantId,
              propertyId,
              productId,
              code: `SETUP-${plannedProducts[index]!.code}`.slice(0, 80),
              name:
                plannedProducts.length > 1
                  ? `${planName} ${index + 1}`
                  : planName,
              currency: input.property.base_currency!,
              occupancyBasis: 1,
              mealPlan: 'NONE',
              inclusions: [],
              cancellationPolicy: {},
              freePolicy: false,
            }),
          );
          const policy = await insertPolicyVersion(em, {
            tenantId: context.tenantId,
            propertyId,
            ratePlanId: plan.id,
            versionNumber: 1,
            occupancyBasis: 1,
            mealPlan: 'NONE',
            inclusions: [],
            cancellationPolicy: {},
            freePolicy: false,
          });
          let stayDate = sellFrom;
          while (stayDate < sellTo) {
            await upsertNightlyPrice(em, {
              tenantId: context.tenantId,
              propertyId,
              ratePlanId: plan.id,
              policyVersionId: policy.id,
              stayDate,
              occupancy: 1,
              amount: input.pricing.base_price!,
              currency: input.property.base_currency!,
            });
            const next = new Date(`${stayDate}T00:00:00Z`);
            next.setUTCDate(next.getUTCDate() + 1);
            stayDate = next.toISOString().slice(0, 10);
          }
          if (createdRatePlan === null) createdRatePlan = plan.id;
        }
      }
      if (
        input.operations &&
        typeof input.operations.inspection_required === 'boolean'
      ) {
        const policy = await findOperationsPolicy(
          em,
          context.tenantId,
          propertyId,
        );
        if (policy)
          await updateOperationsPolicy(em, {
            tenantId: context.tenantId,
            propertyId,
            version: policy.version,
            inspectionRequired: input.operations.inspection_required,
            longStayCleanIntervalDays: policy.long_stay_clean_interval_days,
          });
        else
          await insertOperationsPolicy(em, {
            tenantId: context.tenantId,
            propertyId,
            inspectionRequired: input.operations.inspection_required,
            longStayCleanIntervalDays: null,
          });
      }
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const completed = await markSetupDraftCompleted(
        em,
        context.tenantId,
        propertyId,
        true,
      );
      const followUpTasks: string[] = [];
      if (!input.pricing || input.pricing.postponed)
        followUpTasks.push('rate_plan_follow_up');
      if (input.operations?.check_in || input.operations?.check_out)
        followUpTasks.push('operations_policy_follow_up');
      if (
        input.unit_groups.some(
          (group) => (group.guaranteed_specs ?? []).length > 0,
        )
      )
        followUpTasks.push('unit_setup_specs_follow_up');
      const result: SetupApplyResult = {
        property_id: propertyId,
        created_units: createdUnits,
        created_products: createdProducts,
        created_compositions: createdCompositions,
        created_rate_plan: createdRatePlan,
        inventory_version: inventoryVersion + 1,
        applied_at: new Date().toISOString(),
        follow_up_tasks: followUpTasks,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ApplySetupDraft',
        key,
        requestHash,
        response: { result },
        resourceId: completed?.id ?? draft.id,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'setup_draft.applied',
        resourceType: 'PropertySetupDraft',
        resourceId: draft.id,
        outcome: 'SUCCESS',
        correlationId: context.correlationId,
        afterSafe: {
          revision: Number(draft.revision),
          units: createdUnits,
          products: createdProducts,
          compositions: createdCompositions,
          rate_plan: createdRatePlan,
          follow_up: followUpTasks,
        },
      });
      return { result, replayed: false };
    },
  );
}

export interface SetupReadinessResult {
  ready: boolean;
  missing: SetupIssue[];
  checked_at: string;
  draft_revision: number | null;
}

export async function readSetupReadiness(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<SetupReadinessResult> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      assertPropertyConfigurable(property.status);
      const draft = await findSetupDraft(em, context.tenantId, propertyId);
      if (!draft) throw new PropertyError('SETUP_DRAFT_MISSING');
      const missing = isSetupV2(draft.input)
        ? readinessV2(draft.input)
        : setupReadinessIssues(draft.input);
      return {
        ready: missing.length === 0,
        missing,
        checked_at: new Date().toISOString(),
        draft_revision: Number(draft.revision),
      };
    },
  );
}

export type SetupSimulationScope = 'WHOLE' | 'PART' | 'BED';

export interface SetupSimulationBlocked {
  kind: 'UNIT' | 'PART' | 'BED' | 'ROOM' | 'WHOLE';
  code: string;
}

export interface SetupSimulationResult {
  scope: SetupSimulationScope;
  allowed: boolean;
  blocked: SetupSimulationBlocked[];
  available_after: string[];
  explanation: string;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function simulateSetupSale(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    scope: SetupSimulationScope;
    unitCode: string;
    from: string;
    to: string;
  },
): Promise<SetupSimulationResult> {
  if (!isoDatePattern.test(input.from) || !isoDatePattern.test(input.to))
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  if (input.to <= input.from)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  if (input.unitCode.trim() === '' || input.unitCode.length > 40)
    throw new PropertyError('INVALID_REQUEST', { field: 'unit_code' });
  const unitCode = input.unitCode.trim();
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      assertPropertyConfigurable(property.status);

      let targets: Array<{ id: string; code: string; resource_type: string }>;
      let blocked: SetupSimulationBlocked[];
      let availableCandidates: string[] = [];

      if (input.scope === 'BED') {
        const bed = await findResourceByCode(
          em,
          context.tenantId,
          propertyId,
          unitCode,
        );
        if (!bed || bed.resource_type !== 'BED')
          throw new PropertyError('INVALID_REQUEST', { field: 'unit_code' });
        if (!bed.parent_resource_id)
          throw new PropertyError('INVALID_REQUEST', { field: 'unit_code' });
        const parent = await findResource(
          em,
          context.tenantId,
          propertyId,
          bed.parent_resource_id,
        );
        if (!parent) throw new PropertyError('NOT_FOUND');
        targets = [
          {
            id: bed.id,
            code: bed.code,
            resource_type: bed.resource_type,
          },
        ];
        blocked = [{ kind: 'ROOM', code: parent.code }];
        const children = await listChildResources(
          em,
          context.tenantId,
          propertyId,
          parent.id,
        );
        availableCandidates = children
          .filter((row) => row.resource_type === 'BED' && row.code !== unitCode)
          .map((row) => row.id);
      } else if (input.scope === 'PART') {
        const part = await findResourceByCode(
          em,
          context.tenantId,
          propertyId,
          unitCode,
        );
        if (!part) throw new PropertyError('NOT_FOUND');
        if (part.resource_type !== 'ROOM')
          throw new PropertyError('INVALID_REQUEST', { field: 'unit_code' });
        const parents = await listParentResourceIds(
          em,
          context.tenantId,
          propertyId,
          [part.id],
        );
        if (parents.has(part.id))
          throw new PropertyError('RESOURCE_HAS_CHILDREN', {
            resource_id: part.id,
          });
        const siblings = await listActiveCompositionSiblings(
          em,
          context.tenantId,
          propertyId,
          part.id,
          input.from,
          input.to,
        );
        if (siblings.length === 0) throw new PropertyError('NOT_FOUND');
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          siblings[0]!.product_id,
        );
        targets = [
          {
            id: part.id,
            code: part.code,
            resource_type: part.resource_type,
          },
        ];
        blocked = [
          {
            kind: 'WHOLE',
            code: product?.setup_unit_code ?? product?.code ?? unitCode,
          },
        ];
        availableCandidates = siblings
          .filter((row) => row.resource_id !== part.id)
          .map((row) => row.resource_id);
      } else {
        const resource = await findResourceByCode(
          em,
          context.tenantId,
          propertyId,
          unitCode,
        );
        if (resource) {
          const descendants = (
            await listDescendantResources(em, context.tenantId, propertyId, [
              resource.id,
            ])
          ).filter((row) => row.id !== resource.id);
          if (descendants.length > 0) {
            targets = descendants.map((row) => ({
              id: row.id,
              code: row.code,
              resource_type: row.resource_type,
            }));
            blocked = descendants.map((row) => ({
              kind: row.resource_type === 'BED' ? 'BED' : 'ROOM',
              code: row.code,
            }));
          } else {
            targets = [
              {
                id: resource.id,
                code: resource.code,
                resource_type: resource.resource_type,
              },
            ];
            blocked = [{ kind: 'UNIT', code: resource.code }];
          }
        } else {
          const product = await findProductBySetupUnitCode(
            em,
            context.tenantId,
            propertyId,
            unitCode,
          );
          if (!product) throw new PropertyError('NOT_FOUND');
          const leaves = await listActiveCompositionLeafResources(
            em,
            context.tenantId,
            propertyId,
            product.id,
            input.from,
            input.to,
          );
          if (leaves.length === 0) throw new PropertyError('NOT_FOUND');
          targets = leaves;
          blocked = leaves.map((row) => ({
            kind:
              row.resource_type === 'BED'
                ? 'BED'
                : product.kind === 'VILLA' || product.kind === 'APARTMENT'
                  ? 'PART'
                  : 'ROOM',
            code: row.code,
          }));
        }
      }

      const conflicts = await listSetupConflicts(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds: targets.map((row) => row.id),
        arrival: input.from,
        departure: input.to,
      });
      if (conflicts.length > 0) {
        const byId = new Map(targets.map((row) => [row.id, row]));
        const kinds = [...new Set(conflicts.map((row) => row.kind))].sort();
        return {
          scope: input.scope,
          allowed: false,
          blocked: conflicts.map((row) => ({
            kind: 'UNIT' as const,
            code: byId.get(row.resource_id)?.code ?? row.resource_id,
          })),
          available_after: [],
          explanation: `Requested resources conflict with existing ${kinds.join(', ')} records in the period.`,
        };
      }
      const availableAfter = await listAvailableResourceCodes(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds: availableCandidates,
        arrival: input.from,
        departure: input.to,
      });
      return {
        scope: input.scope,
        allowed: true,
        blocked,
        available_after: availableAfter,
        explanation: `Selling ${input.scope} ${unitCode} keeps the listed resources blocked for the same period.`,
      };
    },
  );
}
