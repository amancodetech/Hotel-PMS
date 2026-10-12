import type { EntityManager } from '@mikro-orm/postgresql';
import {
  evaluatePolicy,
  policyError,
} from '../../identity/application/policy-service.js';
import type { PolicyActor } from '../../identity/application/policy-service.js';
import type { PermissionCode } from '../../identity/domain/permissions.js';

export interface ServiceContext {
  actor: PolicyActor;
  tenantId: string;
  correlationId: string | null;
}

export async function authorize(
  em: EntityManager,
  context: ServiceContext,
  permission: PermissionCode,
  propertyRef: string | null,
): Promise<void> {
  const decision = await evaluatePolicy(em, {
    actor: context.actor,
    tenantId: context.tenantId,
    permission,
    propertyRef,
  });
  if (!decision.allowed) throw policyError(decision);
}

export function auditActor(context: ServiceContext) {
  return {
    actorType: context.actor.kind,
    actorId: context.actor.userId,
    actorLabel: context.actor.displayName,
  };
}
