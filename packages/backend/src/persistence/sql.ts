import type { EntityManager } from '@mikro-orm/postgresql';

export async function rows<T>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await em.execute(sql, params as never[]);
  return result as unknown as T[];
}

export async function one<T>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await rows<T>(em, sql, params);
  return result[0] ?? null;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
