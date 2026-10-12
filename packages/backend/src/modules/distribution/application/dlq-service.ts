import type { MikroORM } from '@mikro-orm/postgresql';
import { ValidationError } from '../domain/errors.js';
import {
  findDeadLetter,
  listDeadLetters,
  markDeadLetterReprocessed,
} from '../persistence/dead-letter-repository.js';
import { updateOutboxResult } from '../persistence/outbox-repository.js';
import type { DeadLetterRow, OutboxRow } from '../persistence/types.js';

export interface ReprocessDeadLetterOptions {
  orm: MikroORM;
  deadLetterId: string;
  by: string;
  reason: string;
  now?: () => string;
}

export async function deadLetters(orm: MikroORM): Promise<DeadLetterRow[]> {
  return listDeadLetters(orm.em.fork());
}

export async function reprocessDeadLetter(
  options: ReprocessDeadLetterOptions,
): Promise<OutboxRow> {
  if (!options.by.trim() || !options.reason.trim())
    throw new ValidationError('Reprocess requires an actor and a reason');
  const now = options.now ?? (() => new Date().toISOString());
  return options.orm.em.fork().transactional(async (em) => {
    const dead = await findDeadLetter(em, options.deadLetterId);
    if (!dead) throw new ValidationError('Dead letter was not found');
    if (dead.outbox_id === null)
      throw new ValidationError('Dead letter has no outbox event to reprocess');
    await markDeadLetterReprocessed(em, dead.id, {
      by: options.by,
      reason: options.reason,
    });
    const updated = await updateOutboxResult(
      em,
      dead.outbox_id,
      {
        status: 'RETRY_SCHEDULED',
        nextAttemptAt: now(),
        clearLease: true,
      },
      { requireStatus: 'DEAD_LETTER' },
    );
    if (!updated)
      throw new ValidationError('Outbox event is no longer a dead letter');
    return updated;
  });
}
