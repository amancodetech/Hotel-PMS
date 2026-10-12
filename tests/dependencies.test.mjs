import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { createServer } from 'node:net';
import {
  createDependencies,
  loadConfig,
} from '../packages/backend/dist/index.js';

const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
let dependencies;
beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `postgresql://test:synthetic-secret@127.0.0.1:${port}/test`;
  const config = loadConfig({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '5173',
    DATABASE_URL: url,
    API_DATABASE_URL: url,
    WORKER_DATABASE_URL: url,
    REDIS_URL: `redis://127.0.0.1:${port}`,
    KEYCLOAK_HEALTH_URL: `http://127.0.0.1:${port}/health/ready`,
    KEYCLOAK_ISSUER: `http://127.0.0.1:${port}/realms/hotel-local`,
    KEYCLOAK_CLIENT_ID: 'hotel-api',
    KEYCLOAK_CLIENT_SECRET: 'synthetic-client-secret',
  });
  dependencies = await createDependencies(config);
});
afterAll(async () => {
  await dependencies?.close();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});
test.each(['database', 'redis', 'identity'])(
  'a connected but silent %s dependency times out',
  async (name) => {
    const start = Date.now();
    await expect(dependencies.probes[name]()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5000);
  },
);
