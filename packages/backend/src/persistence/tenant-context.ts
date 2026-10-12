import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

export interface RequestContext {
  tenantId?: string | null;
  userId?: string | null;
  invitationHash?: string | null;
}

export async function setRequestContext(
  em: EntityManager,
  context: RequestContext,
): Promise<void> {
  await em.execute(`select set_config('app.tenant_id', ?, true)`, [
    context.tenantId ?? '',
  ]);
  await em.execute(`select set_config('app.user_id', ?, true)`, [
    context.userId ?? '',
  ]);
  await em.execute(`select set_config('app.invitation_hash', ?, true)`, [
    context.invitationHash ?? '',
  ]);
}

export async function currentTenantId(
  em: EntityManager,
): Promise<string | null> {
  const rows = (await em.execute(
    `select nullif(current_setting('app.tenant_id', true), '') as tenant_id`,
    [],
  )) as Array<{ tenant_id: string | null }>;
  return rows[0]?.tenant_id ?? null;
}

export async function currentUserId(em: EntityManager): Promise<string | null> {
  const rows = (await em.execute(
    `select nullif(current_setting('app.user_id', true), '') as user_id`,
    [],
  )) as Array<{ user_id: string | null }>;
  return rows[0]?.user_id ?? null;
}

export async function runScopedTransaction<T>(
  orm: MikroORM,
  context: RequestContext,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return orm.em.fork().transactional(async (em) => {
    await setRequestContext(em, context);
    return work(em);
  });
}
