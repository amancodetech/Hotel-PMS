import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Inventory transactions intentionally use the PERF-01 lock budget instead of
 * the short default statement timeout: writers serialize on the property lock
 * row and the design allows up to 2s of lock wait plus bounded search work.
 */
export async function applyInventoryTimeouts(em: EntityManager): Promise<void> {
  await em.execute(`set local statement_timeout = '3000'`);
  await em.execute(`set local lock_timeout = '2000'`);
}
