import { randomUUID } from 'node:crypto';
import pino from 'pino';

export function correlationId(value: unknown): string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value.toLowerCase()
    : randomUUID();
}
const logger = pino({
  base: undefined,
  redact: [
    'password',
    'authorization',
    'cookie',
    'token',
    'DATABASE_URL',
    'REDIS_URL',
  ],
});
export type LogEvent =
  | 'started'
  | 'stopped'
  | 'startup_failed'
  | 'request'
  | 'unhandled_error'
  | 'dependency_failed'
  | 'distribution_runtime_started'
  | 'distribution_tick'
  | 'distribution_tick_failed'
  | 'distribution_queue_fallback'
  | 'distribution_worker_error'
  | 'night_audit_worker_started'
  | 'night_audit_run_tick'
  | 'night_audit_tick_failed'
  | 'night_audit_property_missing'
  | 'report_export_worker_started'
  | 'report_export_ready'
  | 'report_export_failed'
  | 'report_export_tick_failed';
export interface SafeLogFields {
  service: 'api' | 'worker';
  correlation_id?: string;
  status?: number;
  mode?: 'bullmq' | 'interval';
  code?: string;
  error_name?: string;
  error_code?: string;
  acknowledged?: number;
  retried?: number;
  dead_lettered?: number;
  ack_sent?: number;
  run_id?: string;
  state?: string;
  current_step?: string;
  steps_done?: number;
  blocked?: boolean;
  failed?: boolean;
  export_kind?: string;
  row_count?: number;
  message?: string;
}

export function logEvent(event: LogEvent, data: SafeLogFields) {
  // Whitelist fields instead of serializing requests, errors or environment values.
  logger.info({
    event,
    service: data.service,
    correlation_id: data.correlation_id
      ? correlationId(data.correlation_id)
      : undefined,
    status: data.status,
    mode: data.mode,
    code: data.code,
    error_name: data.error_name,
    error_code: data.error_code,
    acknowledged: data.acknowledged,
    retried: data.retried,
    dead_lettered: data.dead_lettered,
    ack_sent: data.ack_sent,
    run_id: data.run_id,
    state: data.state,
    current_step: data.current_step,
    steps_done: data.steps_done,
    blocked: data.blocked,
    failed: data.failed,
    message: data.message,
  });
}
