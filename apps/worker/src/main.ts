import {
  createDependencies,
  distribution,
  loadConfig,
  logEvent,
  startNightAuditScheduler,
  startReportExportScheduler,
  startTelemetry,
} from '@hotel/backend';
import { createWorkerServer } from './server.js';

const telemetry = startTelemetry();
try {
  const config = loadConfig();
  if (config.CHANNEX_STAGING_WORKER === 'on')
    distribution.stagingWorkerScope(config);
  const dependencies = await createDependencies(config, 'worker');
  let scheduler:
    | Awaited<ReturnType<typeof distribution.startDistributionScheduler>>
    | { stop: () => Promise<void> }
    | null = null;
  let nightAudit: { stop: () => Promise<void> } | null = null;
  let reportExports: { stop: () => Promise<void> } | null = null;
  if (config.CHANNEX_STAGING_WORKER === 'on') {
    const runtime = await distribution.createStagingWorkerRuntime(
      dependencies.orm,
      config,
      process.env,
    );
    scheduler = distribution.startFiniteStagingTicks({
      maxTicks: config.CHANNEX_STAGING_MAX_TICKS,
      tick: async () => {
        const summary = await distribution.runStagingTick(runtime);
        if (
          summary.dispatch.retried ||
          summary.dispatch.deadLettered ||
          summary.dispatch.notSent ||
          summary.dispatch.lost ||
          summary.dispatch.partial ||
          summary.ack.retryable ||
          summary.ack.rejected ||
          summary.ack.exhausted ||
          summary.ack.lost
        )
          throw new distribution.StagingTickFailure('DISPATCH_ACK', 'UNKNOWN');
        logEvent('distribution_tick', {
          service: 'worker',
          acknowledged: summary.dispatch.acknowledged,
          ack_sent: summary.ack.sent,
        });
      },
      onFailure: (error) => {
        const failure = distribution.safeStagingFailure(error);
        logEvent('distribution_tick_failed', {
          service: 'worker',
          code: 'STAGING_STOPPED',
          current_step: failure.phase,
          error_code: failure.code,
        });
      },
    });
    logEvent('distribution_runtime_started', {
      service: 'worker',
      code: 'STAGING_FINITE',
    });
  } else if (config.DISTRIBUTION_WORKER === 'on') {
    const registry = new distribution.ProviderRegistry([
      new distribution.SimulatorAdapter({
        engine: new distribution.SimulatorEngine({ seed: 'local-runtime' }),
        allowedChannelKeys: [
          ...distribution.realChannelKeys(),
          distribution.syntheticSixthChannelKey,
        ],
      }),
    ]);
    const runtime = new distribution.DistributionRuntime({
      orm: dependencies.orm,
      registry,
      profileFor: (context) =>
        distribution.findChannelProfile(context.channel_key) ??
        distribution.simulatorTestProfile(
          context.channel_key,
          context.environment,
        ),
      owner: `worker-${process.pid}`,
      logger: (event, fields) =>
        logEvent(event, { service: 'worker', ...fields }),
    });
    const defaultScheduler = await distribution.startDistributionScheduler({
      runtime,
      redisUrl: config.REDIS_URL,
      intervalMs: 5000,
      logger: (event, fields) =>
        logEvent(event, { service: 'worker', ...fields }),
    });
    scheduler = defaultScheduler;
    logEvent('distribution_runtime_started', {
      service: 'worker',
      mode: defaultScheduler.mode,
    });
  }
  if (config.NIGHT_AUDIT_WORKER === 'on') {
    nightAudit = startNightAuditScheduler({
      orm: dependencies.orm,
      owner: `worker-${process.pid}`,
      leaseMs: config.NIGHT_AUDIT_LEASE_MS,
      pollIntervalMs: config.NIGHT_AUDIT_POLL_MS,
      stepDelayMs: config.NIGHT_AUDIT_STEP_DELAY_MS,
      logger: (event, fields) =>
        logEvent(event, { ...fields, service: 'worker' }),
    });
    logEvent('night_audit_worker_started', { service: 'worker' });
  }
  if (config.REPORT_EXPORT_WORKER === 'on') {
    reportExports = startReportExportScheduler({
      orm: dependencies.orm,
      owner: `worker-${process.pid}`,
      leaseMs: config.REPORT_EXPORT_LEASE_MS,
      pollIntervalMs: config.REPORT_EXPORT_POLL_MS,
      logger: (event, fields) =>
        logEvent(event, { ...fields, service: 'worker' }),
    });
    logEvent('report_export_worker_started', { service: 'worker' });
  }
  const server = createWorkerServer(dependencies.probes);
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void Promise.resolve(scheduler?.stop())
        .catch(() => undefined)
        .then(() => nightAudit?.stop())
        .catch(() => undefined)
        .then(() => reportExports?.stop())
        .catch(() => undefined)
        .then(() => dependencies.close())
        .then(() => telemetry.shutdown())
        .then(() => logEvent('stopped', { service: 'worker' }));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('error', () => {
    logEvent('startup_failed', { service: 'worker' });
    shutdown();
    process.exitCode = 1;
  });
  server.listen(config.WORKER_PORT, config.API_HOST, () =>
    logEvent('started', { service: 'worker' }),
  );
} catch {
  logEvent('startup_failed', { service: 'worker' });
  await telemetry.shutdown();
  process.exitCode = 1;
}
