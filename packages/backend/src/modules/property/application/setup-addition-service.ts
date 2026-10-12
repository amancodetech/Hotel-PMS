import { assertNoSetupBatch } from '../persistence/setup-batch-repository.js';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { authorize, type ServiceContext } from './context.js';
import { PropertyError } from '../domain/errors.js';
import {
  parseSetupV2,
  setupV2HashInput,
  type SetupDraftInputV2,
} from '../domain/setup-v2.js';
import { lockProperty } from '../persistence/property-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
} from '../../reservations/application/idempotency-service.js';
import { previewV2, applyV2 } from './setup-execution-v2.js';
import type { SetupApplyResult } from './setup-service.js';

export type SetupUnitAdditionInput = Pick<
  SetupDraftInputV2,
  'schema_version' | 'locations' | 'unit_groups'
>;
export function parseAddition(source: unknown): SetupDraftInputV2 {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (key) => !['schema_version', 'locations', 'unit_groups'].includes(key),
    )
  )
    throw new PropertyError('INVALID_REQUEST');
  return parseSetupV2({
    ...source,
    property: {
      name: 'Additional units',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['ROOM'],
    },
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      explicit_states: true,
    },
    pricing: { postponed: true },
  });
}

export async function setupUnitAddition(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  source: unknown,
  apply?: {
    previewVersion: string;
    ifMatch: string | undefined;
    idempotencyKey: string | undefined;
  },
) {
  const input = parseAddition(source);
  const normalized = setupV2HashInput(input);
  const requestHash = hashRequest({
    operation: 'ApplySetupUnitAddition',
    property_id: propertyId,
    input: {
      schema_version: 2,
      locations: normalized.locations,
      unit_groups: normalized.unit_groups,
    },
    preview_version: apply?.previewVersion,
    if_match: apply?.ifMatch,
  });
  const key = apply ? requireIdempotencyKey(apply.idempotencyKey) : null;
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(
        em,
        context,
        apply ? 'property.resource.manage' : 'property.read',
        propertyId,
      );
      if (
        apply &&
        input.unit_groups.some((group) =>
          ['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE', 'CONNECTED_UNITS'].includes(
            group.booking_mode ?? '',
          ),
        )
      )
        await authorize(em, context, 'composition.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      if (!['SETUP', 'ACTIVE'].includes(property.status))
        throw new PropertyError('INVALID_STATE_TRANSITION');
      if (apply) {
        const replay = await checkIdempotency(
          em,
          context,
          'ApplySetupUnitAddition',
          key!,
          requestHash,
          propertyId,
        );
        if (replay)
          return { result: replay.result as SetupApplyResult, replayed: true };
      }
      await assertNoSetupBatch(em, context.tenantId, propertyId);
      // These values come exclusively from the locked property, never from the caller.
      input.property = {
        ...input.property,
        name: property.name,
        timezone: property.timezone,
        base_currency: property.base_currency,
      };
      const version = {
        id: `addition:${propertyId}:${hashRequest({ locations: normalized.locations, unit_groups: normalized.unit_groups })}`,
        revision: Number(property.version),
        completed: false,
      };
      const etag = `"property:${propertyId}:${property.version}:${property.inventory_version}"`;
      if (!apply)
        return {
          ...(await previewV2(em, context, propertyId, version, input, {
            addition: true,
          })),
          property_etag: etag,
        };
      if (apply.ifMatch !== etag) throw new PropertyError('PREVIEW_STALE');
      return translatePropertyWrite(() =>
        applyV2(em, context, propertyId, version, input, apply.previewVersion, {
          ifMatch: { draftId: version.id, revision: version.revision },
          key: key!,
          requestHash,
          addition: true,
        }),
      );
    },
  );
}
