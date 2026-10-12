import { Queue, Worker } from 'bullmq';
import type { LogEvent, SafeLogFields } from '../../../../logging.js';
import type { DistributionRuntime } from '../../application/runtime.js';

export interface SchedulerOptions {
  runtime: DistributionRuntime;
  redisUrl: string | null;
  intervalMs: number;
  queueName?: string;
  logger?: (event: LogEvent, fields?: Omit<SafeLogFields, 'service'>) => void;
}

export interface SchedulerHandle {
  mode: 'bullmq' | 'interval';
  stop(): Promise<void>;
}

function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    db: Number(url.pathname.replace('/', '') || 0),
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
}

export async function startDistributionScheduler(
  options: SchedulerOptions,
): Promise<SchedulerHandle> {
  const queueName = options.queueName ?? 'distribution-runtime';
  const log = options.logger ?? (() => undefined);
  const runTick = async () => {
    try {
      await options.runtime.tick();
    } catch {
      log('distribution_tick_failed', { code: 'TICK_FAILED' });
    }
  };

  const interval = setInterval(() => {
    void runTick();
  }, options.intervalMs);
  interval.unref?.();

  let queue: Queue | undefined;
  let worker: Worker | undefined;
  if (options.redisUrl) {
    try {
      const connection = redisConnection(options.redisUrl);
      queue = new Queue(queueName, { connection });
      await Promise.race([
        queue.waitUntilReady(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('queue timeout')), 2000);
        }),
      ]);
      worker = new Worker(queueName, async () => runTick(), { connection });
      worker.on('error', () =>
        log('distribution_worker_error', { code: 'QUEUE_ERROR' }),
      );
      await queue.add(
        'tick',
        {},
        {
          repeat: { every: options.intervalMs },
          jobId: 'distribution-tick',
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      return {
        mode: 'bullmq',
        stop: async () => {
          clearInterval(interval);
          await worker?.close();
          await queue?.close();
        },
      };
    } catch {
      log('distribution_queue_fallback', { code: 'QUEUE_UNAVAILABLE' });
      await queue?.close().catch(() => undefined);
      queue = undefined;
    }
  }
  return {
    mode: 'interval',
    stop: async () => {
      clearInterval(interval);
    },
  };
}
