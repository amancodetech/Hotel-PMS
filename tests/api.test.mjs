import { beforeAll, afterAll, test, expect } from '@jest/globals';
import { createApp } from '../apps/api/dist/app.js';
import { createWorkerServer } from '../apps/worker/dist/server.js';

let failed = false;
const probe = async () => {
  if (failed) throw new Error('synthetic-password-do-not-expose');
};
let api, worker, base, workerBase;
beforeAll(async () => {
  api = await createApp({ database: probe, redis: probe, identity: probe });
  await api.listen(0, '127.0.0.1');
  base = await api.getUrl();
  worker = createWorkerServer({
    database: probe,
    redis: probe,
    identity: probe,
  });
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  workerBase = `http://127.0.0.1:${worker.address().port}`;
});
afterAll(async () => {
  await api?.close();
  if (worker) await new Promise((resolve) => worker.close(resolve));
});

test('API health, readiness and transport headers', async () => {
  const response = await fetch(`${base}/api/v1/system/health`);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-powered-by')).toBeNull();
  expect(
    (await (await fetch(`${base}/api/v1/system/ready`)).json()).status,
  ).toBe('ready');
});
test('unimplemented routes are errors, not fake successes', async () => {
  const response = await fetch(
    `${base}/api/v1/tenants/test/properties/test/rates/batch`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );
  expect(response.status).toBe(404);
  expect((await response.json()).code).toBe('NOT_FOUND');
});
test('unknown query input rejects without reflecting secret input', async () => {
  const response = await fetch(
    `${base}/api/v1/system/health?password=synthetic-secret`,
  );
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).not.toContain('synthetic-secret');
  expect(body).toContain('INVALID_REQUEST');
});
test('malformed JSON is sanitized', async () => {
  const response = await fetch(`${base}/api/v1/system/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"password":"synthetic-secret"',
  });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('synthetic-secret');
});
test('body limit, methods and CORS fail closed', async () => {
  const oversized = await fetch(`${base}/api/v1/system/health`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://untrusted.example',
    },
    body: JSON.stringify({ value: 'x'.repeat(17 * 1024) }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.text()).not.toContain('x'.repeat(100));
  expect(oversized.headers.get('access-control-allow-origin')).toBeNull();
  const options = await fetch(`${base}/api/v1/system/health`, {
    method: 'OPTIONS',
    headers: { origin: 'https://untrusted.example' },
  });
  expect(options.status).toBe(404);
  expect(options.headers.get('access-control-allow-origin')).toBeNull();
});
test('both processes fail readiness while liveness remains up, then recover', async () => {
  failed = true;
  try {
    for (const [origin, ready, health] of [
      [base, '/api/v1/system/ready', '/api/v1/system/health'],
      [workerBase, '/ready', '/health'],
    ]) {
      const response = await fetch(origin + ready);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      const text = await response.text();
      expect(text).not.toContain('synthetic-password');
      expect(JSON.parse(text).details.checks.database).toBe('down');
      expect((await fetch(origin + health)).status).toBe(200);
    }
  } finally {
    failed = false;
  }
  expect((await fetch(workerBase + '/ready')).status).toBe(200);
});
