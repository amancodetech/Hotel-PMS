import { IdentityError } from '@hotel/backend';
import type { PlatformRoleCode, PlatformServiceContext } from '@hotel/backend';
import { isPlatformRoleCode } from '@hotel/backend';
import { requestCorrelation } from '../identity/http.js';
import type { AuthedRequest } from '../identity/guards.js';

export function platformContext(
  request: AuthedRequest,
): PlatformServiceContext {
  const auth = request.platformAuth;
  if (!auth || !isPlatformRoleCode(auth.staff.role_code))
    throw new IdentityError('PERMISSION_DENIED', { reason: 'platform_role' });
  return {
    actor: {
      userId: auth.actor.userId,
      displayName: auth.actor.displayName,
      mfa: auth.actor.mfa,
      roleCode: auth.staff.role_code as PlatformRoleCode,
    },
    correlationId: requestCorrelation(request),
  };
}
