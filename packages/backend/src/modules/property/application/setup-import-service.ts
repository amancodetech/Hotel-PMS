import { locationAncestors } from './location-tree-service.js';
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
import {
  parseSetupUnitsCsv,
  setupImportRowResourceType,
} from '../domain/setup-import.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../persistence/property-repository.js';
import { insertResource } from '../persistence/resource-repository.js';
import {
  countPropertyResources,
  findLocationByCode,
  listExistingResourceCodes,
  readSetupLimits,
} from '../persistence/setup-repository.js';

export interface SetupUnitImportInput {
  mode: 'DRY_RUN' | 'APPLY';
  file_name: string;
  content: string;
}

export async function importSetupUnits(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: SetupUnitImportInput,
  idempotencyKey: string | null | undefined,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ImportSetupUnits',
    property_id: propertyId,
    mode: input.mode,
    file_name: input.file_name,
    content: input.content,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      await em.execute(
        `select pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
        [context.tenantId, `ImportSetupUnits:${key}`],
      );
      const replayed = await checkIdempotency(
        em,
        context,
        'ImportSetupUnits',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const parsed = parseSetupUnitsCsv(input.content);
      if (parsed.file_error)
        throw new PropertyError('SETUP_IMPORT_INVALID', {
          error: parsed.file_error,
        });
      const initial = parsed.rows.filter((row) => row.status === 'ACCEPTED');
      const locationCodes = [
        ...new Set(
          initial
            .map((row) => row.location_code)
            .filter((code): code is string => Boolean(code)),
        ),
      ];
      const locationIds = new Map<string, string>();
      const inactiveLocations = new Set<string>();
      for (const code of locationCodes) {
        const location = await findLocationByCode(
          em,
          context.tenantId,
          propertyId,
          code,
        );
        if (location) {
          const ancestors = await locationAncestors(
            em,
            context.tenantId,
            propertyId,
            location.id,
          );
          if (ancestors.some((l) => l.status !== 'ACTIVE'))
            inactiveLocations.add(code);
          else locationIds.set(code, location.id);
        }
      }
      for (const row of parsed.rows) {
        if (
          row.status === 'ACCEPTED' &&
          row.location_code &&
          !locationIds.has(row.location_code)
        ) {
          row.status = 'REJECTED';
          row.error_code = inactiveLocations.has(row.location_code)
            ? 'LOCATION_INACTIVE'
            : 'LOCATION_UNKNOWN';
        }
      }
      const accepted = parsed.rows.filter((row) => row.status === 'ACCEPTED');
      const rejected = parsed.rows.filter((row) => row.status !== 'ACCEPTED');
      const limits = await readSetupLimits(em, context.tenantId, propertyId);
      if (!limits) throw new PropertyError('NOT_FOUND');
      const existingCount = await countPropertyResources(
        em,
        context.tenantId,
        propertyId,
      );
      const existingCodes = await listExistingResourceCodes(
        em,
        context.tenantId,
        propertyId,
        accepted.map((row) => row.code!),
      );
      const preflight = {
        code_conflicts: existingCodes,
        inline_limit_exceeded: accepted.length > limits.max_setup_units_inline,
        resource_capacity_exceeded:
          existingCount + accepted.length > limits.max_resources,
      };
      let created = 0;
      if (input.mode === 'APPLY') {
        if (accepted.length === 0)
          throw new PropertyError('SETUP_IMPORT_INVALID', {
            error: 'NO_VALID_ROWS',
          });
        if (preflight.inline_limit_exceeded)
          throw new PropertyError('SETUP_BATCH_TASK_REQUIRED', {
            total_units: accepted.length,
            max_units_inline: limits.max_setup_units_inline,
          });
        if (preflight.resource_capacity_exceeded)
          throw new PropertyError('LIMIT_EXCEEDED', {
            reason: 'max_resources',
            max_resources: limits.max_resources,
            current_resources: existingCount,
          });
        if (existingCodes.length > 0)
          throw new PropertyError('CONFLICT', {
            reason: 'setup_codes_exist',
            codes: existingCodes,
          });
        for (const row of accepted) {
          const { resourceType, capacity } = setupImportRowResourceType(row);
          if (!isResourceKind(resourceType))
            throw new PropertyError('SETUP_IMPORT_INVALID', {
              error: 'TEMPLATE_UNKNOWN',
            });
          await insertResource(em, {
            tenantId: context.tenantId,
            propertyId,
            code: row.code!,
            resourceType,
            capacity,
            locationId: row.location_code
              ? (locationIds.get(row.location_code) ?? null)
              : null,
          });
          row.status = 'CREATED';
          created += 1;
        }
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        await recordAudit(em, {
          tenantId: context.tenantId,
          propertyId,
          ...auditActor(context),
          action: 'setup_units.imported',
          resourceType: 'Resource',
          resourceId: null,
          outcome: 'SUCCESS',
          correlationId: context.correlationId,
          afterSafe: {
            file_name: input.file_name,
            file_hash: parsed.file_hash,
            created,
          },
        });
      }
      const response = {
        mode: input.mode,
        file_name: input.file_name,
        file_hash: parsed.file_hash,
        applied: input.mode === 'APPLY',
        preflight,
        totals: {
          rows: parsed.rows.length,
          accepted: accepted.length,
          rejected: rejected.length,
          duplicates: rejected.filter(
            (row) => row.error_code === 'DUPLICATE_IN_FILE',
          ).length,
          created,
        },
        rows: parsed.rows,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ImportSetupUnits',
        key,
        requestHash,
        response,
        resourceId: null,
      });
      return response;
    },
  );
}
