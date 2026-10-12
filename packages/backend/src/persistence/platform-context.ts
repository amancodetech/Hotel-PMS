import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

export interface PlatformRequestContext {
  platformUserId: string;
}

/**
 * Sets the transaction-local platform actor for RLS. Platform tables grant
 * access through `public.is_active_platform_staff(app.platform_user_id)`, so an
 * empty setting (tenant request) can never read or write platform rows.
 */
export async function setPlatformContext(
  em: EntityManager,
  context: PlatformRequestContext,
): Promise<void> {
  await em.execute(`select set_config('app.platform_user_id', ?, true)`, [
    context.platformUserId ?? '',
  ]);
}

export async function runPlatformTransaction<T>(
  orm: MikroORM,
  context: PlatformRequestContext,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return orm.em.fork().transactional(async (em) => {
    await setPlatformContext(em, context);
    return work(em);
  });
}

export async function currentPlatformUserId(
  em: EntityManager,
): Promise<string | null> {
  const result = (await em.execute(
    `select nullif(current_setting('app.platform_user_id', true), '') as "id"`,
  )) as Array<{ id: string | null }>;
  return result[0]?.id ?? null;
}
