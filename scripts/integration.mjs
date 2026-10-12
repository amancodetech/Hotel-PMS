import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  createDependencies,
  loadConfig,
} from '../packages/backend/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { createIdentityRuntime } from '../apps/api/dist/identity/runtime.js';
import { createWorkerServer } from '../apps/worker/dist/server.js';

const config = loadConfig();
const dependencies = await createDependencies(config, 'api');
const api = await createApp(
  dependencies.probes,
  createIdentityRuntime(config, dependencies.orm),
);
const worker = createWorkerServer(dependencies.probes);
const composeBin = process.env.COMPOSE_BIN ?? 'docker';
const composePrefix = process.env.COMPOSE_BIN ? [] : ['compose'];
function compose(...args) {
  execFileSync(
    composeBin,
    [
      ...composePrefix,
      '--env-file',
      '.env',
      '-f',
      'infra/compose.yaml',
      ...args,
    ],
    { stdio: 'ignore', timeout: 180000 },
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await api.listen(0, '127.0.0.1');
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const endpoints = [
    `${await api.getUrl()}/api/v1/system/ready`,
    `http://127.0.0.1:${worker.address().port}/ready`,
  ];
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ready');
  }
  console.log(
    'PASS: API and Worker readiness against real PostgreSQL, Redis and Keycloak.',
  );
  if (process.argv.includes('--faults')) {
    for (const [service, name] of [
      ['postgres', 'database'],
      ['redis', 'redis'],
      ['keycloak', 'identity'],
    ]) {
      try {
        compose('stop', service);
        for (const endpoint of endpoints) {
          const start = Date.now();
          const response = await fetch(endpoint, {
            signal: AbortSignal.timeout(8000),
          });
          assert.equal(response.status, 503);
          const text = await response.text();
          assert.equal(JSON.parse(text).details.checks[name], 'down');
          for (const key of [
            'POSTGRES_PASSWORD',
            'REDIS_PASSWORD',
            'KEYCLOAK_ADMIN_PASSWORD',
          ])
            if (process.env[key]) assert(!text.includes(process.env[key]));
          assert(
            Date.now() - start < 7000,
            'Readiness must have a bounded response',
          );
        }
        console.log(
          `PASS: ${service} stopped -> both readiness endpoints return sanitized 503.`,
        );
      } finally {
        compose('up', '-d', '--wait', service);
      }
      await sleep(500);
      for (const endpoint of endpoints)
        assert.equal((await fetch(endpoint)).status, 200);
      console.log(
        `PASS: ${service} restored -> both readiness endpoints return 200.`,
      );
    }
  }
} finally {
  await api.close();
  if (worker.listening) await new Promise((resolve) => worker.close(resolve));
  await dependencies.close();
}
