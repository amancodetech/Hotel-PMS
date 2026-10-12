import { createServer } from 'node:http';
import { correlationId, inspectReadiness, logEvent } from '@hotel/backend';
import type { Probes } from '@hotel/backend';

export function createWorkerServer(probes: Probes) {
  return createServer(async (request, response) => {
    const id = correlationId(request.headers['x-correlation-id']);
    response.setHeader('x-correlation-id', id);
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
      logEvent('request', { service: 'worker', correlation_id: id, status });
    };
    const error = (code: string, details = {}) => ({
      code,
      message: `errors.${code}`,
      correlation_id: id,
      details,
    });
    try {
      if (request.method !== 'GET') return send(404, error('NOT_FOUND'));
      if (request.url === '/health')
        return send(200, { status: 'alive', service: 'worker' });
      if (request.url !== '/ready') return send(404, error('NOT_FOUND'));
      const report = await inspectReadiness(probes);
      if (report.status !== 'ready') response.setHeader('Retry-After', '1');
      send(
        report.status === 'ready' ? 200 : 503,
        report.status === 'ready'
          ? report
          : error('DEPENDENCY_UNAVAILABLE', report),
      );
    } catch {
      send(500, error('INTERNAL_ERROR'));
    }
  });
}
