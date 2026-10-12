import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import type { LogEvent, SafeLogFields } from '../../../logging.js';
import { findPropertyScope } from '../../reservations/persistence/reservation-repository.js';
import * as repo from '../persistence/night-audit-repository.js';
import { executeNightAuditRun } from './night-audit-service.js';
import type { EngineOptions } from './night-audit-service.js';

export interface NightAuditWorkerOptions {
  orm: MikroORM;
  owner: string;
  leaseMs: number;
  /** Delay between steps, used only for local kill/resume verification. */
  stepDelayMs: number;
  logger?: (event: LogEvent, fields: SafeLogFields) => void;
}

export interface NightAuditTickResult {
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
  leaseLost: number;
  remaining: number;
}

/**
 * Claims any resumable night audit run and executes one step at a time, each
 * step in its own committed transaction (checkpoint). A killed worker leaves
 * the run RUNNING with a stale lease; the next tick (or process) claims it and
 * resumes from the first non-DONE step, so no charge or close is repeated.
 */
export async function processNightAuditWork(
  options: NightAuditWorkerOptions,
): Promise<NightAuditTickResult> {
  const discovery = options.orm.em.fork();
  const tenants = await repo.workTenants(discovery);
  const result: NightAuditTickResult = {
    claimed: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    leaseLost: 0,
    remaining: 0,
  };
  for (const tenantId of tenants) {
    const candidates = await runScopedTransaction(
      options.orm,
      { tenantId },
      (em) => repo.listWorkCandidates(em, tenantId, 5),
    );
    for (const candidate of candidates) {
      const claimed = await runScopedTransaction(
        options.orm,
        { tenantId },
        (em) =>
          repo.claimRun(em, {
            tenantId,
            propertyId: candidate.property_id,
            runId: candidate.id,
            leaseOwner: options.owner,
            leaseMs: options.leaseMs,
          }),
      );
      if (!claimed) continue;
      result.claimed += 1;
      const property = await runScopedTransaction(
        options.orm,
        { tenantId },
        (em) => findPropertyScope(em, tenantId, claimed.property_id),
      );
      if (!property) {
        options.logger?.('night_audit_property_missing', {
          service: 'worker',
          run_id: claimed.id,
        });
        result.failed += 1;
        continue;
      }
      const engine: EngineOptions = {
        tenantId,
        propertyId: claimed.property_id,
        timezone: property.timezone,
        actor: {
          actorType: 'SERVICE',
          actorId: null,
          actorLabel: 'night-audit-worker',
        },
        correlationId: claimed.correlation_id ?? claimed.id,
        leaseOwner: options.owner,
        leaseMs: options.leaseMs,
        lockProperty: true,
        stepDelayMs: options.stepDelayMs,
      };
      const outcome = await executeNightAuditRun(
        options.orm,
        claimed.id,
        engine,
      );
      if (outcome.leaseLost) result.leaseLost += 1;
      else if (outcome.blocked) result.blocked += 1;
      else if (outcome.failed) result.failed += 1;
      else if (outcome.run.state === 'SUCCEEDED') result.completed += 1;
      else result.remaining += 1;
      options.logger?.('night_audit_run_tick', {
        service: 'worker',
        run_id: claimed.id,
        state: outcome.run.state,
        current_step: outcome.run.current_step ?? undefined,
        steps_done: outcome.run.steps_done,
        blocked: outcome.blocked,
        failed: outcome.failed,
      });
    }
  }
  return result;
}

export function startNightAuditScheduler(options: {
  orm: MikroORM;
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  stepDelayMs: number;
  logger?: (event: LogEvent, fields: SafeLogFields) => void;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await processNightAuditWork({
        orm: options.orm,
        owner: options.owner,
        leaseMs: options.leaseMs,
        stepDelayMs: options.stepDelayMs,
        logger: options.logger,
      });
    } catch (error) {
      options.logger?.('night_audit_tick_failed', {
        service: 'worker',
        message:
          error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(
    () => void tick(),
    Math.max(250, options.pollIntervalMs),
  );
  timer.unref?.();
  void tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
