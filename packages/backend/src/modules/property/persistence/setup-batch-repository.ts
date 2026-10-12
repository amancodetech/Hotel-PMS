import type { EntityManager } from '@mikro-orm/postgresql';
import { one } from '../../../persistence/sql.js';
import { PropertyError } from '../domain/errors.js';
import type { SetupDraftInputV2 } from '../domain/setup-v2.js';
import type { SetupApplyResult } from '../application/setup-service.js';
export interface SetupBatchRow {
  id: string;
  tenant_id: string;
  property_id: string;
  mode: 'DRAFT' | 'ADDITION';
  draft_id: string | null;
  draft_revision: number | null;
  input: SetupDraftInputV2;
  chunks: SetupDraftInputV2[];
  results: SetupApplyResult[];
  next_index: number;
  completed: boolean;
}
export const findSetupBatch = (
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  id?: string,
) =>
  one<SetupBatchRow>(
    em,
    `select * from property_setup_batch where tenant_id=? and property_id=? and ${id ? 'id=?' : 'not completed'} order by created_at desc limit 1`,
    id ? [tenantId, propertyId, id] : [tenantId, propertyId],
  );
export async function assertNoSetupBatch(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
) {
  if (await findSetupBatch(em, tenantId, propertyId))
    throw new PropertyError('CONFLICT', { reason: 'setup_batch_in_progress' });
}
