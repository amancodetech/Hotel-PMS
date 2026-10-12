import { randomUUID } from 'node:crypto';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { one } from '../../../persistence/sql.js';
import { authorize, type ServiceContext } from './context.js';
import { PropertyError } from '../domain/errors.js';
import { parseAddition } from './setup-addition-service.js';
import { isSetupV2, setupV2HashInput } from '../domain/setup-v2.js';
import { setupBatchChunks } from '../domain/setup-batch-plan.js';
import { buildSetupPlanV2 } from '../domain/setup-plan-v2.js';
import { lockProperty } from '../persistence/property-repository.js';
import {
  findLocationByCode,
  findSetupDraft,
  listExistingResourceCodes,
  readSetupLimits,
} from '../persistence/setup-repository.js';
import {
  assertNoSetupBatch,
  findSetupBatch,
  type SetupBatchRow,
} from '../persistence/setup-batch-repository.js';
import { applyV2, authorizeV2Apply, previewV2 } from './setup-execution-v2.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type { SetupApplyResult } from './setup-service.js';

async function authorizeBatch(
  em: EntityManager,
  c: ServiceContext,
  b: Pick<SetupBatchRow, 'mode' | 'input' | 'property_id'>,
) {
  await authorize(em, c, 'property.resource.manage', b.property_id);
  if (b.mode === 'DRAFT') await authorizeV2Apply(em, c, b.property_id, b.input);
  else if (
    b.input.unit_groups.some((g) =>
      ['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE', 'CONNECTED_UNITS'].includes(
        g.booking_mode ?? '',
      ),
    )
  )
    await authorize(em, c, 'composition.manage', b.property_id);
}
function aggregate(b: SetupBatchRow): SetupApplyResult | null {
  const last = b.results.at(-1);
  if (!last) return null;
  return {
    ...last,
    created_units: b.results.reduce((n, r) => n + r.created_units, 0),
    created_products: b.results.reduce((n, r) => n + r.created_products, 0),
    created_compositions: b.results.reduce(
      (n, r) => n + r.created_compositions,
      0,
    ),
    created_rate_plan:
      b.results.find((r) => r.created_rate_plan)?.created_rate_plan ?? null,
    follow_up_tasks: [...new Set(b.results.flatMap((r) => r.follow_up_tasks))],
  };
}
async function chunkInput(
  em: EntityManager,
  c: ServiceContext,
  b: SetupBatchRow,
) {
  const input = structuredClone(b.chunks[b.next_index]!);
  if (b.next_index > 0)
    for (const location of input.locations) {
      if (!location.existing_location_id) {
        const existing = await findLocationByCode(
          em,
          c.tenantId,
          b.property_id,
          location.code,
        );
        if (!existing) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        location.existing_location_id = existing.id;
      }
    }
  return input;
}
const identity = (b: SetupBatchRow) => ({
  id: b.id,
  revision: b.next_index + 1,
  completed: false,
});
async function view(em: EntityManager, c: ServiceContext, b: SetupBatchRow) {
  const preview = b.completed
    ? null
    : await previewV2(
        em,
        c,
        b.property_id,
        identity(b),
        await chunkInput(em, c, b),
        { addition: b.mode === 'ADDITION' },
      );
  return {
    id: b.id,
    mode: b.mode,
    completed: b.completed,
    completed_batches: b.next_index,
    total_batches: b.chunks.length,
    total_units: buildSetupPlanV2(b.input).counts.resources,
    created_units: b.results.reduce((n, r) => n + r.created_units, 0),
    preview_version: preview?.preview_version ?? null,
    blockers: preview?.blockers ?? [],
    result: aggregate(b),
  };
}
export async function readSetupBatch(
  orm: MikroORM,
  c: ServiceContext,
  propertyId: string,
  id?: string,
) {
  return runScopedTransaction(
    orm,
    { tenantId: c.tenantId, userId: c.actor.userId },
    async (em) => {
      await authorize(em, c, 'property.read', propertyId);
      await lockProperty(em, c.tenantId, propertyId);
      const batch = await findSetupBatch(em, c.tenantId, propertyId, id);
      if (id && !batch) throw new PropertyError('NOT_FOUND');
      return { batch: batch ? await view(em, c, batch) : null };
    },
  );
}
export async function startSetupBatch(
  orm: MikroORM,
  c: ServiceContext,
  propertyId: string,
  request: {
    mode: 'DRAFT' | 'ADDITION';
    input?: unknown;
    preview_version: string;
  },
  options: { idempotencyKey: string | undefined; ifMatch: string | undefined },
) {
  const key = requireIdempotencyKey(options.idempotencyKey);
  return runScopedTransaction(
    orm,
    { tenantId: c.tenantId, userId: c.actor.userId },
    async (em) => {
      await authorize(em, c, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, c.tenantId, propertyId);
      if (
        request.mode === 'DRAFT'
          ? property.status !== 'SETUP'
          : !['SETUP', 'ACTIVE'].includes(property.status)
      )
        throw new PropertyError('INVALID_STATE_TRANSITION');
      const draft =
        request.mode === 'DRAFT'
          ? await findSetupDraft(em, c.tenantId, propertyId)
          : null;
      if (request.mode === 'DRAFT' && (!draft || !isSetupV2(draft.input)))
        throw new PropertyError('INVALID_REQUEST');
      const input =
        request.mode === 'DRAFT'
          ? (structuredClone(draft!.input) as ReturnType<typeof parseAddition>)
          : parseAddition(request.input);
      if (request.mode === 'ADDITION')
        Object.assign(input.property, {
          name: property.name,
          timezone: property.timezone,
          base_currency: property.base_currency,
        });
      await authorizeBatch(em, c, {
        mode: request.mode,
        input,
        property_id: propertyId,
      });
      const requestHash = hashRequest({ request, if_match: options.ifMatch });
      const replay = await checkIdempotency(
        em,
        c,
        'StartSetupBatch',
        key,
        requestHash,
        propertyId,
      );
      if (replay) return replay;
      await assertNoSetupBatch(em, c.tenantId, propertyId);
      if (draft?.completed) throw new PropertyError('CONFLICT');
      const normalized = setupV2HashInput(input);
      const version = draft ?? {
        id: `addition:${propertyId}:${hashRequest({ locations: normalized.locations, unit_groups: normalized.unit_groups })}`,
        revision: Number(property.version),
        completed: false,
      };
      const etag = draft
        ? `"${draft.id}:${draft.revision}"`
        : `"property:${propertyId}:${property.version}:${property.inventory_version}"`;
      if (options.ifMatch !== etag) throw new PropertyError('PREVIEW_STALE');
      const preview = await previewV2(em, c, propertyId, version, input, {
        addition: request.mode === 'ADDITION',
      });
      if (preview.preview_version !== request.preview_version)
        throw new PropertyError('PREVIEW_STALE');
      if (preview.blockers.some((b) => b.code !== 'SETUP_BATCH_TASK_REQUIRED'))
        throw new PropertyError('SETUP_READINESS_BLOCKED');
      const limits = (await readSetupLimits(em, c.tenantId, propertyId))!;
      const chunks = setupBatchChunks(input, limits.max_setup_units_inline);
      if (!chunks) throw new PropertyError('SETUP_BATCH_TASK_REQUIRED');
      const conflicts = await listExistingResourceCodes(
        em,
        c.tenantId,
        propertyId,
        buildSetupPlanV2(input).resources.map((r) => r.code),
      );
      if (conflicts.length) throw new PropertyError('CONFLICT');
      const batch = await one<SetupBatchRow>(
        em,
        `insert into property_setup_batch(id,tenant_id,property_id,mode,draft_id,draft_revision,input,chunks) values(?,?,?,?,?,?,?::jsonb,?::jsonb) returning *`,
        [
          randomUUID(),
          c.tenantId,
          propertyId,
          request.mode,
          draft?.id ?? null,
          draft?.revision ?? null,
          JSON.stringify(input),
          JSON.stringify(chunks),
        ],
      );
      const response = { batch: await view(em, c, batch!), replayed: false };
      await storeIdempotency(em, c, {
        propertyId,
        operation: 'StartSetupBatch',
        key,
        requestHash,
        response,
        resourceId: batch!.id,
      });
      return response;
    },
  );
}
export async function advanceSetupBatch(
  orm: MikroORM,
  c: ServiceContext,
  propertyId: string,
  id: string,
  request: { index: number; preview_version: string },
  keyInput: string | undefined,
) {
  const key = requireIdempotencyKey(keyInput);
  return runScopedTransaction(
    orm,
    { tenantId: c.tenantId, userId: c.actor.userId },
    async (em) =>
      translatePropertyWrite(async () => {
        await authorize(em, c, 'property.resource.manage', propertyId);
        const property = await lockProperty(em, c.tenantId, propertyId);
        const b = await findSetupBatch(em, c.tenantId, propertyId, id);
        if (!b) throw new PropertyError('NOT_FOUND');
        await authorizeBatch(em, c, b);
        if (
          b.mode === 'DRAFT'
            ? property.status !== 'SETUP'
            : !['SETUP', 'ACTIVE'].includes(property.status)
        )
          throw new PropertyError('INVALID_STATE_TRANSITION');
        const requestHash = hashRequest({ id, ...request });
        const replay = await checkIdempotency(
          em,
          c,
          'AdvanceSetupBatch',
          key,
          requestHash,
          propertyId,
        );
        if (replay) return replay;
        if (b.completed || b.next_index !== request.index)
          throw new PropertyError('PREVIEW_STALE');
        if (b.mode === 'DRAFT') {
          const d = await findSetupDraft(em, c.tenantId, propertyId);
          if (
            !d ||
            d.id !== b.draft_id ||
            Number(d.revision) !== b.draft_revision ||
            d.completed
          )
            throw new PropertyError('SETUP_DRAFT_STALE');
        }
        const v = identity(b),
          input = await chunkInput(em, c, b);
        const result = await applyV2(
          em,
          c,
          propertyId,
          v,
          input,
          request.preview_version,
          {
            ifMatch: { draftId: v.id, revision: v.revision },
            key: `batch:${b.id}:${b.next_index}`,
            requestHash,
            addition: b.mode === 'ADDITION',
            deferCompletion: b.next_index + 1 < b.chunks.length,
          },
        );
        const updated = await one<SetupBatchRow>(
          em,
          `update property_setup_batch set results=results || ?::jsonb,next_index=next_index+1,completed=(next_index+1=jsonb_array_length(chunks)),updated_at=now() where tenant_id=? and property_id=? and id=? returning *`,
          [JSON.stringify([result.result]), c.tenantId, propertyId, id],
        );
        const response = {
          batch: await view(em, c, updated!),
          replayed: false,
        };
        await storeIdempotency(em, c, {
          propertyId,
          operation: 'AdvanceSetupBatch',
          key,
          requestHash,
          response,
          resourceId: id,
        });
        return response;
      }),
  );
}
