import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from './idempotency-service.js';
import { importReservations } from './import-service.js';
import type { ImportInput } from './import-service.js';

export async function importReservationsIdempotent(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ImportInput,
  idempotencyKey: string | null | undefined,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ImportReservations',
    property_id: propertyId,
    mode: input.mode,
    source: input.source,
    file_name: input.file_name,
    content_type: input.content_type,
    content: input.content,
    external_id: input.external_id ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'reservation.create', propertyId);
      await em.execute(
        `select pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
        [context.tenantId, `ImportReservations:${key}`],
      );
      const replayed = await checkIdempotency(
        em,
        context,
        'ImportReservations',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const response = await importReservations(
        orm,
        context,
        propertyId,
        input,
      );
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ImportReservations',
        key,
        requestHash,
        response,
        resourceId:
          typeof response.run_id === 'string' ? response.run_id : null,
      });
      return response;
    },
  );
}
