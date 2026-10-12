import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Tenant discovery for the distribution worker. The security-definer helper
 * returns only tenant identifiers that currently have due work; it never
 * exposes row data. Falls back to an empty list when the helper is missing
 * (pre-P03 databases).
 */
export async function listDistributionWorkTenants(
  orm: MikroORM,
  maxAttempts = 4,
): Promise<string[]> {
  try {
    const result = await orm.em
      .fork()
      .execute(`select tenant_id from public.distribution_work_tenants(?)`, [
        maxAttempts,
      ]);
    return (result as Array<{ tenant_id: string }>).map((row) => row.tenant_id);
  } catch (error) {
    if ((error as { code?: string }).code === '42883') return [];
    throw error;
  }
}
