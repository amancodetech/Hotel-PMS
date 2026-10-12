import type { MikroORM } from '@mikro-orm/postgresql';
import { upsertUserBySubject } from '../../identity/persistence/session-repository.js';
import { upsertPlatformStaff } from '../persistence/platform-repository.js';
import type { PlatformRoleCode } from '../domain/platform-roles.js';

/**
 * Deployment-time platform staff provisioning. There is deliberately no API
 * that grants platform roles: staff rows are seeded by an operator/migration
 * path outside tenant membership, and every subsequent platform action is
 * re-checked against this table under FORCE RLS.
 */
export async function provisionPlatformStaff(
  orm: MikroORM,
  input: {
    identitySubject: string;
    issuer: string;
    email: string;
    displayName: string | null;
    roleCode: PlatformRoleCode;
  },
): Promise<{ userId: string; staffId: string }> {
  return orm.em.fork().transactional(async (em) => {
    const user = await upsertUserBySubject(em, {
      identitySubject: input.identitySubject,
      issuer: input.issuer,
      email: input.email,
      displayName: input.displayName,
    });
    const staff = await upsertPlatformStaff(em, {
      userId: user.id,
      roleCode: input.roleCode,
    });
    return { userId: user.id, staffId: staff.id };
  });
}
