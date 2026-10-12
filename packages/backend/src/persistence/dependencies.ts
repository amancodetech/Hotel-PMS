import { MikroORM } from '@mikro-orm/postgresql';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { Probes } from '../application/readiness.js';
import { ormOptions } from './orm-options.js';

export type RuntimeRole = 'api' | 'worker';

export async function createDependencies(
  config: AppConfig,
  role: RuntimeRole = 'api',
) {
  const clientUrl =
    role === 'worker' ? config.WORKER_DATABASE_URL : config.API_DATABASE_URL;
  const orm = await MikroORM.init(ormOptions(clientUrl));
  const probes: Probes = {
    database: async () => {
      await orm.em.getConnection().execute('select 1');
    },
    redis: async () => {
      const redis = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 1500,
        commandTimeout: 1500,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      redis.on('error', () => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound the entire handshake too, not only TCP connect and PING.
        await Promise.race([
          (async () => {
            await redis.connect();
            if ((await redis.ping()) !== 'PONG')
              throw new Error('Redis unavailable');
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Redis unavailable')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        redis.disconnect();
      }
    },
    identity: async () => {
      const response = await fetch(config.KEYCLOAK_HEALTH_URL, {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Identity unavailable');
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        !('status' in body) ||
        body.status !== 'UP'
      )
        throw new Error('Identity unavailable');
      const issuer = config.KEYCLOAK_ISSUER.replace(/\/$/, '');
      const discovery = await fetch(
        `${issuer}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(1500), redirect: 'error' },
      );
      if (!discovery.ok) {
        await discovery.body?.cancel();
        throw new Error('OIDC discovery unavailable');
      }
      const metadata: unknown = await discovery.json();
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('issuer' in metadata) ||
        metadata.issuer !== issuer
      )
        throw new Error('OIDC discovery unavailable');
    },
  };
  return { probes, orm, close: () => orm.close(true) };
}
