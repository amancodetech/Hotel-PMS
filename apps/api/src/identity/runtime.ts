import type { AppConfig, createDependencies } from '@hotel/backend';
import { apiOrigin, redirectUri, webOrigin } from '@hotel/backend';
import { AuthService, OidcService } from '@hotel/backend';

type Orm = Awaited<ReturnType<typeof createDependencies>>['orm'];

export const SESSION_COOKIE = 'hotel_session';
export const CSRF_COOKIE = 'hotel_csrf';
export const AUTH_FLOW_COOKIE = 'hotel_auth_flow';
export const CSRF_HEADER = 'x-csrf-token';
export const APPROVAL_HEADER = 'x-approval-id';
export const PROPERTY_HEADER = 'x-property-ref';

export interface IdentityRuntime {
  config: AppConfig;
  orm: Orm;
  oidc: OidcService;
  auth: AuthService;
  secureCookies: boolean;
  webOrigin: string;
  apiOrigin: string;
}

export function createIdentityRuntime(
  config: AppConfig,
  orm: Orm,
): IdentityRuntime {
  const oidc = new OidcService({
    issuer: config.KEYCLOAK_ISSUER,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    redirectUri: redirectUri(config),
    postLogoutRedirectUri: `${webOrigin(config)}/login`,
  });
  return {
    config,
    orm,
    oidc,
    auth: new AuthService(orm, oidc, config.SESSION_TTL_MINUTES),
    secureCookies: false,
    webOrigin: webOrigin(config),
    apiOrigin: apiOrigin(config),
  };
}

export function sessionHasMfa(authMethods: string[]): boolean {
  const methods = new Set([
    'otp',
    'mfa',
    'hwk',
    'swk',
    'sms',
    'tel',
    'webauthn',
  ]);
  return authMethods.some((method) => methods.has(method.toLowerCase()));
}
