import {
  createDependencies,
  loadConfig,
  logEvent,
  startTelemetry,
} from '@hotel/backend';
import { createApp } from './app.js';
import { createIdentityRuntime } from './identity/runtime.js';

const telemetry = startTelemetry();
try {
  const config = loadConfig();
  const dependencies = await createDependencies(config, 'api');
  const app = await createApp(
    dependencies.probes,
    createIdentityRuntime(config, dependencies.orm),
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await dependencies.close();
    await telemetry.shutdown();
    logEvent('stopped', { service: 'api' });
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  await app.listen(config.API_PORT, config.API_HOST);
  logEvent('started', { service: 'api' });
} catch {
  logEvent('startup_failed', { service: 'api' });
  await telemetry.shutdown();
  process.exitCode = 1;
}
