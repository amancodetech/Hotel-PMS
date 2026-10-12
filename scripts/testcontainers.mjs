import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { GenericContainer, Wait } from 'testcontainers';
import {
  createDependencies,
  loadConfig,
} from '../packages/backend/dist/index.js';

const requireBackend = createRequire(
  new URL('../packages/backend/package.json', import.meta.url),
);
const { Queue, Worker, QueueEvents } = requireBackend('bullmq');
const password = randomBytes(24).toString('hex');
let postgres, redis, dependencies, queue, worker, events;
try {
  postgres = await new GenericContainer('postgres:17.11-alpine')
    .withEnvironment({
      POSTGRES_USER: 'foundation',
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: 'foundation',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .withStartupTimeout(120000)
    .start();
  redis = await new GenericContainer('redis:7.4.11-alpine')
    .withCommand(['redis-server', '--requirepass', password])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: `postgresql://foundation:${password}@127.0.0.1:${postgres.getMappedPort(5432)}/foundation`,
    REDIS_URL: `redis://:${password}@127.0.0.1:${redis.getMappedPort(6379)}/0`,
  });
  dependencies = await createDependencies(config);
  await dependencies.probes.database();
  await dependencies.probes.redis();
  const connection = {
    host: '127.0.0.1',
    port: redis.getMappedPort(6379),
    password,
  };
  queue = new Queue('foundation-smoke', { connection });
  events = new QueueEvents('foundation-smoke', { connection });
  await events.waitUntilReady();
  worker = new Worker(
    'foundation-smoke',
    async (job) => ({ checked: job.name === 'ping' }),
    { connection },
  );
  const job = await queue.add(
    'ping',
    {},
    { removeOnComplete: true, removeOnFail: true },
  );
  assert.deepEqual(await job.waitUntilFinished(events, 10000), {
    checked: true,
  });
  console.log(
    'PASS: disposable PostgreSQL/Redis containers, MikroORM SELECT, and synthetic BullMQ roundtrip. No domain tables or business jobs.',
  );
} finally {
  await worker?.close();
  await events?.close();
  await queue?.close();
  await dependencies?.close();
  await redis?.stop();
  await postgres?.stop();
}
