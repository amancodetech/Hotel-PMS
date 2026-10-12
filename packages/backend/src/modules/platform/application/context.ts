import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runPlatformTransaction } from '../../../persistence/platform-context.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { PlatformPermissionCode } from '../../identity/domain/permissions.js';
import { findPlatformStaffByUser } from '../persistence/platform-repository.js';
import type { PlatformStaffRow } from '../persistence/types.js';
import {
  platformRoleHasPermission,
  type PlatformRoleCode,
} from '../domain/platform-roles.js';

export interface PlatformActor {
  userId: string;
  displayName: string | null;
  mfa: boolean;
  roleCode: PlatformRoleCode;
}

export interface PlatformServiceContext {
  actor: PlatformActor;
  correlationId: string | null;
}

export async function loadPlatformStaff(
  orm: MikroORM,
  userId: string,
): Promise<PlatformStaffRow | null> {
  return runPlatformTransaction(orm, { platformUserId: userId }, (em) =>
    findPlatformStaffByUser(em, userId),
  );
}

export function authorizePlatform(
  actor: PlatformActor,
  permission: PlatformPermissionCode,
): void {
  if (!platformRoleHasPermission(actor.roleCode, permission))
    throw new IdentityError('PERMISSION_DENIED', { reason: 'platform_role' });
}

export async function requireActivePlatformStaff(
  em: EntityManager,
  actorUserId: string,
): Promise<PlatformStaffRow> {
  const staff = await findPlatformStaffByUser(em, actorUserId);
  if (!staff || staff.status !== 'ACTIVE')
    throw new IdentityError('PLATFORM_STAFF_NOT_FOUND');
  return staff;
}
